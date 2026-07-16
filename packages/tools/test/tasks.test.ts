import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "@openacme/tasks";
import { registry } from "../src/registry.js";
import { bindTaskStore } from "../src/builtins/tasks.js";
import { toolCallContext } from "../src/session-context.js";

let dir: string;
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "openacme-tools-tasks-"));
  store = new TaskStore(dir);
  bindTaskStore({ store });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  name: string,
  args: Record<string, unknown>,
  ctx: { agentId?: string; sessionId?: string } = {}
): Promise<{ ok: boolean; [k: string]: unknown }> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`${name} not registered`);
  const exec = () => tool.handler(args);
  const out = ctx.agentId
    ? await toolCallContext.run(
        { agentId: ctx.agentId, sessionId: ctx.sessionId ?? "" },
        exec
      )
    : await exec();
  return JSON.parse(out);
}

describe("task_create", () => {
  it("creates a task and stamps created_by from context", async () => {
    const r = await call(
      "task_create",
      { title: "do the thing", assignee: "me" },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    const task = (r as { task: { created_by: string; assignee: string } })
      .task;
    expect(task.created_by).toBe("me");
    expect(task.assignee).toBe("me");
  });

  it("team-addressed creation resolves assignee to the team manager", async () => {
    const routed = new TaskStore(dir, {
      resolveTeamManager: (teamId) =>
        teamId === "website" ? "zoe-manager" : null,
    });
    bindTaskStore({ store: routed });
    const r = await call(
      "task_create",
      { title: "Who should do this?", team: "website" },
      { agentId: "founder-agent" }
    );
    expect(r.ok).toBe(true);
    const task = (r as { task: { assignee: string; team: string } }).task;
    expect(task.assignee).toBe("zoe-manager");
    expect(task.team).toBe("website");

    const miss = await call(
      "task_create",
      { title: "Nobody home", team: "growth" },
      { agentId: "founder-agent" }
    );
    expect(miss.ok).toBe(false);
    expect(String(miss.error)).toMatch(/has no manager/);
  });

  it("requires an agent context", async () => {
    const r = await call("task_create", {
      title: "x",
      assignee: "me",
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/agent context/);
  });

  it("session field: smart default binds self-assign to current session", async () => {
    const r = await call(
      "task_create",
      { title: "x", assignee: "me" },
      { agentId: "me", sessionId: "s1" }
    );
    expect(r.ok).toBe(true);
    expect((r as { task: { session_id: string } }).task.session_id).toBe("s1");
  });

  it('session field: explicit "fresh" leaves session_id null on self-assign', async () => {
    const r = await call(
      "task_create",
      { title: "x", assignee: "me", session: "fresh" },
      { agentId: "me", sessionId: "s1" }
    );
    expect(r.ok).toBe(true);
    expect(
      (r as { task: { session_id: string | null } }).task.session_id
    ).toBeNull();
  });

  it("session field: smart default for cross-agent is null (fresh)", async () => {
    const r = await call(
      "task_create",
      { title: "y", assignee: "you" },
      { agentId: "me", sessionId: "s1" }
    );
    expect(r.ok).toBe(true);
    expect(
      (r as { task: { session_id: string | null } }).task.session_id
    ).toBeNull();
  });

  it('session field: rejects "current" when assignee != creator', async () => {
    const r = await call(
      "task_create",
      { title: "y", assignee: "you", session: "current" },
      { agentId: "me", sessionId: "s1" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/only valid when assignee == you/);
  });

  it("session field: explicit uuid is passed through", async () => {
    const r = await call(
      "task_create",
      { title: "y", assignee: "you", session: "abc-123-explicit" },
      { agentId: "me", sessionId: "s1" }
    );
    expect(r.ok).toBe(true);
    expect((r as { task: { session_id: string } }).task.session_id).toBe(
      "abc-123-explicit"
    );
  });

  it("rejects unknown depends_on", async () => {
    const r = await call(
      "task_create",
      { title: "x", assignee: "me", depends_on: ["missing"] },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/unknown_deps/);
  });
});

describe("task_list", () => {
  it("defaults to current agent and excludes done/canceled", async () => {
    const t = await store.create({
      title: "open",
      assignee: "me",
      created_by: "me",
    });
    const closed = await store.create({
      title: "done",
      assignee: "me",
      created_by: "me",
    });
    await store.update(closed.id, { status: "done" });
    await store.create({
      title: "other agent",
      assignee: "you",
      created_by: "me",
    });

    const r = await call("task_list", {}, { agentId: "me" });
    expect(r.ok).toBe(true);
    const ids = (r as { tasks: Array<{ id: string }> }).tasks.map((x) => x.id);
    expect(ids).toEqual([t.id]);
  });

  it("respects explicit assignee + status", async () => {
    await store.create({
      title: "x",
      assignee: "alice",
      created_by: "alice",
    });
    const blocked = await store.create({
      title: "y",
      assignee: "alice",
      created_by: "alice",
      depends_on: [],
    });
    await store.update(blocked.id, { status: "in_progress" });

    const r = await call(
      "task_list",
      { assignee: "alice", status: "in_progress" },
      { agentId: "bob" }
    );
    expect(r.ok).toBe(true);
    expect((r as { tasks: unknown[] }).tasks).toHaveLength(1);
  });
});

describe("task_view", () => {
  it("returns full body", async () => {
    const t = await store.create({
      title: "x",
      assignee: "me",
      created_by: "me",
      body: "Detailed description",
    });
    const r = await call("task_view", { id: t.id }, { agentId: "me" });
    expect(r.ok).toBe(true);
    expect((r as { task: { body: string } }).task.body.trim()).toBe(
      "Detailed description"
    );
  });

  it("returns ok:false when not found", async () => {
    const r = await call(
      "task_view",
      { id: "missing" },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
  });
});

describe("task_update", () => {
  it("marks done and clears in_progress slot", async () => {
    const t = await store.create({
      title: "x",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    await store.update(t.id, { status: "in_progress" });
    const r = await call(
      "task_update",
      { id: t.id, status: "done" },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    const reread = store.get(t.id)!;
    expect(reread.status).toBe("done");
    expect(reread.closed_at).toBeTruthy();
  });

  it("reassignment clears session_id automatically", async () => {
    const t = await store.create({
      title: "x",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    const r = await call(
      "task_update",
      { id: t.id, assignee: "other" },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    expect(
      (r as { task: { session_id: string | null } }).task.session_id
    ).toBeNull();
  });

  it("explicit null session_id detaches", async () => {
    const t = await store.create({
      title: "x",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    const r = await call(
      "task_update",
      { id: t.id, session_id: null },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    expect(
      (r as { task: { session_id: string | null } }).task.session_id
    ).toBeNull();
  });

  it("returns error code on session conflict", async () => {
    const a = await store.create({
      title: "a",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    const b = await store.create({
      title: "b",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    await store.update(a.id, { status: "in_progress" });

    const r = await call(
      "task_update",
      { id: b.id, status: "in_progress" },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/session_busy/);
  });
});

describe("recurrence via tools", () => {
  it("task_create accepts an interval recurrence and stamps runs/last_run_at defaults", async () => {
    const r = await call(
      "task_create",
      {
        title: "ping",
        assignee: "me",
        recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
      },
      { agentId: "me" }
    );
    expect(r.ok).toBe(true);
    const task = (r as { task: { recurrence: unknown; runs: number; last_run_at: string | null } }).task;
    expect(task.recurrence).toEqual({
      kind: "interval",
      every_ms: 60_000,
      session: "reuse",
    });
    expect(task.runs).toBe(0);
    expect(task.last_run_at).toBeNull();
  });

  it("task_update strips recurrence with null", async () => {
    const created = await call(
      "task_create",
      {
        title: "x",
        assignee: "me",
        recurrence: { kind: "interval", every_ms: 60_000, session: "fresh" },
      },
      { agentId: "me" }
    );
    const id = (created as { task: { id: string } }).task.id;
    const updated = await call(
      "task_update",
      { id, recurrence: null },
      { agentId: "me" }
    );
    expect(updated.ok).toBe(true);
    expect((updated as { task: { recurrence: unknown } }).task.recurrence).toBeNull();
  });

  it("task_update on a recurring task done returns status: open and bumps runs", async () => {
    const created = await call(
      "task_create",
      {
        title: "loop",
        assignee: "me",
        recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
      },
      { agentId: "me" }
    );
    const id = (created as { task: { id: string } }).task.id;
    const closed = await call(
      "task_update",
      { id, status: "done" },
      { agentId: "me" }
    );
    expect(closed.ok).toBe(true);
    const t = (closed as { task: { status: string; runs: number; last_run_at: string | null } }).task;
    expect(t.status).toBe("open");
    expect(t.runs).toBe(1);
    expect(t.last_run_at).toBeTruthy();
  });

  it("task_create rejects a malformed cron expression with a useful error", async () => {
    const r = await call(
      "task_create",
      {
        title: "x",
        assignee: "me",
        recurrence: { kind: "cron", expr: "not a cron", session: "fresh" },
      },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/invalid_input/);
  });
});

// ── Comment tools ─────────────────────────────────────────────────────

import type {
  Comment,
  CommentInput,
  CommentListOptions,
  CommentStorePort,
  EventInput,
  EventStorePort,
} from "@openacme/tasks";
import { randomUUID } from "node:crypto";

function makeWiredStore(d: string) {
  const comments: Comment[] = [];
  const commentStore: CommentStorePort = {
    add(input: CommentInput): Comment {
      const c: Comment = {
        id: randomUUID(),
        taskId: input.taskId,
        author: input.author,
        kind: input.kind ?? null,
        body: input.body,
        createdAt: Math.floor(Date.now() / 1000),
      };
      comments.push(c);
      return c;
    },
    list(taskId: string, opts: CommentListOptions = {}): Comment[] {
      let out = comments
        .filter((c) => c.taskId === taskId)
        .sort((a, b) => a.createdAt - b.createdAt);
      if (opts.sinceTs !== undefined)
        out = out.filter((c) => c.createdAt > opts.sinceTs!);
      if (opts.kinds && opts.kinds.length > 0)
        out = out.filter((c) => c.kind && opts.kinds!.includes(c.kind));
      if (opts.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    },
    latestResult(taskId: string): Comment | null {
      const r = comments
        .filter((c) => c.taskId === taskId && c.kind === "result")
        .sort((a, b) => b.createdAt - a.createdAt);
      return r[0] ?? null;
    },
    countByTask(): Map<string, number> {
      return new Map();
    },
    deleteByTask(taskId: string): void {
      for (let i = comments.length - 1; i >= 0; i--)
        if (comments[i]!.taskId === taskId) comments.splice(i, 1);
    },
  };
  const events: EventInput[] = [];
  const eventStore: EventStorePort = {
    append(e: EventInput) {
      events.push(e);
      return e;
    },
  };
  const wired = new TaskStore(d, { commentStore, eventStore });
  bindTaskStore({ store: wired });
  return { store: wired, comments, events };
}

describe("task_comment / task_comments", () => {
  it("rejects with not_found on missing task", async () => {
    makeWiredStore(dir);
    const r = await call(
      "task_comment",
      { id: "ghost", body: "hi" },
      { agentId: "me" }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/not found/i);
  });

  it("any agent can leave a generic (untagged) comment", async () => {
    const { store: s } = makeWiredStore(dir);
    const t = await s.create({ title: "x", assignee: "alice", created_by: "bob" });
    const r = await call(
      "task_comment",
      { id: t.id, body: "FYI looking into this" },
      { agentId: "bob" }
    );
    expect(r.ok).toBe(true);
    const c = (r as { comment: Comment }).comment;
    expect(c.author).toBe("bob");
    expect(c.kind).toBeNull();
  });

  it("only the assignee can leave a result comment", async () => {
    const { store: s } = makeWiredStore(dir);
    const t = await s.create({ title: "x", assignee: "alice", created_by: "bob" });

    const denied = await call(
      "task_comment",
      { id: t.id, body: "the answer", kind: "result" },
      { agentId: "bob" }
    );
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toMatch(/Only the assignee/);

    const allowed = await call(
      "task_comment",
      { id: t.id, body: "the answer", kind: "result" },
      { agentId: "alice" }
    );
    expect(allowed.ok).toBe(true);
    expect((allowed as { comment: Comment }).comment.kind).toBe("result");
  });

  it("maps mode comment/result to stored comment kind", async () => {
    const { store: s } = makeWiredStore(dir);
    const t = await s.create({ title: "x", assignee: "alice", created_by: "bob" });

    const ordinary = await call(
      "task_comment",
      { id: t.id, body: "progress", mode: "comment" },
      { agentId: "alice" }
    );
    expect(ordinary.ok).toBe(true);
    expect((ordinary as { comment: Comment }).comment.kind).toBeNull();

    const result = await call(
      "task_comment",
      { id: t.id, body: "the answer", mode: "result" },
      { agentId: "alice" }
    );
    expect(result.ok).toBe(true);
    expect((result as { comment: Comment }).comment.kind).toBe("result");
  });

  it("system kind is not exposed via the tool schema", async () => {
    const { store: s } = makeWiredStore(dir);
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    // The Zod schema only allows "result"; passing "system" should fail
    // validation upstream of the handler. Here we go through registry which
    // passes args through as-is — the handler does not write system kind
    // because the schema rejects it via the SDK boundary. Verify by direct
    // attempt: passing kind:"system" lands as undefined post-Zod, so the
    // resulting comment has kind: null, not system.
    const r = await call(
      "task_comment",
      // @ts-expect-error — deliberately probing the tool's schema gate
      { id: t.id, body: "shouldn't be system", kind: "system" },
      { agentId: "a" }
    );
    if (r.ok) {
      const c = (r as { comment: Comment }).comment;
      expect(c.kind).not.toBe("system");
    }
    // Either way: no system-kind comment should exist via this path.
    const all = s.listComments(t.id);
    for (const c of all) expect(c.kind).not.toBe("system");
  });

  it("lists comments oldest-first and supports kinds filter", async () => {
    const { store: s } = makeWiredStore(dir);
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    await call(
      "task_comment",
      { id: t.id, body: "first" },
      { agentId: "a" }
    );
    await call(
      "task_comment",
      { id: t.id, body: "second" },
      { agentId: "a" }
    );
    await call(
      "task_comment",
      { id: t.id, body: "the answer", kind: "result" },
      { agentId: "a" }
    );

    const all = await call("task_comments", { id: t.id }, { agentId: "a" });
    expect(all.ok).toBe(true);
    const list = (all as { comments: Comment[] }).comments;
    expect(list).toHaveLength(3);
    expect(list[0]!.body).toBe("first");

    const onlyResult = await call(
      "task_comments",
      { id: t.id, kinds: ["result"] },
      { agentId: "a" }
    );
    const r = (onlyResult as { comments: Comment[] }).comments;
    expect(r).toHaveLength(1);
    expect(r[0]!.body).toBe("the answer");
  });
});

describe("task_update soft-warn on done-without-result", () => {
  it("warns when assignee marks done with no result comment", async () => {
    const { store: s } = makeWiredStore(dir);
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    const r = await call(
      "task_update",
      { id: t.id, status: "done" },
      { agentId: "a" }
    );
    expect(r.ok).toBe(true);
    expect(String(r.warning ?? "")).toMatch(/result comment/i);
  });

  it("does not warn when a result comment exists", async () => {
    const { store: s } = makeWiredStore(dir);
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    await call(
      "task_comment",
      { id: t.id, body: "ans", kind: "result" },
      { agentId: "a" }
    );
    const r = await call(
      "task_update",
      { id: t.id, status: "done" },
      { agentId: "a" }
    );
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("does not warn for non-done status changes", async () => {
    const { store: s } = makeWiredStore(dir);
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    const r = await call(
      "task_update",
      { id: t.id, status: "in_progress" },
      { agentId: "a" }
    );
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("does not warn when the closer is not the assignee", async () => {
    const { store: s } = makeWiredStore(dir);
    const t = await s.create({ title: "x", assignee: "a", created_by: "b" });
    // Different agent (not the assignee) marks done — no warn since the
    // result-comment expectation is on the assignee.
    const r = await call(
      "task_update",
      { id: t.id, status: "done" },
      { agentId: "b" }
    );
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });
});
