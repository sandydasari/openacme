import type { WasmDatabase } from "../wasm/adapter.js";
import { drizzle } from "../wasm/drizzle.js";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createLogger } from "@openacme/config/logger";
import { taskEvents, type TaskEventRow } from "../schema.js";

const log = createLogger("db.event-store");

export type { TaskEventRow } from "../schema.js";

// Single source of truth for `EventKind` is `@openacme/tasks/ports`.
import type { EventKind } from "@openacme/tasks";

export interface EventInput {
  /** Task this event is anchored to. Nullable for session-level events
   *  (e.g. `ping_user` where there's no task in scope). At least one of
   *  (taskId, sessionId) must be non-null. */
  taskId?: string | null;
  /** Session this event is anchored to. Resolved from the task's binding
   *  if absent and taskId is present; required for session-only events. */
  sessionId?: string | null;
  agentId: string;
  /** Agent that *caused* this event. Used both for prompt attribution
   *  ("X commented", "Y closed") and for the scheduler's echo
   *  suppression — a session never wakes from its owning agent's own
   *  actions. Null/undefined = anonymous / system / auto, always wakes. */
  actor?: string | null;
  kind: EventKind;
  payload?: unknown;
  id?: string;
}

export type EventListener = (event: TaskEventRow) => void;

/**
 * Append-only event log driving the agent's "Recent activity" prompt
 * surface, the scheduler's wake decisions, and the operator's inbox
 * (via `ping_user` events).
 *
 * Polymorphic addressing: events may be anchored to a task, a session,
 * or both. New writes auto-resolve `session_id` from the task's binding
 * when only `task_id` is provided, so existing emit sites need no change.
 *
 * `onEmit` listeners fire synchronously after each insert. They MUST
 * NOT synchronously emit further events (no re-entrancy guard) and
 * MUST NOT throw — a misbehaving listener gets logged and skipped so
 * one bad subscriber doesn't break event flow.
 */
export function createEventStore(db: WasmDatabase) {
  const orm = drizzle(db);
  const listeners: EventListener[] = [];
  let firing = false;

  // We can't go through TaskStore (filesystem) from here without a
  // circular dep, but session bindings of in-flight tasks aren't in
  // SQLite — the task is on disk. So `resolveSessionForTask` is a
  // best-effort: if the caller didn't pass a sessionId, leave it null.
  // The scheduler bridge in agent-manager.ts passes the resolved
  // sessionId explicitly when it forwards events to listeners.

  return {
    append(input: EventInput): TaskEventRow {
      if (!input.taskId && !input.sessionId) {
        throw new Error(
          "EventStore.append: at least one of (taskId, sessionId) must be set"
        );
      }
      const row = orm
        .insert(taskEvents)
        .values({
          id: input.id ?? randomUUID(),
          taskId: input.taskId ?? null,
          sessionId: input.sessionId ?? null,
          agentId: input.agentId,
          actor: input.actor ?? null,
          kind: input.kind,
          payload: input.payload !== undefined ? JSON.stringify(input.payload) : null,
        })
        .returning()
        .get();
      // Re-entrancy guard: if a listener somehow triggers another append,
      // queue it as a microtask so we don't recurse synchronously.
      if (firing) {
        queueMicrotask(() => {
          for (const fn of listeners) {
            try {
              fn(row);
            } catch (e) {
              log.warn({ err: e }, "event listener threw");
            }
          }
        });
        return row;
      }
      firing = true;
      try {
        for (const fn of listeners) {
          try {
            fn(row);
          } catch (e) {
            log.warn({ err: e }, "event listener threw");
          }
        }
      } finally {
        firing = false;
      }
      return row;
    },

    /**
     * Events for the given tasks, newer than `sinceTs`, most-recent-first.
     * Secondary order by `rowid DESC` so same-second events are stable
     * in reverse insertion order — without it, a recurring close emits
     * `task_completed_run` and `status_changed` in the same unixepoch
     * second and the readback order is undefined, scrambling event log
     * presentation in the UI and the "Recent activity" prompt section.
     */
    recentForTasks(
      taskIds: string[],
      sinceTs: number,
      limit = 20
    ): TaskEventRow[] {
      if (taskIds.length === 0) return [];
      return orm
        .select()
        .from(taskEvents)
        .where(
          and(
            inArray(taskEvents.taskId, taskIds),
            gt(taskEvents.createdAt, sinceTs)
          )
        )
        .orderBy(desc(taskEvents.createdAt), sql`rowid desc`)
        .limit(limit)
        .all();
    },

    /**
     * Session-scoped events newer than `sinceTs`. Used by the home page
     * stream and any session-level reader (e.g. the unresolved-pings
     * query). Same ordering guarantees as `recentForTasks`.
     */
    recentForSession(
      sessionId: string,
      sinceTs: number,
      limit = 20
    ): TaskEventRow[] {
      return orm
        .select()
        .from(taskEvents)
        .where(
          and(
            eq(taskEvents.sessionId, sessionId),
            gt(taskEvents.createdAt, sinceTs)
          )
        )
        .orderBy(desc(taskEvents.createdAt), sql`rowid desc`)
        .limit(limit)
        .all();
    },

    /**
     * For each session that has at least one `ping_user` event newer
     * than the session's last user message (or any user message at all),
     * return the latest ping. This is the canonical "needs you" query
     * for the operator's inbox. A user message at any time clears the
     * ping — the operator's presence is the resolution signal, no
     * strict "is this an answer to the question" matching.
     *
     * A later `ping_resolved` event clears the ping too: that's the
     * proactive-close path (Acme withdraws a stale request the user no
     * longer needs to answer). Symmetric to the user-message anti-join —
     * either signal, whichever lands later, retires the ping.
     */
    unresolvedPingsBySession(): Array<{
      sessionId: string;
      agentId: string;
      message: string;
      createdAt: number;
      eventId: string;
    }> {
      // Raw SQL — drizzle's window-function support is awkward and the
      // shape of this query (latest-per-group with anti-join on later
      // user messages) is easier read as SQL.
      const stmt = db.prepare<
        [],
        {
          id: string;
          session_id: string;
          agent_id: string;
          payload: string | null;
          created_at: number;
        }
      >(`
        WITH latest_pings AS (
          SELECT
            id, session_id, agent_id, payload, created_at, rowid,
            ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC, rowid DESC) AS rn
          FROM task_events
          WHERE kind = 'ping_user' AND session_id IS NOT NULL
        )
        SELECT id, session_id, agent_id, payload, created_at, rowid
        FROM latest_pings p
        WHERE p.rn = 1
          AND NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.session_id = p.session_id
              AND m.role = 'user'
              AND m.created_at > p.created_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM task_events r
            WHERE r.session_id = p.session_id
              AND r.kind = 'ping_resolved'
              AND (r.created_at > p.created_at
                   OR (r.created_at = p.created_at AND r.rowid > p.rowid))
          )
      `);
      const rows = stmt.all();
      return rows.map((r) => {
        let message = "";
        if (r.payload) {
          try {
            const p = JSON.parse(r.payload) as { message?: unknown };
            if (typeof p.message === "string") message = p.message;
          } catch {
            // ignore — message stays empty
          }
        }
        return {
          eventId: r.id,
          sessionId: r.session_id,
          agentId: r.agent_id,
          message,
          createdAt: r.created_at,
        };
      });
    },

    onEmit(listener: EventListener): () => void {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}

export type EventStore = ReturnType<typeof createEventStore>;
