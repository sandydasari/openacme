/**
 * SSE routes for live workforce + per-session streams.
 *
 * - `GET /api/sessions/:id/stream` — per-session push channel. Emits
 *   `ui_message_part`, `messages_appended`, `session_state`,
 *   `session_title`, and `task_event` envelopes. Replays the
 *   broadcaster's ring buffer on
 *   reconnect (Last-Event-ID present) so a brief disconnect doesn't
 *   drop a streaming turn. Fresh connections are forward-only — past
 *   messages come from DB history, not the buffer.
 *
 * - `GET /api/home/stream` — workforce-wide channel, no replay. Used
 *   by the home view to know "something changed somewhere" and refetch
 *   /api/home.
 */

import type { Hono } from "hono";
import type { AgentManager } from "../agent-manager.js";
import type { BroadcastEnvelope } from "../broadcaster.js";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

const KEEPALIVE_MS = 25_000;

function sseLine(env: BroadcastEnvelope, prefix?: Record<string, unknown>): string {
  return (
    `id: ${env.seq}\n` +
    `event: ${env.event.kind}\n` +
    `data: ${JSON.stringify({ ...prefix, ts: env.ts, ...env.event })}\n\n`
  );
}

function parseSinceSeq(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Bridge SSE I/O onto a Hono response: create a ReadableStream, give
 * the caller a `write` for SSE lines, drive a keepalive ticker, and
 * clean up on request abort. The caller's `start(write)` returns its
 * unsubscribe handle which we invoke during cleanup.
 */
function sseResponse(
  signal: AbortSignal,
  start: (write: (line: string) => void) => () => void
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const write = (line: string) => {
        try {
          controller.enqueue(enc.encode(line));
        } catch {
          // controller closed
        }
      };
      // Initial flush: Cloudflare / cloudflared and some other reverse proxies
      // hold the response until the body starts. Without an initial byte, the
      // client sees a hung connection until the first event (or keepalive
      // 25s later). Comment lines are valid SSE no-ops.
      write(": connected\n\n");
      const unsubscribe = start(write);
      const keepalive = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);
      signal.addEventListener("abort", () => {
        clearInterval(keepalive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

export function registerStreamRoutes(app: Hono, manager: AgentManager): void {
  app.get("/api/sessions/:id/stream", (c) => {
    const sessionId = c.req.param("id");
    // No 404 on unknown session — the web subscribes BEFORE the first
    // POST to /api/chat creates the row (SSE has to be open before send
    // so the agent's first chunks aren't missed). The broadcaster
    // handles lazy session state internally.
    const sinceSeq = parseSinceSeq(c.req.header("last-event-id"));
    // Replay the ring buffer only on real reconnects (Last-Event-ID
    // present). Fresh connections get forward-only — replaying old
    // `ui_message_part` chunks whose `start` chunks have aged out
    // would confuse the client assembler and overwrite real history.
    const shouldReplay = sinceSeq !== undefined;
    return sseResponse(c.req.raw.signal, (write) => {
      const sub = manager.broadcaster.subscribe(
        sessionId,
        (env) => write(sseLine(env)),
        { sinceSeq }
      );
      if (shouldReplay) for (const env of sub.replay) write(sseLine(env));
      return sub.unsubscribe;
    });
  });

  app.get("/api/home/stream", (c) =>
    sseResponse(c.req.raw.signal, (write) =>
      manager.broadcaster.subscribeWorkforce((sessionId, env) =>
        write(sseLine(env, { sessionId }))
      )
    )
  );
}
