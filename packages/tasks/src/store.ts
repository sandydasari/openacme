/**
 * File-backed task store. One markdown file per task at
 * `<tasksDir>/<id>.md` — YAML frontmatter for structured fields, body
 * for the agent-readable description and accumulated notes.
 *
 * Ids are a single global sequence ("1", "2", …) shared by all agents.
 * The high-water mark lives in `<tasksDir>/.seq` so deleting the
 * highest-numbered task never recycles its id (comments and events
 * outlive the task file and are keyed by it).
 *
 * Concurrency: per-task in-process async mutex serializes
 * read-modify-write of a single id. Each operation only acquires one
 * mutex at a time — fan-out paths (`unblockDependents`, `delete --force`)
 * iterate sequentially without holding multiple locks, so there's no
 * deadlock surface.
 *
 * The store enforces:
 *   - cycle-free `depends_on` graph (DFS on write).
 *   - status auto-transition between `open` and `blocked` based on deps.
 *   - at most one `in_progress` per `session_id`.
 *   - inputs validated against the frontmatter schema at the write
 *     boundary so a bad input can't land malformed YAML on disk.
 *
 * Status state machine (legal transitions only — anything else is a bug):
 *
 *   open ─────► in_progress    (assignee claims via update; requires deps satisfied)
 *   open ─────► blocked        (auto, when deps regress)
 *   open ─────► done/canceled  (terminal)
 *
 *   in_progress ──► blocked      (via TaskStore.park, by scheduler on
 *                                 timeout/error or watchdog)
 *   in_progress ──► done/canceled (terminal; assignee or human)
 *
 *   blocked ──► open             (auto, when deps satisfy via unblockDependents)
 *   blocked ──► done/canceled    (terminal; bypasses in_progress)
 *
 *   done ────► open              (ONLY for recurring tasks — self-reset
 *                                 to next fire. Non-recurring done is
 *                                 terminal.)
 *   canceled ──► (nothing)       (kill switch; never resets, even for recurring)
 *
 * Adding a new status: extend `TASK_STATUSES`, then audit `computeAutoStatus`,
 * the closing branches in `update()`, the recurring self-reset, scheduler's
 * `park` / `watchdogPark`, `hasAnyActive`, and prompt rendering.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import {
  NullableIso,
  RecurrenceSchema,
  TaskFrontmatterSchema,
  TaskIdSchema,
  type Recurrence,
  type Task,
  type TaskCreate,
  type TaskFrontmatter,
  type TaskListFilter,
  type TaskStatus,
  type TaskUpdate,
} from "./types.js";
import { createLogger } from "@openacme/config/logger";
import { computeNextFire, validateRecurrence } from "./recurrence.js";
import {
  renderForPrompt as renderForPromptPure,
  renderRecentActivity as renderRecentActivityPure,
} from "./prompt-render.js";

const log = createLogger("tasks.store");
import type {
  Comment,
  CommentInput,
  CommentListOptions,
  CommentStorePort,
  EventInput,
  EventStorePort,
  TaskEvent,
} from "./ports.js";

// Reject malformed inputs at the write boundary so a bad PATCH can't
// land garbage on disk that the next `list()` then silently drops.
const TaskCreateInputSchema = z.object({
  title: z.string().min(1).max(500),
  assignee: z.string().min(1),
  created_by: z.string().min(1),
  body: z.string().optional(),
  session_id: z.string().min(1).nullable().optional(),
  parent_id: TaskIdSchema.nullable().optional(),
  depends_on: z.array(TaskIdSchema).optional(),
  start_at: NullableIso.optional(),
  due_at: NullableIso.optional(),
  status: z
    .enum(["open", "in_progress", "blocked", "done", "canceled"])
    .optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
  team: z.string().min(1).nullable().optional(),
});
const TaskUpdateInputSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().optional(),
  status: z
    .enum(["open", "in_progress", "blocked", "done", "canceled"])
    .optional(),
  assignee: z.string().min(1).optional(),
  session_id: z.string().min(1).nullable().optional(),
  depends_on: z.array(TaskIdSchema).optional(),
  start_at: NullableIso.optional(),
  due_at: NullableIso.optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
  team: z.string().min(1).nullable().optional(),
});

const TMP_PREFIX = ".task_";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SEQ_ID = /^[0-9]+$/;
const SEQ_FILE = ".seq";
const STALE_IN_PROGRESS_MS = 10 * 60 * 1000;
// Mutex key serializing id allocation across concurrent creates.
const CREATE_LOCK = "__create__";

export class TaskStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "TaskStoreError";
  }
}

export type OnChangeFn = () => void;

export interface TaskStoreOptions {
  /** Optional: discussion thread store. If absent, comment methods no-op. */
  commentStore?: CommentStorePort;
  /** Optional: event log store. If absent, no events emitted. */
  eventStore?: EventStorePort;
  /** Optional: session existence check. When provided, create/update
   *  reject task bindings to a session id the check returns false for —
   *  prevents agents from hallucinating session uuids that would become
   *  scheduler zombies. */
  validateSession?: (id: string) => boolean;
  /** Optional: team-id → manager agent id (null when the team is
   *  unknown, archived, or has no manager). When provided, `create`
   *  with a team and no assignee resolves the assignee to the manager
   *  at the write boundary — stored tasks always carry one. */
  resolveTeamManager?: (teamId: string) => string | null;
}

