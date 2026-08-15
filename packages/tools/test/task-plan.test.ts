import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "@openacme/tasks";
import { registry } from "../src/registry.js";
import { bindTaskStore } from "../src/builtins/tasks.js";
import "../src/builtins/task-plan.js";
import { toolCallContext } from "../src/session-context.js";

let dir: string;
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "openacme-tools-task-plan-"));
  store = new TaskStore(dir);
  bindTaskStore({ store });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  args: Record<string, unknown>,
  ctx: { agentId?: string; sessionId?: string } = {}
): Promise<{ ok: boolean; [k: string]: unknown }> {
  const tool = registry.get("task_plan");
  if (!tool) throw new Error("task_plan not registered");
  const exec = () => tool.handler(args);
  const out = ctx.agentId
    ? await toolCallContext.run(
        {
          agentId: ctx.agentId,
          sessionId: ctx.sessionId ?? "",
          workspaceDir: dir,
        },
        exec
      )
    : await exec();
  return JSON.parse(out);
}

describe("task_plan", () => {
  it("creates a DAG and resolves plan-local keys to real ids", async () => {
    const r = await call(
      {
        subtasks: [
          {
            key: "D",
            title: "wire + e2e",
            assignee: "me",
            depends_on: ["B", "C"],
          },
          { key: "A", title: "endpoint", assignee: "me" },
          { key: "B", title: "ui", assignee: "me", depends_on: ["A"] },
          { key: "C", title: "test", assignee: "me", depends_on: ["A"] },
        ],
      },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    const created = r.created as Array<{
      key: string;
      id: string;
      depends_on: string[];
    }>;
    expect(created).toHaveLength(4);

    const idOf = new Map(created.map((c) => [c.key, c.id]));
    // A has no deps; it must be created before its dependents.
    expect(created[0]!.key).toBe("A");
    // B and C depend on A's real id, not the literal "A".
    const b = created.find((c) => c.key === "B")!;
    expect(b.depends_on).toEqual([idOf.get("A")]);
    // D depends on both B and C real ids.
    const d = created.find((c) => c.key === "D")!;
    expect(new Set(d.depends_on)).toEqual(
      new Set([idOf.get("B"), idOf.get("C")])
    );

    // Persisted on disk with the resolved deps.
    const onDisk = store.get(idOf.get("D")!)!;
    expect(new Set(onDisk.depends_on)).toEqual(
      new Set([idOf.get("B"), idOf.get("C")])
    );
  });

  it("dry_run validates + previews without creating anything", async () => {
    const r = await call(
      {
        dry_run: true,
        subtasks: [
          { key: "A", title: "first", assignee: "me" },
          { key: "B", title: "second", assignee: "me", depends_on: ["A"] },
        ],
      },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(true);
    expect(r.order).toEqual(["A", "B"]);
    expect(store.list()).toHaveLength(0);
  });

  it("rejects a dependency cycle and creates nothing", async () => {
    const r = await call(
      {
        subtasks: [
          { key: "A", title: "a", assignee: "me", depends_on: ["B"] },
          { key: "B", title: "b", assignee: "me", depends_on: ["A"] },
        ],
      },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/cycle/i);
    expect(store.list()).toHaveLength(0);
  });

  it("rejects a dependency that is neither a plan key nor an existing task", async () => {
    const r = await call(
      {
        subtasks: [
          { key: "A", title: "a", assignee: "me", depends_on: ["ghost"] },
        ],
      },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/Unresolved dependencies/);
    expect(store.list()).toHaveLength(0);
  });

  it("allows a dependency on a pre-existing task id", async () => {
    const existing = await store.create({
      title: "already here",
      assignee: "me",
      created_by: "me",
    });
    const r = await call(
      {
        subtasks: [
          { key: "A", title: "new", assignee: "me", depends_on: [existing.id] },
        ],
      },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    const created = r.created as Array<{ depends_on: string[] }>;
    expect(created[0]!.depends_on).toEqual([existing.id]);
  });

  it("rejects duplicate keys", async () => {
    const r = await call(
      {
        subtasks: [
          { key: "A", title: "a", assignee: "me" },
          { key: "A", title: "b", assignee: "me" },
        ],
      },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/Duplicate subtask key/);
  });

  it("rejects a subtask with no assignee and no team", async () => {
    const r = await call(
      { subtasks: [{ key: "A", title: "a" }] },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/no assignee and no team/);
  });

  it("routes team-addressed subtasks to the team manager", async () => {
    const routed = new TaskStore(dir, {
      resolveTeamManager: (t) => (t === "eng" ? "lead" : null),
    });
    bindTaskStore({ store: routed });
    const r = await call(
      {
        team: "eng",
        subtasks: [{ key: "A", title: "a" }],
      },
      { agentId: "founder" }
    );
    expect(r.ok).toBe(true);
    const created = r.created as Array<{ assignee: string }>;
    expect(created[0]!.assignee).toBe("lead");
  });

  it("requires an agent context", async () => {
    const r = await call({
      subtasks: [{ key: "A", title: "a", assignee: "me" }],
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/agent context/);
  });

  it("rejects a self-dependency", async () => {
    const r = await call(
      {
        subtasks: [{ key: "A", title: "a", assignee: "me", depends_on: ["A"] }],
      },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/depends on itself/);
  });
});
