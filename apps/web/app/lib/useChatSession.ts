import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { UIMessage } from "ai";
import { useLiveSession } from "./useLiveSession";
import { API_BASE } from "./api";
import {
  ALLOWED_UPLOAD_MIMES,
  UPLOAD_LIMITS,
  type OpenAcmeUIMessage,
} from "./types";

export interface PendingAttachment {
  localId: string;
  status: "uploading" | "ready" | "error";
  pendingId?: string;
  url?: string;
  kind?: "image" | "file";
  mediaType: string;
  size: number;
  filename: string;
  previewUrl?: string;
  error?: string;
}

interface QueuedMessage {
  id: string;
  parts: OpenAcmeUIMessage["parts"];
}

type StatusEntry = {
  kind: "info" | "warn" | "error" | "compressing" | "compressed";
  message: string;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}

/**
 * The shared chat engine — messages, send, attachments, queued mid-turn sends,
 * status board, and the live SSE subscription. Used by the main chat
 * (routes/index.tsx) and the ambient Acme panel so both behave identically.
 *
 * The CONTAINER owns sessionId/agentId (URL-synced in the route; local in the
 * panel) and passes them in; `send` mints a fresh sessionId via `setSessionId`
 * when none is active. `buildExtraParts` lets the panel attach a data-ui-context
 * part to each user message. History-load, title, and scroll stay in the
 * container (they differ) — this hook owns the send/session machinery.
 */