function isoNow(): string {
  return new Date().toISOString();
}

// Per-file dedup so a single broken task doesn't spam the log every
// time `list()` runs. Cleared on a successful re-parse.
const warnedMalformed = new Set<string>();

function parseTaskFile(filePath: string): Task | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const { data, content } = matter(raw);
    const fm = TaskFrontmatterSchema.parse(data);
    warnedMalformed.delete(filePath);
    return { ...fm, body: content.trimStart() };
  } catch (e) {
    if (!warnedMalformed.has(filePath)) {
      warnedMalformed.add(filePath);
      log.warn({ err: e, filePath }, "skipping malformed task file");
    }
    return null;
  }
}

function serializeTask(task: Task): string {
  const { body, ...frontmatter } = task;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v === undefined) continue;
    cleaned[k] = v;
  }
  return matter.stringify(body ? `${body}\n` : "\n", cleaned);
}

export class TaskStore {
  private readonly inFlight = new Map<string, Promise<void>>();
  private onChange: OnChangeFn | null = null;
  private readonly commentStore: CommentStorePort | null;
  private readonly eventStore: EventStorePort | null;
  private readonly validateSession: ((id: string) => boolean) | null;
  private readonly resolveTeamManager: ((teamId: string) => string | null) | null;

  constructor(readonly tasksDir: string, options: TaskStoreOptions = {}) {
    this.commentStore = options.commentStore ?? null;
    this.eventStore = options.eventStore ?? null;
    this.validateSession = options.validateSession ?? null;
    this.resolveTeamManager = options.resolveTeamManager ?? null;
    this.adoptNonSequenceIds();
  }

  /** Renumber tasks whose id isn't a sequence number (oldest first) and
   *  fix depends_on / parent_id references. Numeric ids are untouched. */
  private adoptNonSequenceIds(): void {
    if (!fs.existsSync(this.tasksDir)) return;
    const all = this.list();
    let seq = this.lastAllocated();
    const mapping = new Map<string, string>();
    for (const t of all) {
      if (!SEQ_ID.test(t.id)) mapping.set(t.id, String((seq += 1)));
    }
    if (mapping.size === 0) return;

    for (const t of all) {
      const next: Task = {
        ...t,
        id: mapping.get(t.id) ?? t.id,
        parent_id: t.parent_id && (mapping.get(t.parent_id) ?? t.parent_id),
        depends_on: t.depends_on.map((d) => mapping.get(d) ?? d),
      };
      if (JSON.stringify(next) === JSON.stringify(t)) continue;
      this.writeAtomicSync(this.filePath(next.id), serializeTask(next));
      if (next.id !== t.id) fs.rmSync(this.filePath(t.id), { force: true });
    }
    this.writeSeqSync(seq);
    log.info({ renumbered: Object.fromEntries(mapping) }, "renumbered task ids");
  }

  /** Highest sequence number ever allocated: counter file ⊔ ids on disk.
   *  Disk scan self-heals a missing/stale counter; the counter prevents
   *  id reuse after the highest-numbered task is deleted. */
  private lastAllocated(): number {
    let fromFile = 0;
    try {
      const raw = fs.readFileSync(
        path.join(this.tasksDir, SEQ_FILE),
        "utf-8"
      );
      const n = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(n) && n > 0) fromFile = n;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    let fromDisk = 0;
    if (fs.existsSync(this.tasksDir)) {
      for (const name of fs.readdirSync(this.tasksDir)) {
        const m = /^([0-9]+)\.md$/.exec(name);
        if (!m) continue;
        const n = Number.parseInt(m[1]!, 10);
        if (n > fromDisk) fromDisk = n;
      }
    }
    return Math.max(fromFile, fromDisk);
  }

  private writeSeqSync(n: number): void {
    this.writeAtomicSync(path.join(this.tasksDir, SEQ_FILE), `${n}\n`);
  }

