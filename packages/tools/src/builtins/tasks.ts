import { z } from "zod";
import {
  COMMENT_KINDS,
  TASK_STATUSES,
  TaskStore,
  TaskStoreError,
  type CommentKind,
  type Recurrence,
  type Task,
  type TaskStatus,
} from "@openacme/tasks";
import { registry } from "../registry.js";
import { getCurrentAgentId, getCurrentSessionId } from "../session-context.js";

// Recurrence shape for tool params — describes the same data as
// @openacme/tasks RecurrenceSchema but with prose `.describe()` strings
// the LLM can read off the tool spec.
const RecurrenceParamsSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cron"),
      expr: z
        .string()
        .min(1)
        .describe(
          'Cron expression, e.g. "0 9 * * 1-5" (every weekday 9am).'
        ),
      tz: z
        .string()
        .nullable()
        .optional()
        .describe('IANA timezone, e.g. "America/Los_Angeles". Optional.'),
      until: z
        .string()
        .nullable()
        .optional()
        .describe("ISO 8601 stop time. Optional."),
      count: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("Stop after this many successful completions. Optional."),
      session: z
        .enum(["fresh", "reuse"])
        .default("fresh")
        .describe(
          '"fresh" (default) creates a new session for each fire — clean isolation. ' +
            '"reuse" continues in the same session — context accumulates across fires.'
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interval"),
      every_ms: z
        .number()
        .int()
        .min(60_000)
        .describe(
          "Milliseconds between fires. Minimum 60000 (1 minute)."
        ),
      until: z.string().nullable().optional(),
      count: z.number().int().positive().nullable().optional(),
      session: z.enum(["fresh", "reuse"]).default("fresh"),
    })
    .strict(),
]);

export interface TaskStoreBindings {
  store: TaskStore;
}

let bindings: TaskStoreBindings | null = null;

export function bindTaskStore(b: TaskStoreBindings): void {
  bindings = b;
}

function requireBindings(): TaskStoreBindings | { error: string } {
  if (!bindings) {
    return {
      error: "tasks not initialized — AgentManager must call bindTaskStore().",
    };
  }
  return bindings;
}

function frontmatterOnly(t: Task) {
  const { body: _body, ...rest } = t;
  void _body;
  return rest;
}

// ── task_list ────────────────────────────────────────────────────────

const TASK_LIST_DESCRIPTION =
  "List tasks. Defaults to YOUR open tasks (assignee = you, excluding done/canceled). " +
  "Pass `assignee` to query another agent's queue, or `status` to filter. " +
  "Returns frontmatter only — call task_view for the full body.";

registry.register({
  name: "task_list",
  toolset: "tasks",
  description: TASK_LIST_DESCRIPTION,
  parameters: z.object({
    assignee: z
      .string()
      .optional()
      .describe("Agent id to filter by. Defaults to the current agent."),
    status: z
      .union([z.enum(TASK_STATUSES), z.array(z.enum(TASK_STATUSES))])
      .optional()
      .describe("Status filter. Defaults to non-terminal (open, in_progress, blocked)."),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Max number of results. Default 50."),
  }),
  emoji: "📋",
  parallelSafe: true,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });

    const a = args as {
      assignee?: string;
      status?: TaskStatus | TaskStatus[];
      limit?: number;
    };
    const agentId = getCurrentAgentId();
    const assignee = a.assignee ?? agentId;
    if (!assignee) {
      return JSON.stringify({
        ok: false,
        error: "task_list requires an active agent context or explicit assignee.",
      });
    }

    const status: TaskStatus[] | undefined = a.status
      ? Array.isArray(a.status)
        ? a.status
        : [a.status]
      : (["open", "in_progress", "blocked"] as TaskStatus[]);

    const all = b.store.list({ assignee, status });
    const limited = all.slice(0, a.limit ?? 50);
    return JSON.stringify({
      ok: true,
      count: limited.length,
      total: all.length,
      tasks: limited.map(frontmatterOnly),
    });
  },
});

