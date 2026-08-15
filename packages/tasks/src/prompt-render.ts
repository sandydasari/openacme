/**
 * Markdown rendering for tasks — the "Tasks" and "Recent activity"
 * blocks in the agent's system prompt, plus event-payload summaries.
 *
 * Pure functions: take task data + lookups, return strings. No I/O.
 * TaskStore wraps these as methods for callers; tests can call them
 * directly.
 */

import type { Comment } from "./ports.js";
import { describeRecurrence } from "./recurrence.js";
import type { Task, TaskFrontmatter } from "./types.js";

export interface PromptRenderDeps {
  list: () => Task[];
  commentCounts: (taskIds: string[]) => Map<string, number>;
  latestNonSystemComment: (taskId: string) => Comment | null;
}

export function renderForPrompt(
  deps: PromptRenderDeps,
  agentId: string,
  currentSessionId: string,
  sessionExistsFn: (sid: string) => boolean,
  now: Date = new Date()
): string {
  const all = deps.list();
  const byId = new Map(all.map((t) => [t.id, t]));
  const mine = all.filter((t) => t.assignee === agentId);
  const createdByMe = all.filter(
    (t) =>
      t.created_by === agentId &&
      t.assignee !== agentId &&
      t.status !== "done" &&
      t.status !== "canceled"
  );

  const inThisSession = mine.filter(
    (t) => t.session_id === currentSessionId
  );

  const active = inThisSession.filter((t) => t.status === "in_progress");
  const queuedHere = inThisSession
    .filter(
      (t) =>
        t.status === "open" &&
        depsSatisfied(t.depends_on, byId) &&
        !isFutureStart(t.start_at, now)
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const scheduledLater = inThisSession
    .filter((t) => t.status === "open" && isFutureStart(t.start_at, now))
    .sort((a, b) => (a.start_at ?? "").localeCompare(b.start_at ?? ""));
  const blocked = inThisSession.filter((t) => t.status === "blocked");

  const otherSessions = mine.filter((t) => {
    if (t.session_id === currentSessionId) return false;
    if (t.status === "done" || t.status === "canceled") return false;
    if (!t.session_id) return false;
    return sessionExistsFn(t.session_id);
  });

  // Bulk-lookup comment counts so a queue of hundreds doesn't fan out.
  const visibleIds = new Set<string>();
  for (const t of [
    ...active,
    ...queuedHere,
    ...scheduledLater,
    ...blocked,
    ...otherSessions,
    ...createdByMe,
  ]) {
    visibleIds.add(t.id);
  }
  const counts = deps.commentCounts(Array.from(visibleIds));
  const tag = (t: Task): string => {
    const n = counts.get(t.id) ?? 0;
    return n > 0 ? ` (${n} comment${n === 1 ? "" : "s"})` : "";
  };

  const sections: string[] = [];

  if (active.length > 0) {
    sections.push(
      renderSection("Active in this session (currently working)", active, (t) => {
        const due = t.due_at ? ` (due ${t.due_at})` : "";
        return `- [${t.id}]${due} ${t.title}${recurrenceTag(t)}${tag(t)}`;
      })
    );
  }
  if (queuedHere.length > 0) {
    sections.push(
      renderSection(
        "Queued in this session (next up, in order)",
        queuedHere,
        (t) => `- [${t.id}] ${t.title}${recurrenceTag(t)}${tag(t)}`
      )
    );
  }
  if (scheduledLater.length > 0) {
    sections.push(
      renderSection(
        "Scheduled later (in this session, starts at T)",
        scheduledLater,
        (t) =>
          `- [${t.id}] starts ${t.start_at} — ${t.title}${recurrenceTag(t)}${tag(t)}`
      )
    );
  }
  if (blocked.length > 0) {
    sections.push(
      renderSection("Blocked on dependencies", blocked, (t) => {
        const unmet = t.depends_on.filter((d) => {
          const dep = byId.get(d);
          return !dep || dep.status !== "done";
        });
        return `- [${t.id}] ${t.title}${recurrenceTag(t)}${tag(t)} — waiting on [${unmet.join(", ")}]`;
      })
    );
  }
  if (otherSessions.length > 0) {
    sections.push(
      renderSection(
        "In another session (read-only awareness — don't re-handle)",
        otherSessions,
        (t) =>
          `- [${t.id}] ${t.title}${recurrenceTag(t)}${tag(t)} — bound to session ${t.session_id}`
      )
    );
  }
  if (createdByMe.length > 0) {
    // Recent-activity hint for delegated tasks — the only signal that
    // pulls assigners back when an assignee touches their work.
    sections.push(
      renderSection("Created by me, assigned to others", createdByMe, (t) => {
        const recent = deps.latestNonSystemComment(t.id);
        const hint = recent
          ? ` — last comment by ${recent.author} ${formatRelativeFrom(recent.createdAt, now)}${recent.kind ? ` (${recent.kind})` : ""}`
          : "";
        return `- [${t.id}] ${t.title}${recurrenceTag(t)}${tag(t)} — assignee ${t.assignee}, status ${t.status}${hint}`;
      })
    );
  }

  if (sections.length === 0) return "";
  return `${sections.join("\n\n")}\n\nNOTE: snapshot from session start. Call task_list for fresh state.`;
}

export function renderRecentActivity(
  events: import("./ports.js").TaskEvent[],
  titlesById: Map<string, string>,
  now: Date = new Date()
): string {
  if (events.length === 0) return "";
  const lines = events.map((e) => {
    const when = formatRelativeFrom(e.createdAt, now);
    const summary = summarizeEventPayload(e);
    const tail = summary ? ` — ${summary}` : "";
    if (!e.taskId) {
      // Session-level event with no task anchor. Format without the
      // bracketed task id; the kind + payload summary already carries
      // the context the agent needs.
      return `- ${when} · ${e.kind}${tail}`;
    }
    const title = titlesById.get(e.taskId) ?? "(unknown task)";
    return `- ${when} · ${e.kind} on [${e.taskId}] ${title}${tail}`;
  });
  return lines.join("\n");
}

export function summarizeEventPayload(
  e: import("./ports.js").TaskEvent
): string {
  if (!e.payload) return `actor ${e.agentId}`;
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(e.payload) as Record<string, unknown>;
  } catch {
    return `actor ${e.agentId}`;
  }
  switch (e.kind) {
    case "comment_added": {
      // `e.agentId` is the recipient (task assignee). The author is in
      // `payload.author` (or `e.actor` for non-system authors). Fall
      // back to `e.actor` for older events that pre-date the payload
      // change; treat null actor as "system".
      const author =
        (p.author && String(p.author)) || e.actor || "system";
      const lead = p.kind
        ? `${String(p.kind)} comment by ${author}`
        : `comment by ${author}`;
      const excerpt = p.excerpt ? String(p.excerpt) : "";
      return excerpt ? `${lead}: "${excerpt}"` : lead;
    }
    case "status_changed":
      return `${String(p.from ?? "?")} → ${String(p.to ?? "?")}`;
    case "dep_unblocked":
      return `dep ${String(p.blocked_by_task_id ?? "?")} done — now runnable`;
    case "task_assigned":
      return `assigned to ${String(p.assignee ?? "?")} by ${String(p.created_by ?? "?")}`;
    case "task_deleted":
      return p.forced ? `deleted (cascaded)` : `deleted`;
    case "scheduler_action": {
      const action = String(p.action ?? "?");
      const message = String(p.message ?? "");
      return message ? `[${action}] ${message}` : `[${action}]`;
    }
    case "task_completed_run": {
      const runs = p.runs != null ? String(p.runs) : "?";
      const next = p.next_fire ? ` — next fire ${String(p.next_fire)}` : "";
      return `run ${runs} done${next}`;
    }
    case "ping_user": {
      const excerpt = p.message ? String(p.message).slice(0, 80) : "";
      return excerpt
        ? `${e.agentId} pinged user: "${excerpt}"`
        : `${e.agentId} pinged user`;
    }
    case "ping_resolved": {
      const by = (p.resolvedBy && String(p.resolvedBy)) || e.actor || "system";
      const reason = p.reason ? `: "${String(p.reason).slice(0, 80)}"` : "";
      return `ping closed by ${by}${reason}`;
    }
    default:
      return `actor ${e.agentId}`;
  }
}

// ── Internals ───────────────────────────────────────────────────────

function renderSection<T>(
  title: string,
  items: T[],
  fmt: (t: T) => string
): string {
  return `${title}:\n${items.map(fmt).join("\n")}`;
}

function recurrenceTag(t: Task): string {
  if (!t.recurrence) return "";
  return ` (${describeRecurrence(t.recurrence)}, ran ${t.runs}×)`;
}

function formatRelativeFrom(unixSeconds: number, now: Date): string {
  const diffSec = Math.max(0, Math.floor(now.getTime() / 1000 - unixSeconds));
  if (diffSec < 60) return `${diffSec}s ago`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function isFutureStart(startAt: string | null, now: Date): boolean {
  if (!startAt) return false;
  const t = Date.parse(startAt);
  if (!Number.isFinite(t)) return false;
  return t > now.getTime();
}

function depsSatisfied(
  deps: string[],
  byId: Map<string, TaskFrontmatter>
): boolean {
  for (const d of deps) {
    const dep = byId.get(d);
    if (!dep) return false;
    if (dep.status !== "done") return false;
  }
  return true;
}
