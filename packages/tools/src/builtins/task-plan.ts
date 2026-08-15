import { z } from "zod";
import { TaskStoreError, type Task } from "@openacme/tasks";
import { registry } from "../registry.js";
import { getCurrentAgentId } from "../session-context.js";
import { requireTaskBindings } from "./tasks.js";

// Decompose-then-create in one shot. The agent calling this tool IS the
// planner — it produces the breakdown; the tool's job is the mechanical
// part an agent firing N separate task_create calls gets wrong: validating
// the dependency graph up front (no dangling refs, no cycles), ordering the
// writes topologically, and resolving plan-local keys to the real task ids
// allocated on creation. All-or-nothing on validation; deps inside the plan
// reference each other by `key`, deps on pre-existing work by real task id.

const SubtaskSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "Plan-local identifier for this subtask, unique within this call " +
          '(e.g. "A", "backend", "step-1"). Used only to wire depends_on ' +
          "between subtasks in this plan — the real task id is assigned on " +
          "creation. Make it non-numeric to avoid confusion with task ids."
      ),
    title: z.string().min(1).max(500).describe("Short, action-oriented title."),
    body: z
      .string()
      .optional()
      .describe("Markdown description / acceptance criteria for this subtask."),
    assignee: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Agent id to own this subtask. Omittable only when a `team` (on the " +
          "subtask or the plan) has a manager — it then routes to that manager."
      ),
    depends_on: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "What must reach `done` before this subtask starts. Each entry is " +
          "EITHER a `key` of another subtask in this same plan (wires the DAG) " +
          "OR the real id of a pre-existing task. Cycle-checked across the plan."
      ),
    team: z
      .string()
      .optional()
      .describe(
        "Team tag for this subtask. Falls back to the plan-level `team`."
      ),
    start_at: z
      .string()
      .optional()
      .describe("ISO 8601 start time. Leave unset for normal handoff."),
    due_at: z.string().optional().describe("ISO 8601 soft deadline."),
  })
  .strict();

const TASK_PLAN_DESCRIPTION =
  "Decompose a goal into a DAG of subtasks and create them all at once. Use " +
  "this instead of many task_create calls when one goal fans out into several " +
  "interdependent pieces — it validates the whole dependency graph up front " +
  "(rejects dangling references and cycles before creating anything), orders " +
  "the writes so depends_on always resolves, and turns your plan-local `key`s " +
  "into the real task ids it allocates.\n\n" +
  "Wiring deps: a subtask's `depends_on` entry is either the `key` of another " +
  "subtask in THIS plan, or the real id of an already-existing task. Subtasks " +
  "with neither `assignee` nor a `team` manager are rejected.\n\n" +
  "Each created subtask gets a fresh session (these are delegated / future " +
  "work, not the turn you're in). Pass `dry_run: true` to validate and preview " +
  "the resolved plan WITHOUT creating anything — use it to confirm a breakdown " +
  "with the human before committing.";

interface SubtaskInput {
  key: string;
  title: string;
  body?: string;
  assignee?: string;
  depends_on?: string[];
  team?: string;
  start_at?: string;
  due_at?: string;
}

// Kahn's algorithm over the plan-local edges (deps that name a subtask key).
// Returns the create order, or the set of keys stuck in a cycle.
function topoOrder(
  subtasks: SubtaskInput[],
  keySet: Set<string>
): { ok: true; order: string[] } | { ok: false; cycle: string[] } {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of subtasks) {
    indegree.set(s.key, 0);
    dependents.set(s.key, []);
  }
  for (const s of subtasks) {
    for (const dep of s.depends_on ?? []) {
      if (!keySet.has(dep)) continue; // pre-existing task id — not a plan edge
      indegree.set(s.key, (indegree.get(s.key) ?? 0) + 1);
      dependents.get(dep)!.push(s.key);
    }
  }
  const ready = subtasks
    .filter((s) => indegree.get(s.key) === 0)
    .map((s) => s.key);
  const order: string[] = [];
  while (ready.length > 0) {
    const k = ready.shift()!;
    order.push(k);
    for (const d of dependents.get(k)!) {
      const n = indegree.get(d)! - 1;
      indegree.set(d, n);
      if (n === 0) ready.push(d);
    }
  }
  if (order.length !== subtasks.length) {
    const cycle = subtasks.map((s) => s.key).filter((k) => !order.includes(k));
    return { ok: false, cycle };
  }
  return { ok: true, order };
}