// ── task_view ────────────────────────────────────────────────────────

const TASK_VIEW_DESCRIPTION =
  "Read a task by id. Returns frontmatter + the full markdown body (description / notes).";

registry.register({
  name: "task_view",
  toolset: "tasks",
  description: TASK_VIEW_DESCRIPTION,
  parameters: z.object({
    id: z.string().min(1).describe("Task id."),
  }),
  emoji: "🔍",
  parallelSafe: true,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });

    const a = args as { id: string };
    const task = b.store.get(a.id);
    if (!task) {
      return JSON.stringify({ ok: false, error: `Task ${a.id} not found.` });
    }
    return JSON.stringify({ ok: true, task });
  },
});

// ── task_create ──────────────────────────────────────────────────────

const TASK_CREATE_DESCRIPTION =
  "Create a task. The current agent is recorded as `created_by`.\n\n" +
  "`session` (where the work lives):\n" +
  "- `\"current\"` — bind to YOUR current session. Only valid when assignee == you; otherwise rejected.\n" +
  "- `\"fresh\"` — explicitly request a brand-new session. The scheduler allocates one when the task becomes ready.\n" +
  "- A specific session uuid — bind to that session (advanced; you usually don't need this).\n" +
  "- Omit it — smart default: `\"current\"` when self-assigning, `\"fresh\"` otherwise.\n\n" +
  "When to choose: pass `\"current\"` for a task you intend to work on RIGHT NOW in this same turn. " +
  "Pass `\"fresh\"` (or omit) for future work, or any cross-agent delegation. Picking wrong creates session races.\n\n" +
  "Use `start_at` (ISO timestamp) to schedule a future autonomous start. " +
  "Use `depends_on` to gate this task on others (cycle-checked; unmet deps force `blocked`).\n\n" +
  "RECURRING TASKS: pass `recurrence` to fire on a schedule. When you mark a recurring " +
  "task `done` via task_update, it self-resets to `open` with the next fire time — the " +
  "returned status will be `open`, not `done`. Use `status: \"canceled\"` to stop a " +
  "recurrence permanently. Choose `recurrence.session: \"reuse\"` to keep context across " +
  "fires (one ongoing session) or `\"fresh\"` (default) for clean isolation each fire.";

