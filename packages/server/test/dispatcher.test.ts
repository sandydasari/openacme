import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "@openacme/config";
import {
  createDatabase,
  createCommentStore,
  createSessionStore,
  createInboxStore,
} from "@openacme/db";
import { TaskStore } from "@openacme/tasks";
import { Dispatcher } from "../src/dispatcher.js";
import type { AgentManager } from "../src/agent-manager.js";

/**
 * Dispatcher tests against real stores (sqlite in a temp data dir,
 * filesystem TaskStore) with only the AgentManager faked — the
 * dispatcher only calls listAgents / getAgentDef / getAgent on it,
 * and a real manager would build a real Agent (LLM-backed) on spawn.
 */

type TurnCall = { agentId: string; sessionId: string };

function fakeManager(
  agentIds: string[],
  turn: (sessionId: string) => Promise<void> = async () => {}
): { manager: AgentManager; calls: TurnCall[] } {
  const calls: TurnCall[] = [];
  const manager = {
    listAgents: () => agentIds.map((id) => ({ id })),
    getAgentDef: (id: string) =>
      agentIds.includes(id) ? { id } : null,
    getAgent: (id: string) => ({
      runAutonomous: async ({ sessionId }: { sessionId: string }) => {
        calls.push({ agentId: id, sessionId });
        await turn(sessionId);
      },
    }),
  } as unknown as AgentManager;
  return { manager, calls };
}

let dataDir: string;
let db: ReturnType<typeof createDatabase>;
let sessionStore: ReturnType<typeof createSessionStore>;
let inboxStore: ReturnType<typeof createInboxStore>;
let taskStore: TaskStore;
let dispatcher: Dispatcher | null;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-dispatch-"));
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  db = createDatabase(config);
  sessionStore = createSessionStore(db);
  inboxStore = createInboxStore(db);
  taskStore = new TaskStore(path.join(dataDir, "tasks"), {
    commentStore: createCommentStore(db),
  });
  dispatcher = null;
});

afterEach(() => {
  dispatcher?.stop();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function makeDispatcher(
  manager: AgentManager,
  opts: { now?: () => Date } = {}
): Dispatcher {
  dispatcher = new Dispatcher({
    taskStore,
    sessionStore,
    inboxStore,
    agentManager: manager,
    // Long enough that the unref'd interval never fires in a test;
    // ticks are driven manually.
    tickIntervalMs: 3_600_000,
    ...opts,
  });
  return dispatcher;
}

/** Drive one tick and wait for any spawned turns to finish. */
async function tick(d: Dispatcher): Promise<void> {
  await (d as unknown as { tickSafe(): Promise<void> }).tickSafe();
  await d.drain(5_000);
}

async function makeBoundTask(
  agentId: string,
  overrides: Record<string, unknown> = {}
) {
  const session = sessionStore.create(agentId);
  const task = await taskStore.create({
    title: `work for ${agentId}`,
    assignee: agentId,
    created_by: "user",
  });
  const bound = await taskStore.update(task.id, {
    session_id: session.id,
    ...overrides,
  });
  return { session, task: bound };
}

describe("Dispatcher spawn rule", () => {
  it("spawns a turn for a session with a ready open task", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const { session } = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
  });

  it("does not spawn when the only task has a future start_at", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    await makeBoundTask("a1", {
      start_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([]);
  });

  it("waits for dependencies, then spawns once they are done", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    // Dep assigned to an agent the manager doesn't know — it can never
    // be picked up by this dispatcher, so only the dep edge matters.
    const dep = await taskStore.create({
      title: "dep",
      assignee: "ghost",
      created_by: "user",
    });
    await makeBoundTask("a1", { depends_on: [dep.id] });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);
    expect(calls).toEqual([]);

    await taskStore.update(dep.id, { status: "done" });
    await tick(d);
    expect(calls).toHaveLength(1);
  });

  it("wakes on a pending inbox row even with no tasks", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const session = sessionStore.create("a1");
    inboxStore.deliver({
      agentId: "a1",
      kind: "system_notice",
      source: "system",
      relatedSession: session.id,
      payload: { note: "ping" },
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
  });

  it("defer_until suppresses routine wakes but an inbox row bypasses it", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const { session } = await makeBoundTask("a1");
    sessionStore.setDeferUntil(
      session.id,
      Math.floor(Date.now() / 1000) + 3600
    );

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);
    expect(calls).toEqual([]);

    inboxStore.deliver({
      agentId: "a1",
      kind: "system_notice",
      source: "system",
      relatedSession: session.id,
      payload: { note: "real signal" },
    });
    await tick(d);
    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
  });

  it("skips interactive-busy sessions and picks them up on clear", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const { session } = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    d.markInteractiveBusy(session.id);
    await d.start();
    await d.drain(5_000);
    expect(calls).toEqual([]);
    expect(d.isRunning(session.id)).toBe(true);
    expect(d.runningSessionIds()).toEqual([session.id]);

    // clearInteractiveBusy fires an immediate (unawaited) tick.
    d.clearInteractiveBusy(session.id);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ agentId: "a1", sessionId: session.id });
  });

  it("runs one session per agent per tick", async () => {
    // The fake turn closes out the session's tasks, the way a real
    // agent would — otherwise the same session stays "ready" and wins
    // every subsequent tick.
    const turn = async (sessionId: string) => {
      for (const t of taskStore.list({ session_id: sessionId, status: "open" })) {
        await taskStore.update(t.id, { status: "done" });
      }
    };
    const { manager, calls } = fakeManager(["a1"], turn);
    const a = await makeBoundTask("a1");
    const b = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);
    expect(calls).toHaveLength(1);

    await tick(d);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.sessionId))).toEqual(
      new Set([a.session.id, b.session.id])
    );
  });

  it("binds unbound ready tasks to a fresh session and spawns it", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const task = await taskStore.create({
      title: "Write the launch post",
      assignee: "a1",
      created_by: "user",
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    const bound = taskStore.get(task.id);
    expect(bound?.session_id).toBeTruthy();
    expect(calls).toEqual([
      { agentId: "a1", sessionId: bound!.session_id },
    ]);
    const session = sessionStore.get(bound!.session_id!);
    expect(session?.title).toBe("Write the launch post");
  });
});

