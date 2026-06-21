/**
 * Structural ports for external stores TaskStore depends on.
 * Defined here (not imported from @openacme/db) so the tasks package
 * stays free of a runtime dep on the DB. AgentManager wires the
 * concrete DB-backed stores in; tests can pass mocks or omit them.
 *
 * **All "kind" unions for the task subsystem live here** — `CommentKind`
 * for comments, `EventKind` for events. Magic strings elsewhere should
 * narrow to one of these. Add new kinds at this central spot and the
 * tools / routes / web mirrors will surface type errors at every site
 * that needs updating.
 */

/**
 * Canonical comment kinds. `null` (or undefined) = generic, untagged.
 * Add new kinds HERE — every other place that types kinds (DB schema's
 * drizzle enum hint, DB store types, web mirror) imports from here so
 * the type checker surfaces every reader site that needs an update.
 */
export const COMMENT_KINDS = ["result", "system"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export interface Comment {
  id: string;
  taskId: string;
  author: string;
  kind: CommentKind | null;
  body: string;
  createdAt: number;
}

export interface CommentInput {
  taskId: string;
  author: string;
  body: string;
  kind?: CommentKind | null;
}

export interface CommentListOptions {
  limit?: number;
  sinceTs?: number;
  /** Inclusive kind filter. Pass `null` in the array to also include
   *  untagged (default-kind) comments alongside the named kinds. */
  kinds?: (CommentKind | null)[];
}

export interface CommentStorePort {
  add(input: CommentInput): Comment;
  list(taskId: string, opts?: CommentListOptions): Comment[];
  latestResult(taskId: string): Comment | null;
  countByTask(taskIds: string[]): Map<string, number>;
  deleteByTask(taskId: string): void;
}

/**
 * Canonical event kinds (single source of truth — see COMMENT_KINDS
 * note above). Adding a new kind: extend the list here, then a single
 * recompile narrows every reader (DB schema, store, prompt rendering,
 * web activity log).
 */
export const EVENT_KINDS = [
  "task_assigned",
  "status_changed",
  "dep_unblocked",
  "comment_added",
  "task_deleted",
  "scheduler_action",
  "task_completed_run",
  "ping_user",
  "ping_resolved",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * Inbox row kinds. `user_message` payload is a UIMessage; `system_notice`
 * payload is a small structured note rendered as text. Add new kinds
 * here; the renderer in agent-core branches on this enum.
 */
export const INBOX_KINDS = ["user_message", "system_notice"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const INBOX_SOURCES = ["user", "system"] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

export interface EventInput {
  /** Task this event is anchored to. Nullable for session-level events
   *  (e.g. `ping_user` where the agent is not currently on a task).
   *  At least one of (taskId, sessionId) must be set. */
  taskId?: string | null;
  /** Session this event is anchored to. Auto-derived from the task's
   *  current session_id if absent and taskId is present. Required for
   *  session-level events with no task anchor. */
  sessionId?: string | null;
  /** Semantic owner of the event (usually the assignee). Used for the
   *  prompt's "actor X" rendering when no explicit actor is recorded. */
  agentId: string;
  /**
   * Echo-suppression key, NOT a causation field. The scheduler suppresses
   * wake when `event.actor === sessionTarget.agentId` — i.e. "this agent's
   * own session should not wake from this event."
   *
   * When emitting a new event, pick the value by asking: would waking
   * the actor's own session here cause a runaway loop (agent acts → wakes
   * → acts again)? If yes, set `actor` to the actor's agent id. If no,
   * use `null` — every involved session, including the actor's own,
   * should wake.
   *
   * Causation and echo-target USUALLY coincide (status_changed,
   * comment_added — the agent did the thing in their session, no need
   * to wake themselves again). They DIVERGE for cross-session fan-out
   * events like `dep_unblocked`: the closer caused it, but the wake
   * target is a different session, so `actor: null` is correct
   * (otherwise same-agent cross-session deps never wake).
   */
  actor?: string | null;
  kind: EventKind;
  payload?: unknown;
}

export interface TaskEvent {
  id: string;
  taskId: string | null;
  sessionId: string | null;
  agentId: string;
  /** The actor that caused this event, if recorded. Null/undefined for
   *  anonymous / system events that should never be echo-suppressed. */
  actor?: string | null;
  kind: string;
  payload: string | null;
  createdAt: number;
}

export interface EventStorePort {
  append(input: EventInput): unknown;
  recentForTasks(taskIds: string[], sinceTs: number, limit?: number): TaskEvent[];
}