registry.register({
  name: "task_create",
  toolset: "tasks",
  description: TASK_CREATE_DESCRIPTION,
  parameters: z.object({
    title: z.string().min(1).max(500).describe("Short, action-oriented title."),
    assignee: z
      .string()
      .min(1)
      .describe("Agent id to do the work. Required — no unassigned tasks."),
    body: z
      .string()
      .optional()
      .describe(
        "Markdown description / acceptance criteria / working notes."
      ),
    parent_id: z
      .string()
      .optional()
      .describe("Parent task id (for subtask hierarchy)."),
    depends_on: z
      .array(z.string())
      .optional()
      .describe(
        "Task ids that must reach `done` before this one can start."
      ),
    start_at: z
      .string()
      .optional()
      .describe(
        "ISO 8601 timestamp. LEAVE UNSET unless you have a wall-clock reason " +
          "(human asked for a specific time, or you're rate-limited and want to " +
          "back off). Don't set this just to defer normal handoff — leave it " +
          "null and the assignee will pick up the task as soon as deps allow."
      ),
    due_at: z
      .string()
      .optional()
      .describe("ISO 8601 soft deadline."),
    session: z
      .string()
      .optional()
      .describe(
        "Where the work lives. `\"current\"` (only valid self-assigned), `\"fresh\"`, " +
          "or a session uuid. Omit for smart default: current for self-assign, fresh otherwise."
      ),
    recurrence: RecurrenceParamsSchema.optional().describe(
      "Schedule the task to fire repeatedly. Marking it done schedules the next fire; cancel to stop."
    ),
    team: z
      .string()
      .optional()
      .describe(
        "Team tag (team id) when the work belongs to a team's charter. " +
          "Organizational only — assignment and wake-up still run on `assignee`."
      ),
  }),
  emoji: "🆕",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });

    const a = args as {
      title: string;
      assignee: string;
      body?: string;
      parent_id?: string;
      depends_on?: string[];
      start_at?: string;
      due_at?: string;
      session?: string;
      recurrence?: Recurrence;
      team?: string;
    };
    const agentId = getCurrentAgentId();
    if (!agentId) {
      return JSON.stringify({
        ok: false,
        error: "task_create requires an active agent context (only agents create tasks).",
      });
    }

    const isSelfAssign = a.assignee === agentId;

    // Resolve session field to a concrete session_id or null.
    // - "current" → caller's current session (self-assign only)
    // - "fresh"   → null (scheduler allocates lazily)
    // - uuid      → that session id
    // - undefined → smart default: "current" if self-assign, else "fresh"
    const callerSession = getCurrentSessionId() || null;
    let sessionId: string | null;
    if (a.session === "current") {
      if (!isSelfAssign) {
        return JSON.stringify({
          ok: false,
          error:
            'session: "current" is only valid when assignee == you. ' +
            'Use "fresh" or omit when delegating.',
        });
      }
      sessionId = callerSession;
    } else if (a.session === "fresh") {
      sessionId = null;
    } else if (typeof a.session === "string" && a.session.length > 0) {
      sessionId = a.session;
    } else {
      sessionId = isSelfAssign ? callerSession : null;
    }

    // Subtask: if assignee matches the parent's and no session was decided,
    // inherit parent's session.
    let inheritedSession = sessionId;
    if (a.parent_id) {
      const parent = b.store.get(a.parent_id);
      if (parent && parent.assignee === a.assignee && !inheritedSession) {
        inheritedSession = parent.session_id;
      }
    }

    try {
      const task = await b.store.create({
        title: a.title,
        assignee: a.assignee,
        created_by: agentId,
        body: a.body,
        parent_id: a.parent_id ?? null,
        depends_on: a.depends_on ?? [],
        start_at: a.start_at ?? undefined,
        due_at: a.due_at ?? null,
        session_id: inheritedSession,
        recurrence: a.recurrence ?? null,
        team: a.team ?? null,
      });
      const warnings: string[] = [];
      if (task.status === "blocked") {
        warnings.push(
          "Task created in `blocked` status because depends_on are not yet done."
        );
      }
      return JSON.stringify({
        ok: true,
        task: frontmatterOnly(task),
        warnings: warnings.length ? warnings : undefined,
      });
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error:
          e instanceof TaskStoreError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  },
});

// ── task_update ──────────────────────────────────────────────────────

const TASK_UPDATE_DESCRIPTION =
  "Patch a task. Common uses:\n" +
  "- Mark progress: `status: \"in_progress\"`, `\"done\"`, `\"canceled\"`.\n" +
  "- Append notes to body — pass the FULL replacement body (not a diff). Prefer " +
  "  `task_comment` for discussion / mid-flight notes — body is the spec, " +
  "  comments are the conversation.\n" +
  "- Reassign: change `assignee`. Clears `session_id` automatically (the new " +
  "  assignee's sessions are different).\n" +
  "- Rebind: pass `session_id` (use null to detach).\n" +
  "- Set / change / strip `recurrence` (pass null to make a recurring task one-shot).\n" +
  "- Snooze: `start_at` to a future ISO timestamp when you need to back off and " +
  "  re-evaluate later (e.g., world-state isn't ready). Don't set start_at as " +
  "  part of normal handoff.\n\n" +
  "BEFORE marking `done`: leave a `task_comment(id, body, kind: \"result\")` with " +
  "the canonical answer. The next agent that depends on this task reads it from " +
  "there. (Soft warning if you skip this — some tasks legitimately have no " +
  "textual result, just an artifact in the world.)\n\n" +
  "When you mark a non-recurring task `done`, dependents auto-flip from blocked to open. " +
  "When you mark a RECURRING task `done`, the task self-resets to `open` with the next " +
  "fire time — the returned status will be `open` (not `done`) and `runs` will increment. " +
  "Use `status: \"canceled\"` to stop a recurrence permanently.";