export function useChatSession(opts: {
  agentId: string;
  sessionId: string;
  setSessionId: (id: string) => void;
  acceptsAttachments: boolean;
  /** Extra parts appended to every user message (e.g. the panel's ui-context). */
  buildExtraParts?: () => OpenAcmeUIMessage["parts"];
}) {
  const { agentId, sessionId, setSessionId, acceptsAttachments, buildExtraParts } =
    opts;

  const [messages, setMessages] = useState<OpenAcmeUIMessage[]>([]);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [isDragging, setIsDragging] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [statusBoard, setStatusBoard] = useState<Record<string, StatusEntry>>(
    {}
  );

  // Refs for synchronous reads inside send (state is stale within the call).
  const sessionIdRef = useRef(sessionId);
  const agentIdRef = useRef(agentId);
  const freshSessionIdRef = useRef<string | null>(null);
  const atBottomRef = useRef(true);
  const justSentRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);

  const buildExtraRef = useRef(buildExtraParts);
  buildExtraRef.current = buildExtraParts;

  const liveSession = useLiveSession(
    sessionId || null,
    sessionId ? setMessages : null,
    {
      onDataPart: (part) => {
        if (part.type === "data-status") {
          const data = part.data as {
            id: string;
            kind: StatusEntry["kind"];
            message: string;
          };
          setStatusBoard((prev) => {
            if (!data.message) {
              const next = { ...prev };
              delete next[data.id];
              return next;
            }
            const next = {
              ...prev,
              [data.id]: { kind: data.kind, message: data.message },
            };
            const keys = Object.keys(next);
            for (let i = 0; i < keys.length - 8; i++) delete next[keys[i]!];
            return next;
          });
        }
      },
      onInboxQueued: ({ messageId, parts }) => {
        setQueuedMessages((q) => {
          if (q.some((m) => m.id === messageId)) return q;
          return [
            ...q,
            { id: messageId, parts: parts as OpenAcmeUIMessage["parts"] },
          ];
        });
      },
      onInboxCancelled: ({ messageId }) => {
        setQueuedMessages((q) => q.filter((m) => m.id !== messageId));
      },
    }
  );
  const isLiveRunning = liveSession.state === "running";
  const isStreaming = submitting || isLiveRunning;

  // running → idle: refetch canonical history (DB carries sanitization + the
  // server-side recall part the chunk path doesn't).
  const prevLiveRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevLiveRunningRef.current;
    prevLiveRunningRef.current = isLiveRunning;
    if (!sessionId || !wasRunning || isLiveRunning) return;
    fetch(`${API_BASE}/api/sessions/${sessionId}/messages`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: OpenAcmeUIMessage[] | null) => {
        if (data) setMessages(data);
      })
      .catch(() => {});
  }, [isLiveRunning, sessionId]);

  const stop = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await fetch(`${API_BASE}/api/sessions/${sid}/active-turn`, {
        method: "DELETE",
      });
    } catch {
      /* best-effort */
    }
  }, []);

  const removePending = useCallback((localId: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  }, []);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const totalNow = pendingAttachments.reduce((acc, p) => acc + p.size, 0);
      let totalBytes = totalNow;
      const accepted: File[] = [];
      for (const f of files) {
        if (
          pendingAttachments.length + accepted.length >=
          UPLOAD_LIMITS.perRequestFiles
        ) {
          toast.error(`Max ${UPLOAD_LIMITS.perRequestFiles} attachments per turn`);
          break;
        }
        if (f.size > UPLOAD_LIMITS.perFileBytes) {
          toast.error(`${f.name}: too large (max 5 MB)`);
          continue;
        }
        totalBytes += f.size;
        if (totalBytes > UPLOAD_LIMITS.perRequestBytes) {
          toast.error("Upload would exceed 25 MB total");
          break;
        }
        if (
          !ALLOWED_UPLOAD_MIMES.includes(
            f.type as (typeof ALLOWED_UPLOAD_MIMES)[number]
          )
        ) {
          toast.error(`${f.name}: unsupported type (${f.type || "unknown"})`);
          continue;
        }
        accepted.push(f);
      }
      if (accepted.length === 0) return;

      const records: PendingAttachment[] = accepted.map((f) => ({
        localId: crypto.randomUUID(),
        status: "uploading",
        mediaType: f.type,
        size: f.size,
        filename: f.name,
        previewUrl: f.type.startsWith("image/")
          ? URL.createObjectURL(f)
          : undefined,
      }));
      setPendingAttachments((prev) => [...prev, ...records]);

      const form = new FormData();
      for (let i = 0; i < accepted.length; i++) {
        form.append(`f${i}`, accepted[i]!, accepted[i]!.name);
      }
      try {
        const res = await fetch(`${API_BASE}/api/uploads`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || res.statusText);
        }
        const data = (await res.json()) as {
          attachments: Array<{
            pendingId: string;
            kind: "image" | "file";
            mediaType: string;
            size: number;
            filename: string;
            url: string;
          }>;
        };
        setPendingAttachments((prev) =>
          prev.map((p) => {
            const matchIdx = records.findIndex((r) => r.localId === p.localId);
            if (matchIdx === -1) return p;
            const srv = data.attachments[matchIdx];
            if (!srv) return { ...p, status: "error", error: "no server id" };
            return {
              ...p,
              status: "ready",
              pendingId: srv.pendingId,
              url: srv.url,
              kind: srv.kind,
              mediaType: srv.mediaType,
            };
          })
        );
      } catch (err) {
        setPendingAttachments((prev) =>
          prev.map((p) =>
            records.some((r) => r.localId === p.localId)
              ? {
                  ...p,
                  status: "error",
                  error: err instanceof Error ? err.message : String(err),
                }
              : p
          )
        );
        toast.error("Upload failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [pendingAttachments]
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      if (!acceptsAttachments) return;
      e.preventDefault();
      setIsDragging(true);
    },
    [acceptsAttachments]
  );
  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    setIsDragging(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      setIsDragging(false);
      if (!acceptsAttachments) {
        toast.error("Active model accepts text only");
        return;
      }
      void uploadFiles(Array.from(e.dataTransfer.files));
    },
    [uploadFiles, acceptsAttachments]
  );

  const send = useCallback(async () => {
    if (!input.trim() && pendingAttachments.length === 0) return;
    if (!agentIdRef.current) return;
    if (pendingAttachments.some((p) => p.status === "uploading")) {
      toast.error("Wait for uploads to finish");
      return;
    }
    const ready = pendingAttachments.filter((p) => p.status === "ready" && p.url);
    const text = input.trim();
    atBottomRef.current = true;
    justSentRef.current = true;
    setInput("");
    setError(null);
    for (const p of pendingAttachments) {
      if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    }
    setPendingAttachments([]);

    let sid = sessionIdRef.current;
    const isNewSession = !sid;
    if (!sid) {
      sid = crypto.randomUUID();
      freshSessionIdRef.current = sid;
      sessionIdRef.current = sid;
      setSessionId(sid);
    }

    const userMessageId = crypto.randomUUID();
    const extra = buildExtraRef.current ? buildExtraRef.current() : [];
    const userParts: UIMessage["parts"] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...ready.map((p) => ({
        type: "file" as const,
        url: p.url!,
        mediaType: p.mediaType,
        filename: p.filename,
      })),
      ...((extra ?? []) as UIMessage["parts"]),
    ];
    const optimisticUser: OpenAcmeUIMessage = {
      id: userMessageId,
      role: "user",
      parts: userParts as OpenAcmeUIMessage["parts"],
    };

    const willQueue = isStreaming;
    const historyForServer = [...messages, optimisticUser];
    if (willQueue) {
      setQueuedMessages((q) => [
        ...q,
        { id: userMessageId, parts: userParts as OpenAcmeUIMessage["parts"] },
      ]);
    } else {
      setMessages(historyForServer);
    }

    setSubmitting(true);
    try {
      if (isNewSession) await withTimeout(liveSession.whenConnected(), 2000);
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agentIdRef.current,
          sessionId: sid,
          messages: historyForServer,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || res.statusText);
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      toast.error("Send failed", { description: e.message });
      if (willQueue) {
        setQueuedMessages((q) => q.filter((m) => m.id !== userMessageId));
      }
    } finally {
      setSubmitting(false);
    }
  }, [input, isStreaming, pendingAttachments, messages, liveSession, setSessionId]);

  // Drop a queued chip once its canonical version lands in `messages`.
  useEffect(() => {
    if (queuedMessages.length === 0) return;
    const ids = new Set(messages.map((m) => m.id));
    setQueuedMessages((q) => q.filter((m) => !ids.has(m.id)));
  }, [messages, queuedMessages.length]);

  const cancelQueued = useCallback(async (messageId: string) => {
    setQueuedMessages((all) => all.filter((m) => m.id !== messageId));
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/sessions/${encodeURIComponent(sid)}/queued/${encodeURIComponent(messageId)}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          cancelled?: number;
        };
        if (body.cancelled === 0) {
          toast.message("Already processing", {
            description:
              "The agent had already started on this message — it will appear in the chat.",
          });
        }
      }
    } catch {
      /* network failure leaves the inbox row; next turn reconciles */
    }
  }, []);

  return {
    messages,
    setMessages,
    input,
    setInput,
    submitting,
    error,
    queuedMessages,
    cancelQueued,
    statusBoard,
    pendingAttachments,
    isDragging,
    isStreaming,
    isLiveRunning,
    liveSession,
    send,
    stop,
    uploadFiles,
    removePending,
    onDragOver,
    onDragLeave,
    onDrop,
    inputRef,
    fileInputRef,
    freshSessionIdRef,
    atBottomRef,
    justSentRef,
  };
}