  private writeAtomicSync(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(
      path.dirname(file),
      `${TMP_PREFIX}${randomBytes(8).toString("hex")}.tmp`
    );
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, file);
  }

  setOnChange(fn: OnChangeFn | null): void {
    this.onChange = fn;
  }

  filePath(id: string): string {
    if (!SAFE_ID.test(id)) {
      throw new TaskStoreError(
        "invalid_id",
        `Invalid task id ${JSON.stringify(id)}: must match ${SAFE_ID}`
      );
    }
    return path.join(this.tasksDir, `${id}.md`);
  }

  // ── Reads (sync, no mutex) ────────────────────────────────────────

  get(id: string): Task | null {
    if (!SAFE_ID.test(id)) return null;
    return parseTaskFile(this.filePath(id));
  }

  list(filter?: TaskListFilter): Task[] {
    if (!fs.existsSync(this.tasksDir)) return [];
    const entries = fs.readdirSync(this.tasksDir, { withFileTypes: true });
    const out: Task[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".")) continue;
      if (!entry.name.endsWith(".md")) continue;
      const t = parseTaskFile(path.join(this.tasksDir, entry.name));
      if (!t) continue;
      if (!matchesFilter(t, filter)) continue;
      out.push(t);
    }
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return out;
  }

  byAssignee(agentId: string): Task[] {
    return this.list({ assignee: agentId });
  }

  byCreator(agentId: string): Task[] {
    return this.list({ created_by: agentId });
  }

  byParent(parentId: string): Task[] {
    return this.list({ parent_id: parentId });
  }

  dependentsOf(id: string): Task[] {
    return this.list().filter((t) => t.depends_on.includes(id));
  }

  /** Tasks bound to `sessionId` in queue order (deps + start_at + created_at). */
  queueFor(sessionId: string, now: Date = new Date()): Task[] {
    const all = this.list();
    const byId = new Map(all.map((t) => [t.id, t]));
    const sessionTasks = all.filter((t) => t.session_id === sessionId);
    const eligible = sessionTasks.filter((t) =>
      isQueueEligible(t, byId, now)
    );
    return eligible.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** Top of `queueFor` excluding already in_progress / done / canceled. */
  nextEligibleFor(sessionId: string, now: Date = new Date()): Task | null {
    const queue = this.queueFor(sessionId, now);
    const head = queue.find(
      (t) => t.status === "open" || t.status === "blocked"
    );
    return head ?? null;
  }

  // ── Writes ────────────────────────────────────────────────────────

  async create(input: TaskCreate): Promise<Task> {
    if (!input.assignee && !input.team) {
      throw new TaskStoreError(
        "invalid_input",
        "assignee is required (or set `team` to route the task to that team's manager)"
      );
    }
    // Team-addressed creation: no assignee + a team resolves to the
    // team's manager at the write boundary, so stored tasks always
    // carry a concrete assignee and the wake path stays assignee-only.
    if (!input.assignee && input.team) {
      const manager = this.resolveTeamManager?.(input.team) ?? null;
      if (!manager) {
        throw new TaskStoreError(
          "no_team_manager",
          `assignee is required — team ${JSON.stringify(input.team)} has no manager to route to`
        );
      }
      input = { ...input, assignee: manager };
    }
    const parsed = TaskCreateInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new TaskStoreError(
        "invalid_input",
        `Invalid task create input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      );
    }
    input = parsed.data as TaskCreate;
    // Post-parse, assignee is schema-guaranteed (resolution above filled
    // any team-addressed omission).
    const assignee = input.assignee!;
    return this.withMutex(CREATE_LOCK, async () => {
      const id = String(this.lastAllocated() + 1);
      const all = this.list();
      const byId = new Map(all.map((t) => [t.id, t]));

      // Validate deps exist + no cycle (the new id can't be in `byId`,
      // but check transitively against the new task's deps).
      const deps = input.depends_on ?? [];
      this.assertDepsExist(deps, byId);
      this.assertNoCycle(id, deps, byId);

      // Validate parent exists if set.
      if (input.parent_id && !byId.has(input.parent_id)) {
        throw new TaskStoreError(
          "unknown_parent",
          `parent_id ${JSON.stringify(input.parent_id)} not found`
        );
      }

      if (
        input.session_id &&
        this.validateSession &&
        !this.validateSession(input.session_id)
      ) {
        throw new TaskStoreError(
          "unknown_session",
          `session_id ${JSON.stringify(input.session_id)} does not exist`
        );
      }

      const nowDate = new Date();
      const now = nowDate.toISOString();

      // Recurrence semantic validation (zod handled shape; this catches
      // expr-with-no-future-runs, until-in-past, etc.).
      const recurrence = input.recurrence ?? null;
      if (recurrence) {
        const v = validateRecurrence(recurrence, nowDate);
        if (!v.ok) {
          throw new TaskStoreError("invalid_input", v.message);
        }
      }

      // Status is whatever the caller set (default `open`). Deps are
      // a read-time predicate now — the dispatcher computes readiness
      // fresh on each tick by checking `deps_satisfied AND start_at
      // ≤ now AND status = open`. Storing `blocked` on dep-unmet was
      // the old auto-flipper model; gone.
      const status = input.status ?? "open";

      // Reject creating directly as in_progress if another in-progress
      // task already owns this session.
      if (
        status === "in_progress" &&
        input.session_id &&
        all.some(
          (t) => t.session_id === input.session_id && t.status === "in_progress"
        )
      ) {
        throw new TaskStoreError(
          "session_busy",
          `Another task is already in_progress in session ${input.session_id}`
        );
      }

      // First-fire start_at default for recurring tasks: cron honors the
      // schedule; interval fires immediately.
      let startAt: string | null;
      if (input.start_at !== undefined) {
        startAt = input.start_at;
      } else if (recurrence) {
        if (recurrence.kind === "cron") {
          const next = computeNextFire(recurrence, nowDate, 0);
          startAt = next ? next.toISOString() : null;
        } else {
          startAt = now;
        }
      } else {
        startAt = null;
      }

      let task: Task = {
        id,
        title: input.title,
        status,
        assignee,
        session_id: input.session_id ?? null,
        created_by: input.created_by,
        parent_id: input.parent_id ?? null,
        depends_on: deps,
        start_at: startAt,
        due_at: input.due_at ?? null,
        created_at: now,
        updated_at: now,
        closed_at: null,
        recurrence,
        runs: 0,
        last_run_at: null,
        failures: 0,
        team: input.team ?? null,
        body: input.body ?? "",
      };

      // Exclusive create: another process sharing the data dir (daemon +
      // in-process CLI chat) may have claimed this number — bump and retry.
      while (!(await this.writeFileIfAbsent(task))) {
        task = { ...task, id: String(Number(task.id) + 1) };
      }
      this.writeSeqSync(Number(task.id));
      // Emit with the honest actor (creator). Echo suppression now
      // lives at the inbox-delivery boundary, not in the scheduler —
      // and the dispatcher's periodic tick will catch self-assigned
      // tasks regardless of whether the event delivers an inbox row.
      this.emitEvent({
        taskId: task.id,
        sessionId: task.session_id,
        agentId: task.assignee,
        actor: input.created_by,
        kind: "task_assigned",
        payload: { assignee: task.assignee, created_by: task.created_by },
      });
      this.fireOnChange();
      return task;
    });
  }

  async update(
    id: string,
    patch: TaskUpdate,
    // `setFailures` is internal (park); not a caller-patchable field.
    opts?: { actor?: string | null; setFailures?: number }
  ): Promise<Task> {
    const parsed = TaskUpdateInputSchema.safeParse(patch);
    if (!parsed.success) {
      throw new TaskStoreError(
        "invalid_input",
        `Invalid task update input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      );
    }
    patch = parsed.data as TaskUpdate;
    return this.withMutex(id, async () => {
      const existing = this.get(id);
      if (!existing) {
        throw new TaskStoreError("not_found", `Task ${id} not found`);
      }

      const all = this.list();
      const byId = new Map(all.map((t) => [t.id, t]));

      // Reassignment automatically clears session_id (the new
      // assignee's sessions are different) — unless the same call also
      // sets session_id explicitly.
      const reassigning =
        patch.assignee !== undefined && patch.assignee !== existing.assignee;
      const explicitSession = Object.prototype.hasOwnProperty.call(
        patch,
        "session_id"
      );

      let nextSessionId = existing.session_id;
      if (explicitSession) {
        nextSessionId = patch.session_id ?? null;
      } else if (reassigning) {
        nextSessionId = null;
      }

      // Reject explicit binding to an unknown session id. Internal
      // scheduler/test paths that rebind to a freshly-created session
      // pre-existing-validate via the same hook.
      if (
        explicitSession &&
        nextSessionId &&
        nextSessionId !== existing.session_id &&
        this.validateSession &&
        !this.validateSession(nextSessionId)
      ) {
        throw new TaskStoreError(
          "unknown_session",
          `session_id ${JSON.stringify(nextSessionId)} does not exist`
        );
      }

      const nextDeps = patch.depends_on ?? existing.depends_on;
      if (patch.depends_on) {
        this.assertDepsExist(patch.depends_on, byId);
        this.assertNoCycle(id, patch.depends_on, byId);
      }

      const requestedStatus = patch.status ?? existing.status;
      const isClosing =
        (requestedStatus === "done" || requestedStatus === "canceled") &&
        existing.status !== requestedStatus;

      // No more auto-flipper. The caller's requested status is what we
      // store. Eligibility (deps + start_at) is computed by readers
      // (dispatcher, prompt rendering) at query time. `blocked` is
      // now explicit-only — never set by the store.
      const nextStatus: TaskStatus = requestedStatus;

      // At-most-one-in_progress per session.
      if (nextStatus === "in_progress" && nextSessionId) {
        const conflict = all.find(
          (t) =>
            t.id !== id &&
            t.session_id === nextSessionId &&
            t.status === "in_progress"
        );
        if (conflict) {
          throw new TaskStoreError(
            "session_busy",
            `Session ${nextSessionId} already has an in_progress task (${conflict.id})`
          );
        }
      }

      // Block transitions to in_progress when deps aren't satisfied.
      if (
        nextStatus === "in_progress" &&
        !depsSatisfied(nextDeps, byId, id)
      ) {
        throw new TaskStoreError(
          "deps_unsatisfied",
          `Cannot start task ${id}: not all dependencies are done`
        );
      }

      // Effective recurrence after this patch — used for self-reset
      // decision and persisted on the task. `null` strips recurrence.
      const effectiveRecurrence: Recurrence | null =
        patch.recurrence !== undefined
          ? patch.recurrence
          : existing.recurrence ?? null;
      if (
        patch.recurrence !== undefined &&
        patch.recurrence !== null
      ) {
        const v = validateRecurrence(patch.recurrence, new Date());
        if (!v.ok) {
          throw new TaskStoreError("invalid_input", v.message);
        }
      }

      const nowDate = new Date();
      const now = nowDate.toISOString();
      // Failure counter: success and reassignment both mean a fresh
      // start — a stale count would instantly re-escalate the new owner.
      let nextFailures = opts?.setFailures ?? existing.failures ?? 0;
      if ((isClosing && nextStatus === "done") || reassigning) {
        nextFailures = 0;
      }
      let next: Task = {
        ...existing,
        title: patch.title ?? existing.title,
        body: patch.body ?? existing.body,
        status: nextStatus,
        assignee: patch.assignee ?? existing.assignee,
        session_id: nextSessionId,
        depends_on: nextDeps,
        start_at:
          patch.start_at !== undefined ? patch.start_at : existing.start_at,
        due_at: patch.due_at !== undefined ? patch.due_at : existing.due_at,
        updated_at: now,
        closed_at:
          nextStatus === "done" || nextStatus === "canceled"
            ? existing.closed_at ?? now
            : null,
        recurrence: effectiveRecurrence,
        runs: existing.runs ?? 0,
        last_run_at: existing.last_run_at ?? null,
        failures: nextFailures,
        team: patch.team !== undefined ? patch.team : existing.team,
      };

      // Self-reset on successful completion of a recurring task.
      // Canceled is the kill switch — never resets. Blocked / errored
      // turns leave the task blocked (scheduler set it that way) so a
      // failing recurring task doesn't loop forever.
      let didReset = false;
      if (
        isClosing &&
        nextStatus === "done" &&
        effectiveRecurrence
      ) {
        // Every successful done counts as a completion, whether or not
        // it produces a future fire — so `count: N` yields exactly N.
        const completedRuns = next.runs + 1;
        next = { ...next, runs: completedRuns, last_run_at: now };

        // Always advance past the current scheduled time. Without this,
        // a cron like "0 0 * * *" marked done before its first fire
        // would compute the same start_at again.
        const startAtMs = next.start_at ? Date.parse(next.start_at) : NaN;
        const fromMs = Math.max(
          nowDate.getTime(),
          Number.isFinite(startAtMs) ? startAtMs + 1 : 0
        );
        const nextFire = computeNextFire(
          effectiveRecurrence,
          new Date(fromMs),
          completedRuns
        );
        if (nextFire) {
          const resetSessionId =
            effectiveRecurrence.session === "fresh"
              ? null
              : next.session_id;
          // Always `open` — the dispatcher's readiness predicate will
          // skip it on the next tick if deps regressed or `start_at`
          // hasn't passed yet. No stored `blocked` for dep-blocked.
          next = {
            ...next,
            status: "open",
            start_at: nextFire.toISOString(),
            closed_at: null,
            session_id: resetSessionId,
          };
          didReset = true;
        }
      }

      await this.writeFile(next);

      // Recurring-completion signal lives in its own event kind so the
      // subsequent status_changed correctly reads in_progress → open (the
      // reset state) without burying the completion in a misleading payload.
      if (didReset) {
        this.emitEvent({
          taskId: next.id,
          sessionId: next.session_id,
          agentId: next.assignee,
          actor: opts?.actor ?? null,
          kind: "task_completed_run",
          payload: {
            runs: next.runs,
            last_run_at: next.last_run_at,
            next_fire: next.start_at,
          },
        });
      }

      const statusActuallyChanged = next.status !== existing.status;
      if (statusActuallyChanged) {
        this.emitEvent({
          taskId: next.id,
          sessionId: next.session_id,
          agentId: next.assignee,
          actor: opts?.actor ?? null,
          kind: "status_changed",
          payload: { from: existing.status, to: next.status },
        });
      }

      // No graph-walk on close — dependents are unblocked implicitly
      // by the dispatcher's readiness predicate (which sees the dep
      // now done on its next state-check). The `dep_unblocked` event
      // is no longer emitted; the dispatcher doesn't route on events
      // and there's no other reader that cares.

      this.fireOnChange();
      return next;
    });
  }

  async delete(
    id: string,
    opts?: { force?: boolean; actor?: string | null }
  ): Promise<void> {
    return this.withMutex(id, async () => {
      const existing = this.get(id);
      if (!existing) {
        throw new TaskStoreError("not_found", `Task ${id} not found`);
      }
      const dependents = this.dependentsOf(id);
      if (dependents.length > 0 && !opts?.force) {
        throw new TaskStoreError(
          "has_dependents",
          `Task ${id} has ${dependents.length} dependent(s). Pass force to cascade.`
        );
      }
      try {
        await fsp.unlink(this.filePath(id));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      // Drop the discussion thread alongside the task. Events stay —
      // they're an audit trail and don't carry user content.
      try {
        this.commentStore?.deleteByTask(id);
      } catch (e) {
        log.warn({ err: e, taskId: id }, "delete: failed to drop comments");
      }
      // Emit the deletion before recursing so the dependent's wake
      // sees this task already terminal in the prompt's recent activity.
      this.emitEvent({
        taskId: id,
        sessionId: existing.session_id,
        agentId: existing.assignee,
        actor: opts?.actor ?? null,
        kind: "task_deleted",
        payload: {
          assignee: existing.assignee,
          created_by: existing.created_by,
          forced: opts?.force === true,
        },
      });
      if (opts?.force) {
        for (const dep of dependents) {
          // Recurse — each dependent may itself have dependents.
          try {
            await this.delete(dep.id, { force: true, actor: opts?.actor });
          } catch (e) {
            if (
              !(e instanceof TaskStoreError && e.code === "not_found")
            ) {
              throw e;
            }
          }
        }
      }
      this.fireOnChange();
    });
  }

  /**
   * Restart sweep: any task `in_progress` whose `updated_at` is older
   * than the staleness threshold is reset to `open`. Returns the ids
   * that were reset.
   */
  /**
   * Park a task: flip to `blocked` with a future `start_at` and append
   * a `system:scheduler` comment explaining why. The scheduler uses this
   * for both failure attribution (`parkInProgress`) and watchdog stalls
   * (`watchdogPark`). Single helper means the "blocked + back-off +
   * system note" pattern lives in one place.
   *
   * Every park bumps the task's consecutive-`failures` counter. With
   * `escalate` the task is also handed off — team manager first, then
   * the creator — so a mis-scoped task stops retrying identically with
   * the same assignee; reassignment resets the counter for the new
   * owner while the system comment preserves the history.
   */
  async park(input: {
    id: string;
    retryAt: Date;
    reason: string;
    escalate?: boolean;
  }): Promise<Task> {
    const existing = this.get(input.id);
    if (!existing) {
      throw new TaskStoreError("not_found", `Task ${input.id} not found`);
    }
    const failures = (existing.failures ?? 0) + 1;
    const retryAtIso = input.retryAt.toISOString();

    let target: string | null = null;
    if (input.escalate) {
      const manager = existing.team
        ? this.resolveTeamManager?.(existing.team) ?? null
        : null;
      if (manager && manager !== existing.assignee) {
        target = manager;
      } else if (
        existing.created_by !== existing.assignee &&
        !existing.created_by.startsWith("system:")
      ) {
        target = existing.created_by;
      }
    }

    // Escalation hands off as `open` (+ start_at floor), not `blocked`:
    // blocked only nudges an already-bound session, and reassignment
    // clears the session — the new owner would never be woken. Open +
    // due start_at flows through the normal readiness/binding path.
    const updated = await this.update(
      input.id,
      target
        ? { status: "open", start_at: retryAtIso, assignee: target }
        : { status: "blocked", start_at: retryAtIso },
      { actor: "system:scheduler", setFailures: failures }
    );
    const body = target
      ? `${input.reason} — ${failures} consecutive failed turn(s); escalated to ${target} for triage. ` +
        `Don't retry as-is: re-scope (split with task_plan), reassign, or cancel. Retry not before ${retryAtIso}`
      : input.escalate
        ? `${input.reason} — ${failures} consecutive failed turn(s), no distinct agent to escalate to. ` +
          `Don't retry as-is: re-scope (split with task_plan) or cancel. Retry not before ${retryAtIso}`
        : `${input.reason} — retry not before ${retryAtIso}`;
    await this.addComment({
      taskId: input.id,
      author: "system:scheduler",
      kind: "system",
      body,
    });
    return updated;
  }

  async sweepStale(now: Date = new Date()): Promise<string[]> {
    const stale = this.list({ status: "in_progress" }).filter((t) => {
      const updated = Date.parse(t.updated_at);
      return Number.isFinite(updated) && now.getTime() - updated > STALE_IN_PROGRESS_MS;
    });
    const reset: string[] = [];
    for (const t of stale) {
      try {
        await this.update(t.id, { status: "open" });
        reset.push(t.id);
      } catch (e) {
        log.warn({ err: e, taskId: t.id }, "sweepStale: failed to reset task");
      }
    }
    return reset;
  }

  /**
   * System-prompt block for an agent. `sessionExistsFn` lets the caller
   * treat tasks bound to a deleted session as if they were unbound.
   */
  renderForPrompt(
    agentId: string,
    currentSessionId: string,
    sessionExistsFn: (sid: string) => boolean,
    now: Date = new Date()
  ): string {
    return renderForPromptPure(
      {
        list: () => this.list(),
        commentCounts: (ids) => this.commentCounts(ids),
        latestNonSystemComment: (id) => this.latestNonSystemComment(id),
      },
      agentId,
      currentSessionId,
      sessionExistsFn,
      now
    );
  }

  private latestNonSystemComment(taskId: string): Comment | null {
    if (!this.commentStore) return null;
    const all = this.commentStore.list(taskId);
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]!.kind !== "system") return all[i]!;
    }
    return null;
  }

  // ── Internals ─────────────────────────────────────────────────────

  private assertDepsExist(
    deps: string[],
    byId: Map<string, Task>
  ): void {
    const missing = deps.filter((d) => !byId.has(d));
    if (missing.length > 0) {
      throw new TaskStoreError(
        "unknown_deps",
        `Unknown dependency id(s): ${missing.join(", ")}`
      );
    }
  }

  private assertNoCycle(
    selfId: string,
    deps: string[],
    byId: Map<string, Task>
  ): void {
    // DFS — does any path from a dep land back on selfId?
    const visited = new Set<string>();
    const stack = [...deps];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === selfId) {
        throw new TaskStoreError(
          "cycle",
          `Cycle detected in depends_on graph involving ${selfId}`
        );
      }
      if (visited.has(cur)) continue;
      visited.add(cur);
      const node = byId.get(cur);
      if (!node) continue;
      for (const d of node.depends_on) stack.push(d);
    }
  }

  private async writeFile(task: Task): Promise<void> {
    const file = this.filePath(task.id);
    const dir = path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `${TMP_PREFIX}${randomBytes(8).toString("hex")}.tmp`
    );
    let fh: fsp.FileHandle | null = null;
    try {
      fh = await fsp.open(tmp, "w");
      await fh.writeFile(serializeTask(task), "utf-8");
      await fh.sync();
      await fh.close();
      fh = null;
      await fsp.rename(tmp, file);
    } catch (e) {
      if (fh) {
        try {
          await fh.close();
        } catch {
          // ignore
        }
      }
      try {
        await fsp.unlink(tmp);
      } catch {
        // best-effort cleanup
      }
      throw e;
    }
  }

  /** Like writeFile, but refuses to clobber: links the temp file into
   *  place, which fails atomically if the path already exists. Returns
   *  false on collision so the caller can re-allocate the id. */
  private async writeFileIfAbsent(task: Task): Promise<boolean> {
    const file = this.filePath(task.id);
    const dir = path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `${TMP_PREFIX}${randomBytes(8).toString("hex")}.tmp`
    );
    try {
      const fh = await fsp.open(tmp, "w");
      try {
        await fh.writeFile(serializeTask(task), "utf-8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.link(tmp, file);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      await fsp.unlink(tmp).catch(() => {});
    }
  }

  private async withMutex<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prev = this.inFlight.get(id) ?? Promise.resolve();
    const result = prev.then(work, work);
    this.inFlight.set(
      id,
      result.then(
        () => undefined,
        () => undefined
      )
    );
    return result;
  }

  private fireOnChange(): void {
    if (!this.onChange) return;
    try {
      this.onChange();
    } catch (e) {
      log.warn({ err: e }, "onChange callback threw");
    }
  }

  private emitEvent(input: EventInput): void {
    if (!this.eventStore) return;
    try {
      this.eventStore.append(input);
    } catch (e) {
      log.warn({ err: e }, "eventStore.append threw");
    }
  }

  // ── Comments ──────────────────────────────────────────────────────

  /**
   * Append a comment to the task's discussion thread. Authorship gates
   * (assignee-only for `kind: "result"`, system-only for `kind: "system"`)
   * live in the tool layer; the store accepts whatever it's given so
   * automation paths can write system entries directly.
   */
  async addComment(input: CommentInput): Promise<Comment | null> {
    if (!this.commentStore) return null;
    const task = this.get(input.taskId);
    if (!task) {
      throw new TaskStoreError(
        "not_found",
        `Cannot comment: task ${input.taskId} not found`
      );
    }
    const comment = this.commentStore.add(input);
    const isSystemAuthor = input.author.startsWith("system:");
    const excerpt = input.body.replace(/\s+/g, " ").trim().slice(0, 80);
    // `agentId` is the recipient (the task's assignee, who should be
    // notified via inbox). `actor` is who authored the comment. Echo
    // suppression at the inbox-delivery boundary filters out self-
    // authored comments so the assignee doesn't get pinged about
    // their own messages.
    this.emitEvent({
      taskId: input.taskId,
      sessionId: task.session_id,
      agentId: task.assignee,
      actor: isSystemAuthor ? null : input.author,
      kind: "comment_added",
      payload: {
        comment_id: comment.id,
        kind: comment.kind ?? null,
        excerpt,
        author: input.author,
      },
    });
    this.fireOnChange();
    return comment;
  }

  listComments(taskId: string, opts?: CommentListOptions): Comment[] {
    if (!this.commentStore) return [];
    return this.commentStore.list(taskId, opts);
  }

  latestResult(taskId: string): Comment | null {
    if (!this.commentStore) return null;
    return this.commentStore.latestResult(taskId);
  }

  commentCounts(taskIds: string[]): Map<string, number> {
    if (!this.commentStore) return new Map();
    return this.commentStore.countByTask(taskIds);
  }

  // ── Events ────────────────────────────────────────────────────────

  /**
   * Tasks this session is "involved with" — bound to the session, plus
   * the agent's assigned/created tasks that have no session yet (those
   * land here when they get a fresh session). Plus tasks the agent
   * created and assigned to OTHERS — without this, the agent loses
   * the event feed for delegated work the moment its assignee picks
   * it up and the task gets bound to a different session.
   */
  involvedTaskIds(sessionId: string, agentId: string): string[] {
    const all = this.list();
    const ids: string[] = [];
    for (const t of all) {
      // bound to this session
      if (t.session_id === sessionId) {
        ids.push(t.id);
        continue;
      }
      // unbound + I'm assignee or creator
      if (
        !t.session_id &&
        (t.assignee === agentId || t.created_by === agentId)
      ) {
        ids.push(t.id);
        continue;
      }
      // delegated by me to someone else, still in flight — I want to
      // see comments / status changes on it regardless of binding.
      if (
        t.created_by === agentId &&
        t.assignee !== agentId &&
        t.status !== "done" &&
        t.status !== "canceled"
      ) {
        ids.push(t.id);
      }
    }
    return ids;
  }

  /**
   * Fetch recent events for the given session's involvement set, since
   * `sinceTs` (unix seconds). Empty array if no event store wired.
   * `excludeActor` filters out events caused by that actor — used by
   * the mid-turn injection path so the cursor and the rendered set
   * always match (otherwise self-events get re-shown on every step).
   */
  recentEventsForSession(
    sessionId: string,
    agentId: string,
    sinceTs: number,
    opts?: { limit?: number; excludeActor?: string }
  ): TaskEvent[] {
    if (!this.eventStore) return [];
    const ids = this.involvedTaskIds(sessionId, agentId);
    if (ids.length === 0) return [];
    const limit = opts?.limit ?? 20;
    const rows = this.eventStore.recentForTasks(ids, sinceTs, limit);
    if (!opts?.excludeActor) return rows;
    const excl = opts.excludeActor;
    return rows.filter((e) => e.actor !== excl);
  }

  /**
   * Format the events feed as a markdown section for the system prompt.
   * Returns "" when there are no events to render.
   */
  renderRecentActivity(
    sessionId: string,
    agentId: string,
    sinceTs: number,
    now: Date = new Date(),
    opts?: { limit?: number; excludeActor?: string }
  ): string {
    const events = this.recentEventsForSession(sessionId, agentId, sinceTs, {
      limit: opts?.limit ?? 20,
      excludeActor: opts?.excludeActor,
    });
    if (events.length === 0) return "";
    const titlesById = new Map(this.list().map((t) => [t.id, t.title]));
    return renderRecentActivityPure(events, titlesById, now);
  }
}