registry.register({
  name: "task_update",
  toolset: "tasks",
  description: TASK_UPDATE_DESCRIPTION,
  parameters: z.object({
    id: z.string().min(1).describe("Task id."),
    title: z.string().max(500).optional(),
    body: z.string().optional().describe("Replacement body (markdown)."),
    status: z.enum(TASK_STATUSES).optional(),
    assignee: z
      .string()
      .optional()
      .describe("New assignee. Clears session_id unless you also pass session_id."),
    session_id: z
      .string()
      .nullable()
      .optional()
      .describe("Bind to a session, or null to detach."),
    depends_on: z.array(z.string()).optional(),
    start_at: z.string().nullable().optional(),
    due_at: z.string().nullable().optional(),
    recurrence: RecurrenceParamsSchema.nullable()
      .optional()
      .describe("Set/change recurrence; pass null to strip and make one-shot."),
    team: z
      .string()
      .nullable()
      .optional()
      .describe("Team tag (team id); null to clear. Organizational only."),
  }),
  emoji: "✏️",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });

    const a = args as {
      id: string;
      title?: string;
      body?: string;
      status?: TaskStatus;
      assignee?: string;
      session_id?: string | null;
      depends_on?: string[];
      start_at?: string | null;
      due_at?: string | null;
      recurrence?: Recurrence | null;
      team?: string | null;
    };
    const agentId = getCurrentAgentId();
    if (!agentId) {
      return JSON.stringify({
        ok: false,
        error: "task_update requires an active agent context.",
      });
    }

    // Soft-warn pre-check: closing as `done` without a result comment by
    // this agent. Must check before update — recurring-task self-reset
    // returns status:"open" for a legitimate done, so post-check misfires.
    // Author-filter avoids treating a prior run's result as fresh.
    const closingDone = a.status === "done";
    let warnMissingResult = false;
    if (closingDone) {
      const existing = b.store.get(a.id);
      if (existing && existing.assignee === agentId) {
        warnMissingResult = b.store.latestResult(a.id)?.author !== agentId;
      }
    }

    try {
      const task = await b.store.update(
        a.id,
        {
          title: a.title,
          body: a.body,
          status: a.status,
          assignee: a.assignee,
          ...(Object.prototype.hasOwnProperty.call(a, "session_id")
            ? { session_id: a.session_id }
            : {}),
          depends_on: a.depends_on,
          ...(Object.prototype.hasOwnProperty.call(a, "start_at")
            ? { start_at: a.start_at }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(a, "due_at")
            ? { due_at: a.due_at }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(a, "recurrence")
            ? { recurrence: a.recurrence }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(a, "team")
            ? { team: a.team }
            : {}),
        },
        { actor: agentId }
      );
      const out: Record<string, unknown> = {
        ok: true,
        task: frontmatterOnly(task),
      };
      if (warnMissingResult) {
        out.warning =
          "Marked done without a result comment. If this task produced output, " +
          "leave a `task_comment(id, body, kind: \"result\")` so the assigner " +
          "and dependents can find the answer. Some tasks have no textual " +
          "result (the artifact is in the world); in that case ignore this warning.";
      }
      return JSON.stringify(out);
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error:
          e instanceof TaskStoreError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  },
});

// ── task_comment ─────────────────────────────────────────────────────

const TASK_COMMENT_DESCRIPTION =
  "Leave a comment on a task. Comments are the discussion thread — questions " +
  "between assigner and assignee, mid-flight notes, status check-ins, and the " +
  "canonical result at completion. The body of the task is the SPEC (one " +
  "voice); comments are the conversation (multi-voice, append-only).\n\n" +
  "When you finish an assigned task, leave one final comment with " +
  "`kind: \"result\"` containing the answer (the doc, the number, the " +
  "summary, or a pointer to the artifact you produced). The agent or human " +
  "depending on this task reads the result from there. Only the assignee can " +
  "leave a `result` comment.\n\n" +
  "Comments are append-only: no edit, no delete. If a previous comment was " +
  "wrong, leave a follow-up that corrects it.";

