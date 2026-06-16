import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
} from "react";
import { ArrowDown, Paperclip } from "lucide-react";
import { toast } from "sonner";
import type { UIMessage } from "ai";
import type { OpenAcmeUIMessage } from "../lib/types";
import { Sidebar } from "../components/Sidebar";
import { HomeView } from "../components/HomeView";
import { useLiveSession } from "../lib/useLiveSession";
import { AttachmentChip } from "../components/AttachmentChip";
import { MessageBubble } from "../components/chat/MessageBubble";
import { ChatComposer } from "../components/chat/ChatComposer";
import {
  buildSkillRefParts,
  type SkillIndexEntry,
} from "../lib/skill-mentions";
import { API_BASE } from "../lib/api";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/app/components/ui/button";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { AgentRef } from "@/app/components/ui/agent-ref";
import { AgentAvatar } from "@/app/components/ui/agent-avatar";
import { ScribedRule } from "@/app/components/ui/scribed-rule";
import { JargonChip } from "@/app/components/ui/jargon-chip";
import { ChatSetupPanel } from "../components/ChatSetupPanel";
import {
  FilePreviewDialog,
  type FilePreviewTarget,
} from "../files/FilePreviewDialog";
import { useFileLinkResolver } from "../files/useFileLinkResolver";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import type { ProviderInfo } from "../lib/types";
import {
  ALLOWED_UPLOAD_MIMES,
  UPLOAD_LIMITS,
} from "../lib/types";
import { cn } from "@/app/lib/utils";

interface Agent {
  id: string;
  name: string;
  avatar?: string;
  role: string;
  model: { provider: string; model: string };
  persona: string;
  tools: string[];
  /** This agent's skill allowlist (empty = all). Floats these to the top of
   *  the composer's `/` picker. */
  skills?: string[];
}

interface ModelOption {
  provider: string;
  providerName: string;
  id: string;
  label: string;
  hint?: string;
}

interface PendingAttachment {
  /** Local id used to key chips before the upload finishes. */
  localId: string;
  status: "uploading" | "ready" | "error";
  /** Server-assigned pendingId — present only after upload succeeds. */
  pendingId?: string;
  /** Pending URL `/api/attachments/__pending__/<id>/<file>` — used as
   *  FileUIPart.url when sending. The server's chat handler rewrites it
   *  to the committed `<sessionId>/<attId>/<file>` form. */
  url?: string;
  kind?: "image" | "file";
  mediaType: string;
  size: number;
  filename: string;
  /** Local blob URL for instant image preview while upload is in flight. */
  previewUrl?: string;
  error?: string;
}


function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.then((v) => v), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

function statusLabel(submitting: boolean, running: boolean, hasAgent: boolean): string {
  if (submitting) return "Submitting";
  if (running) return "Running";
  return hasAgent ? "Ready" : "No agent";
}

export const Route = createFileRoute("/")({
  validateSearch: z.object({
    session: z.coerce.string().optional(),
    agent: z.coerce.string().optional(),
    // HomeView's per-agent bucket filter; orthogonal to session/agent.
    agentFilter: z.coerce.string().optional(),
  }),
  component: ChatPage,
});

function ChatPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const sessionFromUrl = search.session ?? "";
  const agentFromUrl = search.agent ?? "";

  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string>(agentFromUrl);
  const [activeSessionId, setActiveSessionId] = useState<string>(sessionFromUrl);
  // Session title for the chat header. Fetched on session change; the
  // server also updates this asynchronously after the first turn (via
  // `agent.fireTitle`), so we refresh on `messages.length` transitions
  // 0 → 1 too.
  const [activeSessionTitle, setActiveSessionTitle] = useState<string | null>(
    null
  );
  const [input, setInput] = useState("");
  const [skills, setSkills] = useState<SkillIndexEntry[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<{
    providers: ProviderInfo[];
    configured: Record<string, boolean>;
  }>({ providers: [], configured: {} });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const justSentRef = useRef(false);
  const activeAgentIdRef = useRef("");
  const activeSessionIdRef = useRef("");
  // Client-generated sessions don't exist server-side until the first
  // POST; the history + metadata fetches skip these to avoid 404s and
  // clobbering the optimistic user bubble with an empty array.
  const freshSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeAgentIdRef.current = activeAgentId;
  }, [activeAgentId]);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // Skill index for the composer's `/` picker (the same Level-0 index the
  // agent gets in its prompt). Fetched once; refs let `send` read it freshly.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/skills`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: SkillIndexEntry[]) =>
        setSkills(Array.isArray(list) ? list : [])
      )
      .catch(() => {});
    return () => ctrl.abort();
  }, []);
  const skillNames = useMemo(
    () => new Set(skills.map((s) => s.name)),
    [skills]
  );
  const skillNamesRef = useRef(skillNames);
  skillNamesRef.current = skillNames;

  // URL ↔ state sync — URL is the canonical store, state mirrors it.
  //
  // Rules:
  //  - `?session=<id>` is sufficient on its own. The agent is implied
  //    by the session (sessions are agent-scoped server-side) and we
  //    resolve it from `/api/sessions/:id` on load. Including `?agent`
  //    when a session is set is redundant and causes URL-vs-state
  //    drift bugs (you'd refresh and see the URL ratchet between
  //    `?session=X&agent=Y` and `?session=X` depending on which
  //    effect ran last).
  //  - `?agent=<id>` ALONE (no session) is the "start a fresh chat
  //    with agent X" state. Sidebar's new-chat button uses it.
  //  - `/` is the home view (no session, no agent context yet).
  //
  // Implementation: one effect, URL → state. State changes also push
  // the URL via `navigate` but ALWAYS strip `?agent` when a
  // session is set. No circular ping-pong: when state matches URL,
  // both sides quiesce.
  useEffect(() => {
    if (sessionFromUrl !== activeSessionId) {
      setActiveSessionId(sessionFromUrl);
    }
    if (!sessionFromUrl) {
      // No session in URL — agent state mirrors the URL exactly.
      // (Includes the empty case: navigating to `/` clears the agent
      // too. Without this, going home would leave `activeAgentId`
      // stale and the state→URL effect would immediately rewrite the
      // URL to `?agent=<previous>`, defeating the navigation.)
      if (agentFromUrl !== activeAgentId) {
        setActiveAgentId(agentFromUrl);
      }
    }
    // While a session IS in the URL, we intentionally don't clobber
    // `activeAgentId` — the session row's agent is adopted via the
    // `/api/sessions/:id` fetch below. The URL stays `?session=<id>`
    // only; the agent name in the chat header comes from server data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionFromUrl, agentFromUrl]);

  // Push state → URL ONLY when a local action mints a new session.
  // `send()` does this when the user hits enter with no active session
  // (`setActiveSessionId(crypto.randomUUID())`). All other URL changes
  // flow through `navigate` at the call site
  // (sidebar/HomeView/agents-page); the state then catches up via the
  // URL→state effect above.
  //
  // This breaks the previous bidirectional sync loop. With both effects
  // firing on every URL change, the state→URL effect would close over
  // stale state during the same render the URL→state was clearing it,
  // and rewrite the URL back. The fix: only push when the local state
  // diverges from the URL AND it's a new session id we just minted.
  useEffect(() => {
    if (activeSessionId && activeSessionId !== sessionFromUrl) {
      void navigate({ to: "/", search: { session: activeSessionId } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  const [messages, setMessages] = useState<OpenAcmeUIMessage[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Messages the user sent while a turn was already streaming. They
  // live here (as floating chips above the input) until the next turn
  // fires and the server-side autonomous drain persists each one to
  // chat history. We track by id so the SSE/refetch upsert can clear
  // them as their canonical version lands in `messages`.
  type QueuedMessage = {
    id: string;
    parts: OpenAcmeUIMessage["parts"];
  };
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);

  // `data-status` board: same id replaces; empty message clears.
  const [statusBoard, setStatusBoard] = useState<
    Record<
      string,
      {
        kind: "info" | "warn" | "error" | "compressing" | "compressed";
        message: string;
      }
    >
  >({});

  const liveSession = useLiveSession(
    activeSessionId || null,
    activeSessionId ? setMessages : null,
    {
      onDataPart: (part) => {
        if (part.type === "data-status") {
          const data = part.data as {
            id: string;
            kind: "info" | "warn" | "error" | "compressing" | "compressed";
            message: string;
          };
          setStatusBoard((prev) => {
            if (!data.message) {
              const next = { ...prev };
              delete next[data.id];
              return next;
            }
            const next = { ...prev, [data.id]: { kind: data.kind, message: data.message } };
            // Bound the board — same-id replaces, but a server that mints
            // fresh ids per status would otherwise grow this without limit.
            const keys = Object.keys(next);
            for (let i = 0; i < keys.length - 8; i++) delete next[keys[i]!];
            return next;
          });
        }
      },
      // Tab-to-tab queue sync: another tab queued a message, render
      // the chip here too. Dedup by id so the originating tab's own
      // optimistic add isn't duplicated when its own broadcast comes
      // back.
      onInboxQueued: ({ messageId, parts }) => {
        setQueuedMessages((q) => {
          if (q.some((m) => m.id === messageId)) return q;
          return [...q, { id: messageId, parts: parts as OpenAcmeUIMessage["parts"] }];
        });
      },
      // Another tab cancelled a queued message — drop the chip.
      onInboxCancelled: ({ messageId }) => {
        setQueuedMessages((q) => q.filter((m) => m.id !== messageId));
      },
    }
  );
  const isLiveRunning = liveSession.state === "running";
  const isStreaming = submitting || isLiveRunning;

  // On running → idle, refetch canonical history (DB carries
  // sanitization + server-side recall part the chunk path doesn't) and
  // the session title (set fire-and-forget post-turn).
  const prevLiveRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevLiveRunningRef.current;
    prevLiveRunningRef.current = isLiveRunning;
    if (!activeSessionId || !wasRunning || isLiveRunning) return;
    const sid = activeSessionId;
    fetch(`${API_BASE}/api/sessions/${sid}/messages`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: OpenAcmeUIMessage[] | null) => {
        if (data) setMessages(data);
      })
      .catch(() => {});
    fetch(`${API_BASE}/api/sessions/${sid}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { title?: string | null } | null) => {
        if (data) setActiveSessionTitle(data.title ?? null);
      })
      .catch(() => {});
  }, [isLiveRunning, activeSessionId]);

  // Server-owned turn — survives tab close; explicit cancel only.
  const stop = useCallback(async () => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    try {
      await fetch(`${API_BASE}/api/sessions/${sid}/active-turn`, {
        method: "DELETE",
      });
    } catch {
      /* best-effort */
    }
  }, []);

  const loadAgents = useCallback(
    async (signal?: AbortSignal): Promise<Agent[] | null> => {
      try {
        const res = await fetch(`${API_BASE}/api/agents`, { signal });
        if (!res.ok) throw new Error("agents fetch failed");
        return (await res.json()) as Agent[];
      } catch (e) {
        if ((e as Error).name === "AbortError") return null;
        throw e;
      }
    },
    []
  );

  useEffect(() => {
    const ctrl = new AbortController();
    loadAgents(ctrl.signal)
      .then((list) => {
        if (!list) return;
        setAgents(list);
        setActiveAgentId((current) => current || list[0]?.id || "");
      })
      .catch(() =>
        toast.error("Cannot connect to server", {
          description: "Run `openacme start` first.",
        })
      );
    return () => ctrl.abort();
  }, [loadAgents]);

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([
      fetch(`${API_BASE}/api/models`, { signal: ctrl.signal }).then((r) =>
        r.ok ? (r.json() as Promise<ProviderInfo[]>) : Promise.reject(new Error(r.statusText))
      ),
      fetch(`${API_BASE}/api/keys`, { signal: ctrl.signal })
        .then((r): Promise<{ configured: Record<string, boolean> }> | { configured: Record<string, boolean> } =>
          r.ok ? r.json() : { configured: {} }
        )
        .catch(() => ({ configured: {} as Record<string, boolean> })),
    ])
      .then(([providers, keys]) => {
        setModelCatalog({ providers, configured: keys.configured });
      })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
      });
    return () => ctrl.abort();
  }, []);

  // Re-fetch just the keys map; called after a save in the setup panel so the
  // `nothingConfigured` gate flips and the panel unmounts.
  const reloadKeys = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/keys`);
      if (!r.ok) return;
      const data = (await r.json()) as { configured: Record<string, boolean> };
      setModelCatalog((prev) => ({ ...prev, configured: data.configured ?? {} }));
    } catch {
      // Silent; the panel toasts on its own save error.
    }
  }, []);

  const nothingConfigured = useMemo(() => {
    // Gate is decorative until both /api/models and /api/keys responded.
    if (modelCatalog.providers.length === 0) return false;
    const entries = Object.entries(modelCatalog.configured);
    if (entries.length === 0) return false;
    return entries.every(([, v]) => !v);
  }, [modelCatalog]);

  // True while we're fetching history for `activeSessionId`. The chat
  // area uses this to suppress its empty-state flash between the
  // synchronous `setMessages([])` and the async fetch resolution —
  // otherwise opening a session briefly renders `ChatAgentReadyState`
  // before the real messages land. Reset on every session change so a
  // genuinely empty session (no messages at all) still shows the
  // empty state after the fetch completes.
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (!activeSessionId) {
      setActiveSessionTitle(null);
      return;
    }
    // Skip the fetch for freshly-created sessions — the row doesn't
    // exist server-side until /api/chat lands, and the running→idle
    // effect refetches title after the first turn anyway.
    if (freshSessionIdRef.current === activeSessionId) return;
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/sessions/${activeSessionId}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { title?: string | null; agentId?: string } | null) => {
        if (!data) return;
        setActiveSessionTitle(data.title ?? null);
        // Adopt the session's agent — URL only carries `?session=<id>`,
        // so on a direct nav (refresh, shared link, HomeView click) the
        // chat header would otherwise render with no agent set.
        if (data.agentId && data.agentId !== activeAgentIdRef.current) {
          setActiveAgentId(data.agentId);
        }
      })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
      });
    return () => ctrl.abort();
  }, [activeSessionId]);

  // Load history when session changes.
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      setHistoryLoading(false);
      return;
    }
    if (freshSessionIdRef.current === activeSessionId) {
      // Session was just created locally by `send` — there's nothing
      // persisted yet, and we already appended the optimistic user
      // bubble. Fetching would clobber that with an empty array.
      freshSessionIdRef.current = null;
      setHistoryLoading(false);
      return;
    }
    // Clear synchronously before the new history lands — otherwise the
    // previous session's messages stay visible until the fetch resolves,
    // which makes session switches feel like "old chat is still here".
    setMessages([]);
    setHistoryLoading(true);
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/sessions/${activeSessionId}/messages`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data: OpenAcmeUIMessage[]) => {
        setMessages(data);
        setHistoryLoading(false);
      })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        setHistoryLoading(false);
        toast.error("Failed to load messages");
      });
    return () => ctrl.abort();
  }, [activeSessionId, setMessages]);

  // Layout-effect (not useEffect) so the scroll lands BEFORE paint —
  // without this, opening a session paints scrollTop=0 for one frame
  // before the effect fires, briefly flashing the top of the conversation.
  useLayoutEffect(() => {
    if (!atBottomRef.current && !justSentRef.current) return;
    const behavior: ScrollBehavior = justSentRef.current ? "smooth" : "auto";
    messagesEndRef.current?.scrollIntoView({ behavior });
    justSentRef.current = false;
  }, [messages]);

  // Markdown + images keep growing the content after the initial paint;
  // stick to the bottom while the user hasn't scrolled away. Observe the
  // inner content wrapper (not the scroll container itself) so we catch
  // content growth independently of viewport resizes.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    if (!hasMessages) return;
    const el = messagesContainerRef.current;
    const inner = el?.firstElementChild as HTMLElement | null;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [hasMessages]);

  // While a programmatic "go to latest" smooth scroll is in flight, the
  // intermediate onScroll events would re-flip showScrollDown back on
  // and flicker the button. Suppress state writes for the duration.
  const scrollingToBottomRef = useRef(false);
  const handleScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = fromBottom < 60;
    if (scrollingToBottomRef.current) return;
    // Larger threshold for the button than for stick-to-bottom — a few
    // pixels of drift from the sticky path shouldn't pop a CTA up.
    setShowScrollDown(fromBottom > 200);
  };

  const scrollToBottom = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    scrollingToBottomRef.current = true;
    setShowScrollDown(false);
    atBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    // Smooth scroll completes asynchronously; release the suppression
    // after a window long enough for any conversation length.
    window.setTimeout(() => {
      scrollingToBottomRef.current = false;
    }, 700);
  }, []);

  const activeAgent = agents.find((a) => a.id === activeAgentId);

  // Float the active agent's configured skills to the top of the `/` picker.
  // When it has no allowlist (sees all), leave the natural order. Sort is
  // stable, so order within each group is preserved (and a typed query still
  // ranks by match relevance inside SkillTextarea).
  const orderedSkills = useMemo(() => {
    const pri = new Set(activeAgent?.skills ?? []);
    if (pri.size === 0) return skills;
    return [...skills].sort(
      (a, b) => (pri.has(a.name) ? 0 : 1) - (pri.has(b.name) ? 0 : 1)
    );
  }, [skills, activeAgent]);

  // File-path linkification: inline code spans in assistant prose that
  // resolve to real files under the agent's roots open a preview dialog.
  // The streaming message settles at end of turn; it's scanned then.
  const linkOwner = useMemo(
    () =>
      activeAgentId ? ({ kind: "agent", id: activeAgentId } as const) : null,
    [activeAgentId]
  );
  const linkSources = useMemo(
    () =>
      messages.flatMap((m, i) => {
        if (m.role !== "assistant") return [];
        if (isStreaming && i === messages.length - 1) return [];
        const text = m.parts
          .filter((p) => (p as { type?: unknown }).type === "text")
          .map((p) => (p as { text: string }).text)
          .join("\n");
        return text ? [{ id: m.id, text }] : [];
      }),
    [messages, isStreaming]
  );
  const fileLinks = useFileLinkResolver(linkOwner, linkSources);
  const [previewTarget, setPreviewTarget] =
    useState<FilePreviewTarget | null>(null);

  // Provider gate from the model catalog.
  const activeModalities = (() => {
    if (!activeAgent) return undefined;
    const provider = modelCatalog.providers.find(
      (p) => p.id === activeAgent.model.provider
    );
    if (!provider) return undefined;
    return provider.models.find((m) => m.id === activeAgent.model.model)
      ?.inputModalities;
  })();
  const acceptsAttachments =
    !activeModalities ||
    activeModalities.includes("image") ||
    activeModalities.includes("pdf") ||
    activeModalities.includes("file");

  // ── Attachments ───────────────────────────────────────────────────────
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
          toast.error(
            `Max ${UPLOAD_LIMITS.perRequestFiles} attachments per turn`
          );
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
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
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
            const matchIdx = records.findIndex(
              (r) => r.localId === p.localId
            );
            if (matchIdx === -1) return p;
            const srv = data.attachments[matchIdx];
            if (!srv)
              return { ...p, status: "error", error: "no server id" };
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
                  error:
                    err instanceof Error ? err.message : String(err),
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

  // Drag-and-drop on the textarea container.
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
      const files = Array.from(e.dataTransfer.files);
      void uploadFiles(files);
    },
    [uploadFiles, acceptsAttachments]
  );

  const send = useCallback(async () => {
    if (!input.trim() && pendingAttachments.length === 0) return;
    if (!activeAgentId) return;
    // Mid-turn sends are allowed: the server queues them into the
    // agent's inbox without aborting the in-flight turn. The message
    // persists to chat history immediately so the UI renders it
    // in-order; the next turn picks it up.
    if (pendingAttachments.some((p) => p.status === "uploading")) {
      toast.error("Wait for uploads to finish");
      return;
    }
    const ready = pendingAttachments.filter(
      (p) => p.status === "ready" && p.url
    );
    const text = input.trim();
    atBottomRef.current = true;
    justSentRef.current = true;
    setInput("");
    setError(null);
    for (const p of pendingAttachments) {
      if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    }
    setPendingAttachments([]);

    // Client-owned sessionId — the server creates the row from
    // whatever we pass, so the SSE subscription connects up-front and
    // can't miss the agent's first chunks.
    let sid = activeSessionIdRef.current;
    const isNewSession = !sid;
    if (!sid) {
      sid = crypto.randomUUID();
      freshSessionIdRef.current = sid;
      activeSessionIdRef.current = sid;
      setActiveSessionId(sid);
    }

    const userMessageId = crypto.randomUUID();
    const userParts: UIMessage["parts"] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...ready.map((p) => ({
        type: "file" as const,
        url: p.url!,
        mediaType: p.mediaType,
        filename: p.filename,
      })),
      ...(buildSkillRefParts(text, skillNamesRef.current) as UIMessage["parts"]),
    ];
    const optimisticUser: OpenAcmeUIMessage = {
      id: userMessageId,
      role: "user",
      parts: userParts as OpenAcmeUIMessage["parts"],
    };

    // Mid-turn send → server returns { queued: true } and persists the
    // message after the running turn ends. Render it as a queued chip
    // above the input rather than landing it in the chat history
    // immediately — the chat history will pick it up via SSE when the
    // autonomous drain persists it.
    const willQueue = isStreaming;
    const historyForServer = [...messages, optimisticUser];
    if (willQueue) {
      setQueuedMessages((q) => [
        ...q,
        {
          id: userMessageId,
          parts: userParts as OpenAcmeUIMessage["parts"],
        },
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
          agentId: activeAgentIdRef.current,
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
      // On failure, drop the queued chip so the user can retry. (Chat
      // history changes are already best-effort; the optimistic add
      // happened earlier and is hard to surgically remove without
      // walking ids.)
      if (willQueue) {
        setQueuedMessages((q) => q.filter((m) => m.id !== userMessageId));
      }
    } finally {
      setSubmitting(false);
    }
  }, [input, isStreaming, activeAgentId, pendingAttachments, messages, liveSession]);

  // When the canonical version of a queued message lands in `messages`
  // (server persisted it during the autonomous follow-up turn and
  // SSE/refetch brought it in), drop the chip. We match by id so any
  // optimistic vs persisted timing race resolves cleanly.
  useEffect(() => {
    if (queuedMessages.length === 0) return;
    const messageIds = new Set(messages.map((m) => m.id));
    setQueuedMessages((q) => q.filter((m) => !messageIds.has(m.id)));
  }, [messages, queuedMessages.length]);


  const cancelQueued = useCallback(
    async (messageId: string) => {
      // Optimistic chip removal — drop locally first so the UI feels
      // instant. If the cancel races the autonomous drain (server
      // returns `cancelled: 0`), the message has already started
      // processing and will appear in chat history. Surface that to
      // the user with a toast rather than silently letting them think
      // it was cancelled.
      setQueuedMessages((all) => all.filter((m) => m.id !== messageId));
      const sid = activeSessionIdRef.current;
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
        // Network failure leaves the inbox row in place; next turn
        // will drain it and the message lands in chat. Surface so
        // the user isn't surprised by an "uncancelled" message.
        toast.error("Cancel failed", {
          description: "Network error — the message may still arrive.",
        });
      }
    },
    []
  );

  // First-run / "no provider configured" takes over the whole viewport.
  // The chat chrome (sidebar, sessions, composer) is non-functional without
  // a credential, so showing it would lie about what's available.
  if (nothingConfigured) {
    return (
      <main className="relative min-h-screen overflow-y-auto bg-paper">
        <ChatSetupPanel
          providers={modelCatalog.providers}
          onSetup={async () => {
            // Setup wrote `model` to config.yaml and the server evicted
            // its cached Agents; the bundled platform agent (Acme) now
            // resolves to the freshly-picked provider's default. Refresh
            // BOTH /api/keys (gates the panel itself) AND /api/agents
            // (so the chat header / persona shows the new resolved
            // model without a page reload).
            await Promise.all([reloadKeys(), loadAgents().then((list) => list && setAgents(list))]);
          }}
        />
      </main>
    );
  }

  // Layout: Sidebar (icons) | HomeView (compact when a session is
  // selected, full otherwise) | Chat panel (only when a session is
  // selected, or when the URL explicitly opens a new chat with an
  // agent via `?agent=<id>`). Driven off URL not state so navigating
  // back to `/` always returns to Home regardless of auto-picked
  // activeAgentId.
  const chatOpen = !!activeSessionId || !!agentFromUrl;
  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />
      {/* On mobile, hide the HomeView rail when a chat is open — there's
          no room for three columns under 768px. Tapping the hamburger
          opens the sidebar drawer with the nav; back-out to Home is
          via the back arrow in the chat header. */}
      <div className={chatOpen ? "hidden md:contents" : "contents"}>
        <HomeView compact={chatOpen} />
      </div>
      {chatOpen && (
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-paper-rule px-3 md:px-6">
          <div className="flex min-w-0 items-center gap-2 md:gap-4">
            <button
              type="button"
              onClick={() => void navigate({ to: "/" })}
              title="Back to home"
              aria-label="Back to home"
              className="flex size-11 items-center justify-center text-ink-soft hover:text-ink focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-plot-red md:hidden"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "status-dot transition-colors",
                  isStreaming ? "bg-plot-red pulse-live" : "bg-ink"
                )}
                aria-hidden
              />
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
                {statusLabel(submitting, isLiveRunning, !!activeAgent)}
              </span>
            </div>
            <span className="hidden h-3 w-px bg-paper-rule sm:inline" aria-hidden />
            <span className="min-w-0 truncate text-sm font-medium text-ink">
              {activeSessionTitle ||
                (activeSessionId ? "Untitled session" : "New chat")}
            </span>
            {activeAgent && (
              <span className="hidden items-center gap-1.5 font-mono text-[11px] text-ink-faint md:inline-flex">
                <span aria-hidden>·</span>
                {activeAgent.avatar && (
                  <AgentAvatar
                    avatar={activeAgent.avatar}
                    size="sm"
                    className="text-ink-soft"
                  />
                )}
                <AgentRef
                  id={activeAgent.id}
                  label={activeAgent.name}
                  className="text-ink-soft"
                />
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {activeAgent && (
              <ModelQuickSwitch
                agent={activeAgent}
                catalog={modelCatalog}
                onChange={async (next) => {
                  const prev = activeAgent;
                  setAgents((list) =>
                    list.map((a) =>
                      a.id === prev.id
                        ? { ...a, model: { ...a.model, provider: next.provider, model: next.id } }
                        : a
                    )
                  );
                  try {
                    const res = await fetch(`${API_BASE}/api/agents/${prev.id}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: { ...prev.model, provider: next.provider, model: next.id },
                      }),
                    });
                    if (!res.ok) throw new Error(await res.text());
                    const fresh = await res.json() as { model: { provider: string; model: string } };
                    setAgents((list) =>
                      list.map((a) =>
                        a.id === prev.id
                          ? { ...a, model: { ...a.model, provider: fresh.model.provider, model: fresh.model.model } }
                          : a
                      )
                    );
                    toast.success(`Switched to ${next.label}`);
                  } catch (err) {
                    setAgents((list) => list.map((a) => (a.id === prev.id ? prev : a)));
                    toast.error("Failed to switch model", {
                      description: err instanceof Error ? err.message : String(err),
                    });
                  }
                }}
              />
            )}
          </div>
        </header>

        {messages.length === 0 ? (
          historyLoading ? (
            // History is in flight; suppress the empty-state poster so
            // it doesn't flash between `setMessages([])` and the fetch
            // resolution. Plain spacer keeps the layout stable.
            <div className="flex-1" />
          ) : (
            <div className="flex flex-1 items-start justify-center overflow-y-auto px-6 py-16">
              <div
                key={activeAgent?.id ?? (agents.length === 0 ? "_none" : "_pick")}
                className="w-full max-w-2xl section-enter"
              >
                {agents.length === 0 ? (
                  <ChatNoAgentsState />
                ) : activeAgent ? (
                  <ChatAgentReadyState agent={activeAgent} />
                ) : (
                  <ChatSelectAgentState />
                )}
              </div>
            </div>
          )
        ) : (
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={messagesContainerRef}
            onScroll={handleScroll}
            role="log"
            aria-label="Conversation"
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          >
            <div className="mx-auto max-w-3xl px-3 py-4 md:px-6 md:py-6">
              {messages.map((msg, i) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  agent={activeAgent}
                  isStreaming={
                    isStreaming &&
                    msg.role === "assistant" &&
                    i === messages.length - 1
                  }
                  pingAnswered={messages
                    .slice(i + 1)
                    .some((m) => m.role === "user")}
                  fileLinks={fileLinks}
                  onOpenFile={setPreviewTarget}
                />
              ))}
              {error && (
                <div role="alert" className="mt-4 border border-destructive bg-paper-sunk px-3 py-2 font-mono text-[12px] text-destructive section-enter">
                  <span className="mr-2 text-[10px] uppercase tracking-[0.08em]">Error</span>
                  {error.message}
                </div>
              )}
              {Object.entries(statusBoard).map(([id, s]) => (
                <div
                  key={id}
                  role={s.kind === "error" ? "alert" : "status"}
                  className={cn(
                    "mt-3 flex items-center gap-3 px-3 py-1.5 font-mono text-[12px] section-enter",
                    s.kind === "error" && "bg-paper-sunk text-destructive",
                    s.kind === "warn" && "bg-paper-sunk text-warn-ochre",
                    (s.kind === "info" ||
                      s.kind === "compressing" ||
                      s.kind === "compressed") &&
                      "bg-paper-sunk text-ink-soft"
                  )}
                >
                  <span className="status-dot bg-current" aria-hidden />
                  <span className="uppercase tracking-[0.08em] text-[10px]">
                    {s.kind}
                  </span>
                  <span>{s.message}</span>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>
          {showScrollDown && (
            <button
              type="button"
              onClick={scrollToBottom}
              aria-label="Scroll to latest"
              className="absolute bottom-3 right-3 z-10 flex size-9 items-center justify-center border border-paper-rule bg-paper text-ink-soft transition-colors hover:border-plot-red hover:text-plot-red md:bottom-4 md:right-4"
            >
              <ArrowDown className="size-4" aria-hidden />
            </button>
          )}
          </div>
        )}

        <div className="shrink-0 border-t border-paper-rule bg-paper pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto max-w-3xl px-3 py-3 md:px-6 md:py-4">
            {queuedMessages.length > 0 && (
              <div className="mb-2 border border-paper-rule bg-paper-sunk px-3 py-2">
                <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  <span>
                    Queued · {queuedMessages.length}
                  </span>
                  <span>Sent on next turn</span>
                </div>
                <ul className="space-y-1">
                  {queuedMessages.map((q) => {
                    const textPart = q.parts.find(
                      (p) => (p as { type?: string }).type === "text"
                    ) as { type: "text"; text?: string } | undefined;
                    const filePart = q.parts.find(
                      (p) => (p as { type?: string }).type === "file"
                    ) as { type: "file"; filename?: string } | undefined;
                    const summary =
                      (textPart?.text?.trim() ?? "") ||
                      (filePart?.filename ? `[file: ${filePart.filename}]` : "(empty)");
                    return (
                      <li
                        key={q.id}
                        className="flex items-start gap-2 text-sm text-ink-soft"
                      >
                        <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-plot-red pulse-live" />
                        <span className="line-clamp-2 break-words">{summary}</span>
                        <button
                          type="button"
                          className="ml-auto flex min-h-11 min-w-11 shrink-0 items-center justify-center font-mono text-[12px] uppercase tracking-[0.08em] text-ink-faint hover:text-plot-red md:min-h-0 md:min-w-0 md:text-[10px]"
                          aria-label="Cancel queued message"
                          onClick={() => void cancelQueued(q.id)}
                          title="Cancel — drops the queued message before the next turn picks it up"
                        >
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            <ChatComposer
              value={input}
              onChange={setInput}
              onSend={() => void send()}
              onStop={() => stop()}
              isStreaming={isStreaming}
              disabled={!activeAgentId}
              placeholder={
                activeAgent
                  ? isStreaming
                    ? `Queue next message for ${activeAgent.name}…`
                    : `Message ${activeAgent.name}`
                  : "Select an agent"
              }
              sendDisabled={
                (!input.trim() && pendingAttachments.length === 0) ||
                !activeAgentId ||
                pendingAttachments.some((p) => p.status === "uploading")
              }
              sendLabel={isStreaming ? "Queue message" : "Send message"}
              textareaRef={inputRef}
              skills={orderedSkills}
              isDragging={isDragging}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              attachmentsBar={
                pendingAttachments.length > 0 ? (
                  <div className="flex flex-nowrap gap-1.5 overflow-x-auto border-b border-paper-rule bg-paper-sunk px-3 py-2 md:flex-wrap md:overflow-visible">
                    {pendingAttachments.map((p) => (
                      <AttachmentChip
                        key={p.localId}
                        kind={
                          p.kind ?? (p.mediaType.startsWith("image/") ? "image" : "file")
                        }
                        mediaType={p.mediaType}
                        size={p.size}
                        name={p.filename}
                        status={p.status}
                        error={p.error}
                        removable
                        onRemove={() => removePending(p.localId)}
                      />
                    ))}
                  </div>
                ) : null
              }
              attachButton={
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={ALLOWED_UPLOAD_MIMES.join(",")}
                    className="hidden"
                    onChange={(e) => {
                      const files = e.target.files ? Array.from(e.target.files) : [];
                      void uploadFiles(files);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!activeAgentId || !acceptsAttachments}
                    className="shrink-0"
                    aria-label="Attach files"
                    title={
                      acceptsAttachments
                        ? "Attach files (images, PDFs)"
                        : "Active model accepts text only — switch with the model picker"
                    }
                  >
                    <Paperclip className="size-4" />
                  </Button>
                </>
              }
            />
          </div>
        </div>
      </main>
      )}
      <FilePreviewDialog
        target={previewTarget}
        onClose={() => setPreviewTarget(null)}
      />
    </div>
  );
}

function ModelQuickSwitch({
  agent,
  catalog,
  onChange,
}: {
  agent: Agent;
  catalog: { providers: ProviderInfo[]; configured: Record<string, boolean> };
  onChange: (next: ModelOption) => void;
}) {
  const value = `${agent.model.provider}/${agent.model.model}`;
  const options: ModelOption[] = [];
  for (const p of catalog.providers) {
    if (!catalog.configured[p.id] && p.id !== agent.model.provider) continue;
    for (const m of p.models ?? []) {
      options.push({
        provider: p.id,
        providerName: p.name,
        id: m.id,
        label: m.label,
        hint: m.hint,
      });
    }
  }
  const grouped = options.reduce<Record<string, ModelOption[]>>((acc, opt) => {
    (acc[opt.providerName] ??= []).push(opt);
    return acc;
  }, {});
  const currentOption = options.find(
    (o) => o.provider === agent.model.provider && o.id === agent.model.model
  );
  const isKnown = !!currentOption;
  // Single-line label for the trigger. Radix mirrors SelectItem children
  // into SelectValue by default — the items render a two-line label+hint
  // stack, which reads as shadcn-default in the chat header. Overriding
  // SelectValue's children collapses to one mono line that fits the
  // instrument register without losing the hint inside the dropdown.
  const triggerLabel = currentOption?.label ?? value;

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const opt = options.find((o) => `${o.provider}/${o.id}` === next);
        if (opt) onChange(opt);
      }}
    >
      <SelectTrigger
        size="sm"
        className="h-8 w-auto max-w-[60vw] gap-1.5 border border-paper-rule bg-paper px-2 font-mono text-[11px] text-ink transition-colors hover:border-plot-red data-[state=open]:border-plot-red [&_svg]:size-3 [&_svg]:opacity-60 md:max-w-none md:gap-2 md:px-2.5"
        aria-label="Switch model"
      >
        <SelectValue placeholder={value}>
          <span className="truncate font-mono text-[11px] text-ink">
            {triggerLabel}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {!isKnown && (
          <SelectGroup>
            <SelectLabel>Current (custom)</SelectLabel>
            <SelectItem value={value}>
              <span className="font-mono">{value}</span>
            </SelectItem>
          </SelectGroup>
        )}
        {Object.entries(grouped).map(([providerName, opts]) => (
          <SelectGroup key={providerName}>
            <SelectLabel>{providerName}</SelectLabel>
            {opts.map((o) => (
              <SelectItem
                key={`${o.provider}/${o.id}`}
                value={`${o.provider}/${o.id}`}
              >
                <div className="flex flex-col items-start">
                  <span>{o.label}</span>
                  {o.hint && (
                    <span className="text-[10px] text-ink-soft">
                      {o.hint}
                    </span>
                  )}
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}


function ChatNoAgentsState() {
  return (
    <>
      <SectionEyebrow meta="0 agents">No agents configured</SectionEyebrow>
      <p className="mt-5 max-w-prose text-[14px] leading-relaxed text-ink-soft">
        An{" "}
        <JargonChip
          term="Agent"
          explanation="A YAML+prose file at ~/.openacme/agents/<id>/AGENT.md. Owns its own model, tools, MCP servers, sessions, memory, and tasks. Loaded into the daemon at startup and on edit."
        >
          <span className="text-ink">agent</span>
        </JargonChip>{" "}
        in OpenAcme is a file at{" "}
        <code className="px-1 py-0.5 font-mono text-[12px] text-ink">
          ~/.openacme/agents/&lt;id&gt;/AGENT.md
        </code>{" "}
        — YAML frontmatter for its model, tools, and MCP servers, plus
        prose for its persona. Each one owns its own sessions, memory,
        and tasks.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button asChild>
          <Link to="/agents">Create your first agent</Link>
        </Button>
        <span className="text-[12px] text-ink-faint">
          or run{" "}
          <code className="px-1 py-0.5 font-mono text-[12px] text-ink">
            openacme setup
          </code>{" "}
          in the CLI
        </span>
      </div>
    </>
  );
}

function ChatSelectAgentState() {
  return (
    <>
      <SectionEyebrow>Select an agent</SectionEyebrow>
      <p className="mt-5 max-w-prose text-[14px] leading-relaxed text-ink-soft">
        Choose an agent from the sidebar to start a session. Each agent
        owns its model, tools, skills, and memory; sessions persist on
        disk under the daemon&apos;s data dir.
      </p>
    </>
  );
}

function ChatAgentReadyState({ agent }: { agent: Agent }) {
  return (
    <>
      <SectionEyebrow
        meta={
          <span>
            <span className="text-ink-faint">model · </span>
            <span className="text-ink">
              {agent.model.provider}/{agent.model.model}
            </span>
          </span>
        }
      >
        {agent.name}
      </SectionEyebrow>
      {agent.role && (
        <p className="mt-5 max-w-prose text-[14px] leading-relaxed text-ink-soft">
          {agent.role}
        </p>
      )}
      <div className="mt-8">
        <ScribedRule delay={200} />
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 meta-row">
          <span>
            <span className="text-ink-faint">tools · </span>
            <span className="text-ink">{agent.tools.length}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="status-dot bg-ink" />
            <span className="label-faceplate">Ready</span>
          </span>
        </div>
      </div>
    </>
  );
}