describe("Dispatcher failure handling", () => {
  it("parks the in-progress task when the turn errors", async () => {
    const { manager, calls } = fakeManager(["a1"], async () => {
      throw new Error("boom");
    });
    const { session, task } = await makeBoundTask("a1", {
      status: "in_progress",
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
    const parked = taskStore.get(task.id);
    expect(parked?.status).toBe("blocked");
    const retryAt = Date.parse(parked!.start_at!);
    // Park backoff is 5 minutes.
    expect(retryAt).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(retryAt).toBeLessThan(Date.now() + 6 * 60_000);
  });

  it("parks plain object turn errors with a readable provider message", async () => {
    const { manager } = fakeManager(["a1"], async () => {
      throw {
        status: 400,
        error: {
          message: "Unsupported model gpt-5.2 for OpenAI OAuth",
          type: "invalid_request_error",
        },
      };
    });
    const { task } = await makeBoundTask("a1", {
      status: "in_progress",
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    const parked = taskStore.get(task.id);
    expect(parked?.status).toBe("blocked");
    const comments = taskStore.listComments(task.id, { kinds: ["system"] });
    expect(comments.at(-1)?.body).toContain(
      "Unsupported model gpt-5.2 for OpenAI OAuth"
    );
    expect(comments.at(-1)?.body).not.toContain("[object Object]");
  });

  it("startup sweep resets stale in_progress tasks to open", async () => {
    // Assignee unknown to the manager: nothing can spawn, isolating
    // the sweep itself.
    const { manager, calls } = fakeManager([]);
    const { task } = await makeBoundTask("ghost", {
      status: "in_progress",
    });

    const d = makeDispatcher(manager, {
      // Staleness threshold is 10 minutes from updated_at.
      now: () => new Date(Date.now() + 11 * 60_000),
    });
    await d.start();
    await d.drain(5_000);

    expect(taskStore.get(task.id)?.status).toBe("open");
    expect(calls).toEqual([]);
  });
});

describe("Dispatcher recurring wake floor", () => {
  it("does not re-wake an in_progress interval task before its interval elapses", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const session = sessionStore.create("a1");
    const created = await taskStore.create({
      title: "tick task",
      assignee: "a1",
      created_by: "user",
      recurrence: { kind: "interval", every_ms: 60_000 },
    });
    // One full done-cycle stamps last_run_at; then the agent leaves it
    // claimed in_progress between fires (the pattern the floor exists for).
    await taskStore.update(created.id, {
      session_id: session.id,
      status: "in_progress",
    });
    await taskStore.update(created.id, { status: "done" });
    await taskStore.update(created.id, {
      session_id: session.id,
      status: "in_progress",
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);
    expect(calls).toEqual([]);
    d.stop();

    // 61s later the interval has elapsed — the same state now spawns.
    const later = makeDispatcher(manager, {
      now: () => new Date(Date.now() + 61_000),
    });
    await later.start();
    await later.drain(5_000);
    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
  });
});