registry.register({
  name: "task_comment",
  toolset: "tasks",
  description: TASK_COMMENT_DESCRIPTION,
  parameters: z.object({
    id: z.string().min(1).describe("Task id."),
    body: z.string().min(1).describe("Comment body (markdown)."),
    kind: z
      .enum(["result"])
      .optional()
      .describe(
        '"result" marks this comment as the canonical answer at task completion. ' +
          "Only the assignee can leave a result comment. Omit for normal discussion."
      ),
  }),
  emoji: "💬",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });

    const a = args as { id: string; body: string; kind?: "result" };
    const agentId = getCurrentAgentId();
    if (!agentId) {
      return JSON.stringify({
        ok: false,
        error: "task_comment requires an active agent context.",
      });
    }

    // Belt-and-braces with the Zod schema — blocks any path that bypasses
    // validation from forging system-authored comments.
    if (a.kind !== undefined && a.kind !== "result") {
      return JSON.stringify({
        ok: false,
        error: `Invalid comment kind ${JSON.stringify(a.kind)}: only "result" or unset is allowed.`,
      });
    }

    const task = b.store.get(a.id);
    if (!task) {
      return JSON.stringify({ ok: false, error: `Task ${a.id} not found.` });
    }

    if (a.kind === "result" && task.assignee !== agentId) {
      return JSON.stringify({
        ok: false,
        error:
          `Only the assignee (${task.assignee}) can leave a result comment on this task.`,
      });
    }

    try {
      const comment = await b.store.addComment({
        taskId: a.id,
        author: agentId,
        body: a.body,
        kind: a.kind ?? null,
      });
      if (!comment) {
        return JSON.stringify({
          ok: false,
          error: "Comment storage not configured.",
        });
      }
      return JSON.stringify({ ok: true, comment });
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error:
          e instanceof TaskStoreError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  },
});

// ── task_comments ────────────────────────────────────────────────────

const TASK_COMMENTS_DESCRIPTION =
  "Read the discussion thread on a task. Returns comments oldest-first. " +
  "Use `kinds: [\"result\"]` to fetch only the canonical answer when you " +
  "depend on this task and want the assignee's final output. " +
  "Use `kinds: [\"system\"]` to see scheduler annotations (timeout / error " +
  "parks, watchdog notes) — useful when a task got stuck and you're checking " +
  "what happened. Use `sinceTs` to read only what's new since you last looked.";

registry.register({
  name: "task_comments",
  toolset: "tasks",
  description: TASK_COMMENTS_DESCRIPTION,
  parameters: z.object({
    id: z.string().min(1).describe("Task id."),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Max number of comments. Default 50."),
    sinceTs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Only return comments newer than this unix-epoch (seconds)."),
    kinds: z
      .array(z.string())
      .optional()
      .describe(
        "Filter by kind. Common: [\"result\"] for just the canonical answer."
      ),
  }),
  emoji: "📜",
  parallelSafe: true,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });

    const a = args as {
      id: string;
      limit?: number;
      sinceTs?: number;
      kinds?: string[];
    };

    if (!b.store.get(a.id)) {
      return JSON.stringify({ ok: false, error: `Task ${a.id} not found.` });
    }
    // Filter (not validate) — unknown kinds drop silently.
    const validKindSet = new Set<string>(COMMENT_KINDS);
    const kinds = a.kinds
      ? (a.kinds.filter((k) => validKindSet.has(k)) as CommentKind[])
      : undefined;
    const comments = b.store.listComments(a.id, {
      limit: a.limit ?? 50,
      sinceTs: a.sinceTs,
      kinds,
    });
    return JSON.stringify({
      ok: true,
      count: comments.length,
      comments,
    });
  },
});
