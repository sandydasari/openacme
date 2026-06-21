import { useEffect, useRef, useState } from "react";
import { readUIMessageStream } from "ai";
import type { OpenAcmeUIMessage } from "./types";
import { API_BASE } from "./api";

/**
 * Subscribe to a per-session SSE channel. Feeds `ui_message_part` chunks
 * into `readUIMessageStream` for live assembly; accepts pre-assembled
 * UIMessages via `messages_appended`. Both upsert by id so chunks and
 * the end-of-turn canonical broadcast converge.
 *
 * `whenConnected()` resolves on the EventSource's `open` event for the
 * current sessionId — callers await it before posting /api/chat so the
 * agent's first chunks aren't missed.
 */
export function useLiveSession(
  sessionId: string | null | undefined,
  setMessages:
    | ((updater: (prev: OpenAcmeUIMessage[]) => OpenAcmeUIMessage[]) => void)
    | null,
  opts?: {
    onTaskEvent?: (event: {
      id: string;
      kind: string;
      taskId: string | null;
      payload: string | null;
      /** Event creation time, unix seconds. */
      createdAt?: number;
    }) => void;
    /** Transient data-* parts are stripped by the assembler, surfaced
     *  here instead. */
    onDataPart?: (part: { type: string; data: unknown }) => void;
    /** A user message was queued mid-turn (sent via /api/chat while a
     *  turn was already streaming). Other tabs watching this session
     *  surface a queued chip; the originating tab also receives this
     *  but its own optimistic-add path dedupes by id. */
    onInboxQueued?: (item: { messageId: string; parts: unknown[] }) => void;
    /** A queued user message was cancelled (via DELETE /queued/:id).
     *  Other tabs drop their chip. */
    onInboxCancelled?: (item: { messageId: string }) => void;
  }
): { state: "running" | "idle"; whenConnected: () => Promise<void> } {
  const [state, setState] = useState<"running" | "idle">("idle");
  // Latest opts via ref so the SSE handlers aren't part of the
  // resubscribe key (only sessionId is).
  const setMessagesRef = useRef(setMessages);
  const onTaskEventRef = useRef(opts?.onTaskEvent);
  const onDataPartRef = useRef(opts?.onDataPart);
  const onInboxQueuedRef = useRef(opts?.onInboxQueued);
  const onInboxCancelledRef = useRef(opts?.onInboxCancelled);
  setMessagesRef.current = setMessages;
  onTaskEventRef.current = opts?.onTaskEvent;
  onDataPartRef.current = opts?.onDataPart;
  onInboxQueuedRef.current = opts?.onInboxQueued;
  onInboxCancelledRef.current = opts?.onInboxCancelled;
  // Promise that resolves on the current EventSource's `open`. Replaced
  // on every sessionId change so callers always await the live one.
  const connectedRef = useRef<{ promise: Promise<void>; resolve: () => void }>(
    (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    })()
  );
  const whenConnected = () => connectedRef.current.promise;

  useEffect(() => {
    if (!sessionId) return;
    let resolveConnected!: () => void;
    connectedRef.current = {
      promise: new Promise<void>((r) => (resolveConnected = r)),
      resolve: () => resolveConnected(),
    };
    const es = new EventSource(
      `${API_BASE}/api/sessions/${sessionId}/stream`,
      { withCredentials: true }
    );
    es.onopen = () => resolveConnected();

    // One assembler per assistant message. `readUIMessageStream` keeps
    // a single `state.message` for the lifetime of its input stream and
    // a `start` chunk only overwrites `state.message.id` — it does NOT
    // clear `state.message.parts`. Reusing one assembler across turns
    // therefore bleeds the previous turn's parts into the next turn's
    // bubble until `messages_appended` lands. Open a fresh assembler on
    // every `start` (i.e. every new message id) and close it on
    // `finish`.
    let controller: ReadableStreamDefaultController<unknown> | null = null;
    let currentMessageId: string | null = null;

    // Coalesce assembler emits to one React commit per animation frame.
    // Word-cadence deltas arrive faster than 60fps; committing each one
    // re-parses the streaming message's markdown and re-renders the
    // thread, which is the jank. Only the latest snapshot matters.
    // Single slot — relies on the server streaming at most one assistant
    // message per session at a time; interleaved ids would drop snapshots.
    let pendingUpsert: OpenAcmeUIMessage | null = null;
    let upsertRaf = 0;
    const flushUpsert = () => {
      upsertRaf = 0;
      const m = pendingUpsert;
      pendingUpsert = null;
      if (m) setMessagesRef.current?.((prev) => upsertById(prev, m));
    };
    const queueUpsert = (m: OpenAcmeUIMessage) => {
      pendingUpsert = m;
      if (!upsertRaf) upsertRaf = requestAnimationFrame(flushUpsert);
    };

    const closeCurrent = () => {
      try {
        controller?.close();
      } catch {
        /* already closed */
      }
      controller = null;
      currentMessageId = null;
    };

    const openAssembler = () => {
      const stream = new ReadableStream<unknown>({
        start(c) {
          controller = c;
        },
      });
      void (async () => {
        try {
          for await (const message of readUIMessageStream<OpenAcmeUIMessage>({
            stream: stream as ReadableStream<never>,
          })) {
            if (!message.id) continue;
            // structuredClone is performed inside readUIMessageStream
            // per emit, so each yielded `message` is a fresh snapshot —
            // safe to hand to React state.
            queueUpsert(message);
          }
        } catch {
          /* stream closed — expected on turn boundary / unmount */
        }
      })();
    };

    const handlers: Record<string, (e: MessageEvent) => void> = {
      ui_message_part: (e) => {
        try {
          const env = JSON.parse(e.data) as {
            part?: unknown;
            messageId?: unknown;
          };
          if (env.part === undefined) return;
          const part = env.part as {
            type?: unknown;
            data?: unknown;
            messageId?: unknown;
          };
          if (
            typeof part.type === "string" &&
            part.type.startsWith("data-") &&
            part.data !== undefined
          ) {
            try {
              onDataPartRef.current?.({
                type: part.type,
                data: part.data,
              });
            } catch {
              /* surface-only; never break assembly */
            }
          }
          // Message-boundary control: a `start` chunk opens a fresh
          // assembler so the new bubble doesn't inherit the prior
          // turn's parts; a `finish` chunk closes the current one so
          // the iterator drains cleanly.
          if (part.type === "start") {
            const newId =
              typeof part.messageId === "string" ? part.messageId : null;
            if (!controller || newId !== currentMessageId) {
              closeCurrent();
              currentMessageId = newId;
              openAssembler();
            }
          } else if (!controller) {
            // Late-joining subscriber missed the `start` chunk (SSE
            // doesn't replay on fresh subscribes). The assembler can't
            // process raw text-delta chunks without a preceding
            // text-start (AI SDK throws), so we don't try here. The
            // server pushes throttled `messages_appended` snapshots of
            // the in-flight assistant message for late-joiners — they
            // update the UI via the upsert-by-id path. We still open
            // an assembler so a later `start` (next message) works.
            openAssembler();
          }
          controller?.enqueue(env.part);
          if (part.type === "finish") {
            closeCurrent();
          }
        } catch {
          /* ignore */
        }
      },
      messages_appended: (e) => {
        try {
          const env = JSON.parse(e.data) as { messages?: OpenAcmeUIMessage[] };
          if (!env.messages?.length) return;
          // Drain any frame-buffered chunk snapshot first so a stale rAF
          // can't fire after this and overwrite the canonical message.
          if (upsertRaf) cancelAnimationFrame(upsertRaf);
          flushUpsert();
          setMessagesRef.current?.((prev) => {
            let out = prev;
            for (const m of env.messages!) out = upsertById(out, m);
            return out;
          });
        } catch {
          /* ignore */
        }
      },
      session_state: (e) => {
        try {
          const env = JSON.parse(e.data) as { state?: "running" | "idle" };
          if (env.state === "running" || env.state === "idle") {
            setState(env.state);
          }
        } catch {
          /* ignore */
        }
      },
      task_event: (e) => {
        try {
          const env = JSON.parse(e.data) as {
            event?: {
              id: string;
              kind: string;
              taskId: string | null;
              payload: string | null;
              createdAt?: number;
            };
          };
          if (env.event) onTaskEventRef.current?.(env.event);
        } catch {
          /* ignore */
        }
      },
      inbox_queued: (e) => {
        try {
          const env = JSON.parse(e.data) as {
            messageId?: string;
            parts?: unknown[];
          };
          if (env.messageId && env.parts) {
            onInboxQueuedRef.current?.({
              messageId: env.messageId,
              parts: env.parts,
            });
          }
        } catch {
          /* ignore */
        }
      },
      inbox_cancelled: (e) => {
        try {
          const env = JSON.parse(e.data) as { messageId?: string };
          if (env.messageId) {
            onInboxCancelledRef.current?.({ messageId: env.messageId });
          }
        } catch {
          /* ignore */
        }
      },
    };
    for (const [name, fn] of Object.entries(handlers)) {
      es.addEventListener(name, fn);
    }

    return () => {
      for (const [name, fn] of Object.entries(handlers)) {
        es.removeEventListener(name, fn);
      }
      es.close();
      closeCurrent();
      if (upsertRaf) cancelAnimationFrame(upsertRaf);
      pendingUpsert = null;
    };
  }, [sessionId]);

  return { state, whenConnected };
}

function upsertById(
  prev: OpenAcmeUIMessage[],
  next: OpenAcmeUIMessage
): OpenAcmeUIMessage[] {
  const idx = prev.findIndex((m) => m.id === next.id);
  if (idx < 0) return [...prev, next];
  const out = prev.slice();
  // Preserve metadata across upserts. The chunk-assembled message from
  // `readUIMessageStream` doesn't carry `metadata`, and a naïve replace
  // would wipe out fields like `kind: "autonomous_event"` that came in
  // on the initial fetch — causing autonomous wake rows to render as
  // ordinary user messages instead of being filtered out by the bubble.
  const prior = out[idx]!;
  const merged: OpenAcmeUIMessage =
    next.metadata == null && prior.metadata != null
      ? ({ ...next, metadata: prior.metadata } as OpenAcmeUIMessage)
      : next;
  out[idx] = merged;
  return out;
}
