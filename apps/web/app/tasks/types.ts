export type TaskStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "done"
  | "canceled";

// mirrored (not imported) — keep in sync with @openacme/tasks Recurrence
export type RecurrenceSession = "fresh" | "reuse";
export type Recurrence =
  | {
      kind: "cron";
      expr: string;
      tz?: string | null;
      until?: string | null;
      count?: number | null;
      session: RecurrenceSession;
    }
  | {
      kind: "interval";
      every_ms: number;
      until?: string | null;
      count?: number | null;
      session: RecurrenceSession;
    };

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string;
  session_id: string | null;
  created_by: string;
  parent_id: string | null;
  depends_on: string[];
  start_at: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  recurrence: Recurrence | null;
  runs: number;
  last_run_at: string | null;
  team: string | null;
  body?: string;
  /** Populated by GET /api/tasks (list); absent on GET /api/tasks/:id. */
  comment_count?: number;
}

export const STATUS_ORDER: TaskStatus[] = [
  "in_progress",
  "open",
  "blocked",
  "done",
  "canceled",
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  in_progress: "In progress",
  open: "Open",
  blocked: "Blocked",
  done: "Done",
  canceled: "Canceled",
};

export const STATUS_VARIANT: Record<
  TaskStatus,
  | "default"
  | "secondary"
  | "outline"
  | "destructive"
  | "signal"
  | "working"
  | "attention"
  | "elsewhere"
  | "healthy"
> = {
  // WORKING role — saturated blue chip; agent is doing the thing.
  in_progress: "working",
  open: "default",
  // WAIT role — amber chip. Distinct from canceled (terminal, outline).
  blocked: "attention",
  done: "secondary",
  canceled: "outline",
};

// sv-SE renders ISO-shape (YYYY-MM-DD HH:MM:SS) in the user's local TZ —
// locale-stable, no Z confusion, matches the engraved-faceplate register.
export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("sv-SE");
  } catch {
    return iso;
  }
}

export function formatAbsoluteFromUnix(unixSec: number): string {
  try {
    return new Date(unixSec * 1000).toLocaleString("sv-SE");
  } catch {
    return String(unixSec);
  }
}

// Re-exported from the central web mirror so kinds stay typed in one
// place (lib/types.ts mirrors the canonical defs in @openacme/tasks).
import type { CommentKind, EventKind } from "@/app/lib/types";
export type { CommentKind, EventKind } from "@/app/lib/types";

export interface Comment {
  id: string;
  taskId: string;
  author: string;
  kind: CommentKind | null;
  body: string;
  createdAt: number;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  agentId: string;
  /** Echo-suppression actor (agent id of causer) — null for
   *  scheduler / human / auto-effect events. */
  actor: string | null;
  kind: EventKind;
  payload: string | null;
  createdAt: number;
}

export function formatRelativeFromUnix(unixSec: number): string {
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (diffSec < 60) return `${diffSec}s ago`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Urgency tint for a due-at deadline. Overdue → destructive (red).
// Due within 24h → warn-ochre (WAIT cousin, less hot than destructive).
// Otherwise no chroma — distant dates stay mono. Caller passes the
// result as a className on the meta span; `undefined` keeps inherit.
export function dueUrgencyClass(
  iso: string | null | undefined
): string | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return undefined;
  const now = Date.now();
  if (ms < now) return "text-destructive";
  if (ms - now < 24 * 60 * 60 * 1000) return "text-warn-ochre";
  return undefined;
}

// Humanized future delta: "in 5m", "in 3h", "in 2d". For past timestamps,
// falls back to ISO via formatDate so callers don't have to branch.
export function formatRelativeFutureFromIso(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diffSec = Math.floor((ts - Date.now()) / 1000);
  if (diffSec <= 0) return formatDate(iso);
  if (diffSec < 60) return "in <1m";
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.floor(h / 24);
  return `in ${d}d`;
}

export function shortRecurrenceLabel(rec: Recurrence): string {
  if (rec.kind === "cron") {
    return rec.tz ? `${rec.expr} (${rec.tz})` : rec.expr;
  }
  return formatMs(rec.every_ms);
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `every ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `every ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `every ${h}h`;
  const d = Math.round(h / 24);
  return `every ${d}d`;
}