registry.register({
  name: "task_plan",
  toolset: "tasks",
  description: TASK_PLAN_DESCRIPTION,
  parameters: z.object({
    subtasks: z
      .array(SubtaskSchema)
      .min(1)
      .max(50)
      .describe("The subtasks to create, in any order — deps define the DAG."),
    team: z
      .string()
      .optional()
      .describe(
        "Default team for subtasks that don't set their own. Subtasks with no " +
          "assignee route to this team's manager."
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "Validate + resolve the plan and return the preview WITHOUT creating " +
          "any tasks. Use to confirm a breakdown before committing."
      ),
  }),
  emoji: "🗂️",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireTaskBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });

    const a = args as {
      subtasks: SubtaskInput[];
      team?: string;
      dry_run?: boolean;
    };
    const agentId = getCurrentAgentId();
    if (!agentId) {
      return JSON.stringify({
        ok: false,
        error:
          "task_plan requires an active agent context (only agents create tasks).",
      });
    }

    const subtasks = a.subtasks;
    const keys = subtasks.map((s) => s.key);
    const keySet = new Set(keys);

    // 1. Unique keys.
    if (keySet.size !== keys.length) {
      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const k of keys) (seen.has(k) ? dupes : seen).add(k);
      return JSON.stringify({
        ok: false,
        error: `Duplicate subtask key(s): ${[...dupes].join(", ")}. Keys must be unique within a plan.`,
      });
    }

    // 2. Every subtask is routable (assignee, or a team to route to a manager).
    const unroutable = subtasks
      .filter((s) => !s.assignee && !(s.team ?? a.team))
      .map((s) => s.key);
    if (unroutable.length > 0) {
      return JSON.stringify({
        ok: false,
        error:
          `Subtask(s) ${unroutable.join(", ")} have no assignee and no team to ` +
          `route to. Set an assignee, a per-subtask team, or a plan-level team.`,
      });
    }

    // 3. Dependency references resolve: each dep is a plan key or an existing
    //    task id. Self-references and unknown ids are rejected here so the plan
    //    is fully validated before any task is written.
    const refErrors: string[] = [];
    for (const s of subtasks) {
      for (const dep of s.depends_on ?? []) {
        if (dep === s.key) {
          refErrors.push(`${s.key} depends on itself`);
          continue;
        }
        if (keySet.has(dep)) continue;
        if (!b.store.get(dep)) {
          refErrors.push(
            `${s.key} depends on "${dep}", which is neither a subtask key in this plan nor an existing task`
          );
        }
      }
    }
    if (refErrors.length > 0) {
      return JSON.stringify({
        ok: false,
        error: `Unresolved dependencies: ${refErrors.join("; ")}.`,
      });
    }

    // 4. Topological order (also detects cycles).
    const topo = topoOrder(subtasks, keySet);
    if (!topo.ok) {
      return JSON.stringify({
        ok: false,
        error: `Dependency cycle among subtask(s): ${topo.cycle.join(", ")}.`,
      });
    }

    const byKey = new Map(subtasks.map((s) => [s.key, s]));

    // Dry run: report the resolved plan in create order without persisting.
    if (a.dry_run) {
      return JSON.stringify({
        ok: true,
        dry_run: true,
        count: subtasks.length,
        order: topo.order,
        plan: topo.order.map((k) => {
          const s = byKey.get(k)!;
          return {
            key: k,
            title: s.title,
            assignee: s.assignee ?? null,
            team: s.team ?? a.team ?? null,
            depends_on: s.depends_on ?? [],
          };
        }),
      });
    }

    // Create in topological order so plan-local deps resolve to real ids.
    const keyToId = new Map<string, string>();
    const created: Array<{
      key: string;
      id: string;
      title: string;
      assignee: string;
      status: string;
      depends_on: string[];
    }> = [];
    for (const k of topo.order) {
      const s = byKey.get(k)!;
      const resolvedDeps = (s.depends_on ?? []).map(
        (dep) => keyToId.get(dep) ?? dep
      );
      try {
        const task: Task = await b.store.create({
          title: s.title,
          assignee: s.assignee,
          created_by: agentId,
          body: s.body,
          depends_on: resolvedDeps,
          start_at: s.start_at ?? undefined,
          due_at: s.due_at ?? null,
          session_id: null,
          team: s.team ?? a.team ?? null,
        });
        keyToId.set(k, task.id);
        created.push({
          key: k,
          id: task.id,
          title: task.title,
          assignee: task.assignee,
          status: task.status,
          depends_on: task.depends_on,
        });
      } catch (e) {
        // Pre-validation makes this rare (e.g. a team with no manager); report
        // what landed so the agent can recover rather than re-running blind.
        return JSON.stringify({
          ok: false,
          error:
            e instanceof TaskStoreError
              ? `${e.code}: ${e.message}`
              : e instanceof Error
                ? e.message
                : String(e),
          failed_at: k,
          created,
        });
      }
    }

    return JSON.stringify({ ok: true, count: created.length, created });
  },
});