// ── Pure helpers ────────────────────────────────────────────────────

function isFutureStart(startAt: string | null, now: Date): boolean {
  if (!startAt) return false;
  const t = Date.parse(startAt);
  if (!Number.isFinite(t)) return false;
  return t > now.getTime();
}

function depsSatisfied(
  deps: string[],
  byId: Map<string, TaskFrontmatter>,
  ignoreId?: string
): boolean {
  for (const d of deps) {
    if (d === ignoreId) continue;
    const dep = byId.get(d);
    if (!dep) return false;
    if (dep.status !== "done") return false;
  }
  return true;
}

function isQueueEligible(
  task: Task,
  byId: Map<string, Task>,
  now: Date
): boolean {
  if (task.status === "done" || task.status === "canceled") return false;
  if (!depsSatisfied(task.depends_on, byId, task.id)) return false;
  if (isFutureStart(task.start_at, now)) return false;
  return true;
}

function matchesFilter(task: Task, filter?: TaskListFilter): boolean {
  if (!filter) return true;
  if (filter.assignee !== undefined && task.assignee !== filter.assignee)
    return false;
  if (filter.created_by !== undefined && task.created_by !== filter.created_by)
    return false;
  if (filter.session_id !== undefined && task.session_id !== filter.session_id)
    return false;
  if (filter.parent_id !== undefined && task.parent_id !== filter.parent_id)
    return false;
  if (filter.team !== undefined && task.team !== filter.team) return false;
  if (filter.status !== undefined) {
    const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!wanted.includes(task.status)) return false;
  }
  return true;
}

