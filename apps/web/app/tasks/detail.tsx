"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Save,
  Trash2,
  X,
  Copy,
  Check,
  Unlink,
  ChevronDown,
  Search,
} from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { Label } from "@/app/components/ui/label";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { Badge } from "@/app/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { DateTimePicker } from "@/app/components/ui/date-time-picker";
import { Markdown } from "@/app/components/Markdown";
import { cn } from "@/app/lib/utils";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  STATUS_VARIANT,
  formatAbsoluteFromUnix,
  formatDate,
  formatRelativeFromUnix,
  type Comment,
  type Recurrence,
  type RecurrenceSession,
  type Task,
  type TaskEvent,
  type TaskStatus,
} from "./types";
import { API_BASE } from "@/app/lib/api";

export interface AgentOption {
  id: string;
  name: string;
}

export interface TaskDetailPanelProps {
  selected: Task;
  draft: Task;
  saving: boolean;
  dirty: boolean;
  agents: AgentOption[];
  /** Full task list (for resolving dep / parent ids to titles). */
  tasks: Task[];
  onChange: (next: Task) => void;
  onSave: () => void;
  onDeleteClick: () => void;
  /** When provided, renders a close X in the header (modal use). */
  onClose?: () => void;
}


export function TaskDetailPanel({
  selected,
  draft,
  saving,
  dirty,
  agents,
  tasks,
  onChange,
  onSave,
  onDeleteClick,
  onClose,
}: TaskDetailPanelProps) {
  const titleByDepId = useMemo(
    () => new Map(tasks.map((t) => [t.id, t.title])),
    [tasks]
  );
  const [copiedTask, setCopiedTask] = useState(false);
  const [copiedSession, setCopiedSession] = useState(false);

  const copy = async (text: string, mark: (b: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      mark(true);
      window.setTimeout(() => mark(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const shortTaskId = selected.id.slice(0, 8);
  const sessionId = draft.session_id;
  const shortSession = sessionId ? sessionId.slice(0, 8) : null;
  const assigneeKnown = agents.some((a) => a.id === draft.assignee);

  return (
    <>
      {/* Fixed header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-paper-rule px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Task
          </span>
          <button
            type="button"
            onClick={() => void copy(selected.id, setCopiedTask)}
            title={`Copy ${selected.id}`}
            aria-label="Copy task ID"
            className="group flex items-center gap-1.5 font-mono text-[12px] tabular-nums text-ink-soft transition-colors hover:text-plot-red focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red"
          >
            <span>{shortTaskId}</span>
            {copiedTask ? (
              <Check className="size-3 text-plot-red" />
            ) : (
              <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost-destructive" disabled={saving} onClick={onDeleteClick}>
            <Trash2 className="size-4" />
            Delete
          </Button>
          <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
            {saving ? (
              <LoadingHairline inline />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="ml-1 p-1 text-ink-soft transition-colors hover:text-plot-red focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select
              value={draft.status}
              onValueChange={(v) =>
                onChange({ ...draft, status: v as TaskStatus })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="assignee">Assignee</Label>
            <AgentCombobox
              agents={agents}
              value={draft.assignee}
              onChange={(id) => onChange({ ...draft, assignee: id })}
            />
            {!assigneeKnown && draft.assignee && (
              <p className="font-mono text-[11px] text-ink-faint">
                Current assignee no longer exists — pick a known agent.
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="start_at">Start at</Label>
            <DateTimePicker
              id="start_at"
              value={draft.start_at}
              onChange={(iso) => onChange({ ...draft, start_at: iso })}
              placeholder="Pick start"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="due_at">Due at</Label>
            <DateTimePicker
              id="due_at"
              value={draft.due_at}
              onChange={(iso) => onChange({ ...draft, due_at: iso })}
              placeholder="Pick due"
            />
          </div>
        </div>

        <SessionIdField
          sessionId={sessionId}
          shortSession={shortSession}
          copiedSession={copiedSession}
          onCopy={() => sessionId && void copy(sessionId, setCopiedSession)}
          onUnbind={() => onChange({ ...draft, session_id: null })}
        />

        <RecurrenceEditor
          value={draft.recurrence}
          onChange={(rec) => onChange({ ...draft, recurrence: rec })}
          runs={selected.runs}
          lastRunAt={selected.last_run_at}
          nextStartAt={selected.start_at}
        />

        <div className="space-y-1.5">
          <Label htmlFor="body">Body</Label>
          <Textarea
            id="body"
            rows={12}
            value={draft.body ?? ""}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
          />
        </div>

        <ActivityTimeline
          taskId={selected.id}
          agents={agents}
          titleByDepId={titleByDepId}
        />
      </div>

      {/* Fixed footer with audit metadata */}
      <div className="grid shrink-0 grid-cols-[auto_1fr_auto_1fr] items-baseline gap-x-5 gap-y-1 border-t border-paper-rule bg-paper-sunk px-5 py-3 font-mono text-[12px] tabular-nums">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          By
        </span>
        <span className="truncate text-ink-soft">
          {selected.created_by}
          {selected.team && ` · #${selected.team}`}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Created
        </span>
        <span className="text-ink-soft">{formatDate(selected.created_at)}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Updated
        </span>
        <span className="text-ink-soft">{formatDate(selected.updated_at)}</span>
        {selected.closed_at && (
          <>
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Closed
            </span>
            <span className="text-ink-soft">{formatDate(selected.closed_at)}</span>
          </>
        )}
        {selected.depends_on.length > 0 && (
          <>
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Deps
            </span>
            <span className="col-span-3 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-ink-soft">
              {selected.depends_on.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-baseline gap-1.5"
                >
                  <span className="text-ink-soft">{id.slice(0, 8)}</span>
                  <span className="truncate text-ink-faint">
                    {titleByDepId.get(id) ?? "(unknown)"}
                  </span>
                </span>
              ))}
            </span>
          </>
        )}
        {selected.parent_id && (
          <>
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Parent
            </span>
            <span className="col-span-3 inline-flex min-w-0 items-baseline gap-1.5 text-ink-soft">
              <span>{selected.parent_id.slice(0, 8)}</span>
              <span className="truncate text-ink-faint">
                {titleByDepId.get(selected.parent_id) ?? "(unknown)"}
              </span>
            </span>
          </>
        )}
      </div>

    </>
  );
}

/**
 * Unified activity feed for a task: comments (markdown) + signal events
 * interleaved chronologically. `comment_added` events are dropped because
 * they duplicate the comment row itself. The composer posts as
 * `system:user` — the route locks author/kind regardless of body, so we
 * don't expose forge-as-agent UI here.
 */
function ActivityTimeline({
  taskId,
  agents,
  titleByDepId,
}: {
  taskId: string;
  agents: AgentOption[];
  titleByDepId: Map<string, string>;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftBody, setDraftBody] = useState("");
  const [posting, setPosting] = useState(false);
  // Only items newer than the panel's first paint animate in — keeps the
  // initial render from animating the whole stack.
  const mountedAtRef = useRef<number>(Math.floor(Date.now() / 1000));

  useEffect(() => {
    let cancelled = false;
    async function load(initial: boolean) {
      try {
        const [c, e] = await Promise.all([
          fetch(`${API_BASE}/api/tasks/${taskId}/comments`).then((r) =>
            r.json()
          ),
          fetch(`${API_BASE}/api/tasks/${taskId}/events`).then((r) => r.json()),
        ]);
        if (cancelled) return;
        setComments((c.comments ?? []) as Comment[]);
        setEvents((e.events ?? []) as TaskEvent[]);
      } catch {
        // Network burp — leave stale data on screen, retry on next poll.
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    }
    void load(true);
    const id = setInterval(() => void load(false), 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [taskId]);

  async function postComment() {
    if (!draftBody.trim() || posting) return;
    setPosting(true);
    try {
      const r = await fetch(`${API_BASE}/api/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: draftBody }),
      });
      if (r.ok) {
        const { comment } = (await r.json()) as { comment: Comment };
        setComments((prev) => [...prev, comment]);
        setDraftBody("");
      }
    } finally {
      setPosting(false);
    }
  }

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.name);
    return m;
  }, [agents]);

  const items = useMemo(() => mergeActivity(comments, events), [comments, events]);

  return (
    <section className="space-y-3 border-t border-paper-rule pt-5">
      <div className="flex items-baseline justify-between">
        <h3 className="label-faceplate">Activity</h3>
        {items.length > 0 && (
          <span className="font-mono text-[11px] tabular-nums text-ink-faint">
            {items.length}
          </span>
        )}
      </div>

      {loading && items.length === 0 ? (
        <p className="font-mono text-[11px] text-ink-faint">Loading…</p>
      ) : items.length === 0 ? (
        <p className="font-mono text-[11px] text-ink-faint">No activity yet.</p>
      ) : (
        <ol className="space-y-3">
          {items.map((it) => {
            const isFresh = it.ts > mountedAtRef.current;
            const key =
              it.kind === "comment" ? `c:${it.comment.id}` : `e:${it.event.id}`;
            return (
              <li key={key} className={isFresh ? "section-enter" : undefined}>
                {it.kind === "comment" ? (
                  it.comment.kind === "result" ? (
                    <ResultRow
                      comment={it.comment}
                      author={resolveAuthor(it.comment.author, agentMap)}
                    />
                  ) : it.comment.kind === "system" ? (
                    <SystemCommentRow
                      comment={it.comment}
                      author={resolveAuthor(it.comment.author, agentMap)}
                    />
                  ) : (
                    <CommentRow
                      comment={it.comment}
                      author={resolveAuthor(it.comment.author, agentMap)}
                    />
                  )
                ) : (
                  <EventRow
                    event={it.event}
                    titleByDepId={titleByDepId}
                    agentMap={agentMap}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}

      <Composer
        draftBody={draftBody}
        onChange={setDraftBody}
        onPost={postComment}
        posting={posting}
      />
    </section>
  );
}

// ── Activity row variants ──────────────────────────────────────────

interface ResolvedAuthor {
  kind: "agent" | "user" | "system" | "unknown";
  handle: string;
}

// Disambiguation: agents render as `@<handle>` (regular ink), non-agent
// authors render as `<handle>` italic without `@`. An agent literally
// named "user" therefore reads as `@user` and stays distinct from the
// human user (which renders as plain italic `user`). All `system:*`
// actors other than `system:user` collapse to the `system` handle —
// callers that need finer detail (e.g., scheduler_action message body)
// surface it via the description, not the actor label.
function resolveAuthor(
  id: string,
  agentMap: Map<string, string>
): ResolvedAuthor {
  if (id === "system:user") return { kind: "user", handle: "user" };
  if (id.startsWith("system:")) return { kind: "system", handle: "system" };
  if (agentMap.has(id)) return { kind: "agent", handle: id };
  return { kind: "unknown", handle: id.slice(0, 8) };
}

function AuthorChip({ author }: { author: ResolvedAuthor }) {
  const isAgent = author.kind === "agent";
  return (
    <span
      className={cn(
        "font-mono text-[11px]",
        isAgent ? "text-ink" : "italic text-ink-soft"
      )}
    >
      {isAgent ? `@${author.handle}` : author.handle}
    </span>
  );
}

function CommentRow({
  comment,
  author,
}: {
  comment: Comment;
  author: ResolvedAuthor;
}) {
  return (
    <div className="grid grid-cols-[12px_1fr] gap-x-3">
      <div aria-hidden className="relative flex justify-center">
        <span className="mt-[10px] inline-block size-[5px] bg-paper-rule" />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <AuthorChip author={author} />
          <span className="text-ink-faint">·</span>
          <span
            className="font-mono text-[11px] tabular-nums text-ink-faint"
            title={formatAbsoluteFromUnix(comment.createdAt)}
          >
            {formatRelativeFromUnix(comment.createdAt)}
          </span>
        </div>
        <div className="mt-1 max-w-prose border-l border-paper-rule pl-3 text-sm text-ink">
          <Markdown>{comment.body}</Markdown>
        </div>
      </div>
    </div>
  );
}

function ResultRow({
  comment,
  author,
}: {
  comment: Comment;
  author: ResolvedAuthor;
}) {
  return (
    <div className="grid grid-cols-[12px_1fr] gap-x-3">
      <div aria-hidden className="flex justify-center">
        <span className="w-[2px] self-stretch bg-plot-red" />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Badge variant="signal">Result</Badge>
          <AuthorChip author={author} />
          <span className="text-ink-faint">·</span>
          <span
            className="font-mono text-[11px] tabular-nums text-ink-faint"
            title={formatAbsoluteFromUnix(comment.createdAt)}
          >
            {formatRelativeFromUnix(comment.createdAt)}
          </span>
        </div>
        <div className="mt-1.5 max-w-prose text-sm text-ink">
          <Markdown>{comment.body}</Markdown>
        </div>
      </div>
    </div>
  );
}

function SystemCommentRow({
  comment,
  author,
}: {
  comment: Comment;
  author: ResolvedAuthor;
}) {
  return (
    <div className="grid grid-cols-[12px_1fr] gap-x-3">
      <div aria-hidden className="flex justify-center">
        <span className="mt-[10px] inline-block size-[3px] bg-ink-faint" />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] italic">
          <span className="text-ink-soft">{author.handle}</span>
          <span className="text-ink-faint">·</span>
          <span
            className="tabular-nums text-ink-faint"
            title={formatAbsoluteFromUnix(comment.createdAt)}
          >
            {formatRelativeFromUnix(comment.createdAt)}
          </span>
        </div>
        <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[12px] italic text-ink-soft">
          {comment.body}
        </div>
      </div>
    </div>
  );
}

function EventRow({
  event,
  titleByDepId,
  agentMap,
}: {
  event: TaskEvent;
  titleByDepId: Map<string, string>;
  agentMap: Map<string, string>;
}) {
  const payload = parseEventPayload(event.payload);
  const actor = resolveEventActor(event, payload, agentMap);
  return (
    <div className="grid grid-cols-[12px_1fr] items-center gap-x-3">
      <div aria-hidden className="flex justify-center">
        <span className="font-mono text-[11px] leading-none text-ink-faint">›</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[12px] tabular-nums text-ink-soft">
        {actor && (
          <>
            <span
              className={cn(
                actor.kind === "agent"
                  ? "text-ink"
                  : "italic text-ink-soft"
              )}
            >
              {actor.kind === "agent" ? `@${actor.handle}` : actor.handle}
            </span>
            <span className="text-ink-faint">·</span>
          </>
        )}
        <span
          className="text-ink-faint"
          title={formatAbsoluteFromUnix(event.createdAt)}
        >
          {formatRelativeFromUnix(event.createdAt)}
        </span>
        <span className="text-ink-faint">·</span>
        <EventDescription
          event={event}
          payload={payload}
          titleByDepId={titleByDepId}
        />
      </div>
    </div>
  );
}

// Agent handle for inline references in event descriptions (e.g.
// "assigned to @<assignee>"). Strips the `system:` prefix; callers
// decide whether to prepend `@` (agents) or not (system actors).
function resolveAgentHandle(id: string | undefined): string {
  if (!id) return "?";
  if (id.startsWith("system:"))
    return id.slice("system:".length) || "system";
  return id;
}

// Leading speaker per event row. `event.actor` is the canonical source,
// but a couple of kinds null it out (task_assigned echo-suppresses;
// some scheduler emits don't set it). Derive from payload / event kind
// so every row leads with a consistent speaker.
function resolveEventActor(
  event: TaskEvent,
  payload: Record<string, unknown> | null,
  agentMap: Map<string, string>
): ResolvedAuthor | null {
  if (event.actor) return resolveAuthor(event.actor, agentMap);
  if (event.kind === "task_assigned") {
    const createdBy = payload?.created_by as string | undefined;
    if (createdBy) return resolveAuthor(createdBy, agentMap);
  }
  if (event.kind === "scheduler_action") {
    return { kind: "system", handle: "system" };
  }
  return null;
}

function EventDescription({
  event,
  payload,
  titleByDepId,
}: {
  event: TaskEvent;
  payload: Record<string, unknown> | null;
  titleByDepId: Map<string, string>;
}) {
  switch (event.kind) {
    case "status_changed": {
      const from = (payload?.from as TaskStatus | undefined) ?? undefined;
      const to = (payload?.to as TaskStatus | undefined) ?? undefined;
      if (!from || !to)
        return <span className="text-ink">status changed</span>;
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            status
          </span>
          <Badge variant={STATUS_VARIANT[from]}>{STATUS_LABEL[from]}</Badge>
          <span className="text-ink-faint">→</span>
          <Badge variant={STATUS_VARIANT[to]}>{STATUS_LABEL[to]}</Badge>
        </span>
      );
    }
    case "dep_unblocked": {
      const depId = payload?.blocked_by_task_id as string | undefined;
      const depTitle = depId ? titleByDepId.get(depId) : undefined;
      return (
        <span className="flex flex-wrap items-baseline gap-1">
          <span className="text-ink-faint">dep</span>
          <span className="text-ink-soft">
            {depId ? depId.slice(0, 8) : "?"}
          </span>
          {depTitle && <span className="text-ink">{depTitle}</span>}
          <span className="text-ink-faint">done, now runnable</span>
        </span>
      );
    }
    case "task_assigned": {
      const assignee = resolveAgentHandle(payload?.assignee as string | undefined);
      return (
        <span>
          assigned to <span className="text-ink">@{assignee}</span>
        </span>
      );
    }
    case "task_deleted": {
      const forced = payload?.forced === true;
      return (
        <span className="italic text-ink-faint">
          {forced ? "deleted (cascaded)" : "deleted"}
        </span>
      );
    }
    case "scheduler_action": {
      const action = payload?.action as string | undefined;
      const message = payload?.message as string | undefined;
      const text = message ?? action ?? "scheduler action";
      return <span className="italic text-ink-soft">{text}</span>;
    }
    case "task_completed_run": {
      const runs = payload?.runs as number | undefined;
      const next = payload?.next_fire as string | undefined;
      return (
        <span>
          run {runs ?? "?"} complete
          {next && <span className="text-ink-faint"> — next fire {next}</span>}
        </span>
      );
    }
    default:
      return <span className="text-ink">{event.kind}</span>;
  }
}

function Composer({
  draftBody,
  onChange,
  onPost,
  posting,
}: {
  draftBody: string;
  onChange: (v: string) => void;
  onPost: () => void;
  posting: boolean;
}) {
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (draftBody.trim() && !posting) onPost();
    }
  };
  return (
    <div className="space-y-2 border-t border-paper-rule pt-4">
      <Textarea
        value={draftBody}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        placeholder="Leave a comment — markdown supported"
        rows={3}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] text-ink-faint">
          ⌘ + ↵ to send
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={onPost}
          disabled={!draftBody.trim() || posting}
        >
          {posting ? "Posting" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

// ── Activity helpers ───────────────────────────────────────────────

type ActivityItem =
  | { kind: "comment"; ts: number; comment: Comment }
  | { kind: "event"; ts: number; event: TaskEvent };

function mergeActivity(
  comments: Comment[],
  events: TaskEvent[]
): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const c of comments) {
    items.push({ kind: "comment", ts: c.createdAt, comment: c });
  }
  for (const e of events) {
    if (e.kind === "comment_added") continue;
    items.push({ kind: "event", ts: e.createdAt, event: e });
  }
  items.sort((a, b) => a.ts - b.ts);
  return items;
}

function parseEventPayload(
  payload: string | null
): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const v = JSON.parse(payload);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function AgentCombobox({
  agents,
  value,
  onChange,
}: {
  agents: AgentOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = agents.find((a) => a.id === value) ?? null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? agents.filter(
        (a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
      )
    : agents;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Reset filter + focus input on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep highlight in range as filter changes
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Scroll highlighted item into view
  useEffect(() => {
    const el = listRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick_ = filtered[highlight];
      if (pick_) pick(pick_.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        id="assignee"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 border border-paper-rule bg-paper px-3 text-left text-sm text-ink outline-none transition-colors hover:bg-paper-sunk focus-visible:border-plot-red",
          !selected && "text-ink-faint"
        )}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {selected ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{selected.name}</span>
            <span className="font-mono text-[11px] text-ink-faint">
              {selected.id.slice(0, 8)}
            </span>
          </span>
        ) : value ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-[12px]">{value.slice(0, 8)}</span>
            <span className="font-mono text-[11px] text-ink-faint">(unknown)</span>
          </span>
        ) : (
          <span className="text-ink-faint">Unassigned</span>
        )}
        <ChevronDown className="size-4 shrink-0 text-ink-faint" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 border border-paper-rule bg-paper">
          <div className="flex items-center gap-2 border-b border-paper-rule px-2.5 py-1.5">
            <Search className="size-3.5 shrink-0 text-ink-faint" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder="Search agents…"
              className="h-7 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
          </div>
          <div ref={listRef} className="max-h-56 overflow-y-auto py-1" role="listbox">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                No matches
              </div>
            ) : (
              filtered.map((a, i) => {
                const isHi = i === highlight;
                const isSel = a.id === value;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => pick(a.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition-colors",
                      isHi ? "bg-paper-sunk text-ink" : "text-ink-soft"
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{a.name}</span>
                      <span className="font-mono text-[11px] text-ink-faint">
                        {a.id.slice(0, 8)}
                      </span>
                    </span>
                    {isSel && <Check className="size-3.5 shrink-0 text-plot-red" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionIdField({
  sessionId,
  shortSession,
  copiedSession,
  onCopy,
  onUnbind,
}: {
  sessionId: string | null;
  shortSession: string | null;
  copiedSession: boolean;
  onCopy: () => void;
  onUnbind: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>Session</Label>
      {sessionId ? (
        <div className="flex h-9 items-center justify-between border border-paper-rule bg-paper px-3">
          <button
            type="button"
            onClick={onCopy}
            title={`Copy ${sessionId}`}
            aria-label="Copy session ID"
            className="group flex items-center gap-1.5 font-mono text-[12px] tabular-nums text-ink-soft transition-colors hover:text-plot-red focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red"
          >
            <span>{shortSession}</span>
            {copiedSession ? (
              <Check className="size-3 text-plot-red" />
            ) : (
              <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
          <button
            type="button"
            onClick={onUnbind}
            className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint transition-colors hover:text-plot-red focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red"
          >
            <Unlink className="size-3" />
            Unbind
          </button>
        </div>
      ) : (
        <div className="flex h-9 items-center border border-dashed border-paper-rule bg-paper px-3 font-mono text-[12px] text-ink-faint">
          unbound — scheduler will allocate on next ready tick
        </div>
      )}
    </div>
  );
}

type RecurrenceKind = "none" | "cron" | "interval";

const INTERVAL_UNITS: { value: "m" | "h" | "d"; label: string; ms: number }[] = [
  { value: "m", label: "min", ms: 60_000 },
  { value: "h", label: "hr", ms: 3_600_000 },
  { value: "d", label: "day", ms: 86_400_000 },
];

function msToInterval(ms: number): { n: number; unit: "m" | "h" | "d" } {
  if (ms > 0 && ms % 86_400_000 === 0) return { n: ms / 86_400_000, unit: "d" };
  if (ms > 0 && ms % 3_600_000 === 0) return { n: ms / 3_600_000, unit: "h" };
  return { n: Math.max(1, Math.round(ms / 60_000)), unit: "m" };
}

function intervalToMs(n: number, unit: "m" | "h" | "d"): number {
  const u = INTERVAL_UNITS.find((x) => x.value === unit);
  return Math.max(60_000, Math.floor((u?.ms ?? 60_000) * Math.max(1, n)));
}

function RecurrenceEditor({
  value,
  onChange,
  runs,
  lastRunAt,
  nextStartAt,
}: {
  value: Recurrence | null;
  onChange: (rec: Recurrence | null) => void;
  runs: number;
  lastRunAt: string | null;
  nextStartAt: string | null;
}) {
  const kind: RecurrenceKind = value ? value.kind : "none";

  const setKind = (k: RecurrenceKind) => {
    if (k === "none") {
      onChange(null);
      return;
    }
    if (k === "cron") {
      onChange({
        kind: "cron",
        expr: value && value.kind === "cron" ? value.expr : "0 9 * * *",
        tz: value && value.kind === "cron" ? (value.tz ?? null) : null,
        until: value?.until ?? null,
        count: value?.count ?? null,
        session: value?.session ?? "fresh",
      });
      return;
    }
    onChange({
      kind: "interval",
      every_ms:
        value && value.kind === "interval" ? value.every_ms : 60 * 60 * 1000,
      until: value?.until ?? null,
      count: value?.count ?? null,
      session: value?.session ?? "fresh",
    });
  };

  return (
    <div className="space-y-3 bg-paper-sunk px-4 py-4">
      <SectionEyebrow rule={false}>Recurrence</SectionEyebrow>
      <Select value={kind} onValueChange={(v) => setKind(v as RecurrenceKind)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">None</SelectItem>
          <SelectItem value="cron">Cron</SelectItem>
          <SelectItem value="interval">Interval</SelectItem>
        </SelectContent>
      </Select>

      {value && value.kind === "cron" && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="rec-expr">Expression</Label>
            <Input
              id="rec-expr"
              placeholder="0 9 * * 1-5"
              value={value.expr}
              onChange={(e) => onChange({ ...value, expr: e.target.value })}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rec-tz">Timezone</Label>
            <div className="flex gap-2">
              <Input
                id="rec-tz"
                placeholder="America/Los_Angeles"
                value={value.tz ?? ""}
                onChange={(e) =>
                  onChange({ ...value, tz: e.target.value || null })
                }
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  try {
                    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                    onChange({ ...value, tz });
                  } catch {
                    /* unavailable */
                  }
                }}
                title="Use system timezone"
              >
                System
              </Button>
            </div>
          </div>
        </div>
      )}

      {value && value.kind === "interval" && (
        <IntervalRow
          everyMs={value.every_ms}
          onChange={(ms) => onChange({ ...value, every_ms: ms })}
        />
      )}

      {value && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="rec-until">Until</Label>
              <DateTimePicker
                id="rec-until"
                value={value.until ?? null}
                onChange={(iso) => onChange({ ...value, until: iso })}
                placeholder="No end date"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rec-count">Count cap</Label>
              <Input
                id="rec-count"
                type="number"
                min={1}
                placeholder="(unlimited)"
                value={value.count ?? ""}
                onChange={(e) =>
                  onChange({
                    ...value,
                    count: e.target.value ? Number(e.target.value) : null,
                  })
                }
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Session strategy</Label>
            <Select
              value={value.session}
              onValueChange={(v) =>
                onChange({ ...value, session: v as RecurrenceSession })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fresh">
                  Fresh — new session each fire
                </SelectItem>
                <SelectItem value="reuse">
                  Reuse — continue same session (context accumulates)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-3 gap-4 border-t border-paper-rule pt-3 font-mono text-[12px] tabular-nums">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Runs
              </div>
              <div className="text-ink">{runs}</div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Last run
              </div>
              <div className="text-ink-soft">{lastRunAt ? formatDate(lastRunAt) : "—"}</div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Next fire
              </div>
              <div className="text-ink-soft">{nextStartAt ? formatDate(nextStartAt) : "—"}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function IntervalRow({
  everyMs,
  onChange,
}: {
  everyMs: number;
  onChange: (ms: number) => void;
}) {
  const { n, unit } = msToInterval(everyMs);
  return (
    <div className="space-y-1.5">
      <Label htmlFor="rec-every-n">Every</Label>
      <div className="flex gap-2">
        <Input
          id="rec-every-n"
          type="number"
          min={1}
          value={n}
          onChange={(e) =>
            onChange(intervalToMs(Number(e.target.value) || 1, unit))
          }
          className="w-32"
        />
        <Select
          value={unit}
          onValueChange={(v) => onChange(intervalToMs(n, v as "m" | "h" | "d"))}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTERVAL_UNITS.map((u) => (
              <SelectItem key={u.value} value={u.value}>
                {u.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="font-mono text-[11px] text-ink-faint">
        Minimum 1 minute. Server enforces this floor.
      </p>
    </div>
  );
}
