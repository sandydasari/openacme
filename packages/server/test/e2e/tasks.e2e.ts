import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startE2EServer, openSSE, type E2EServer } from "./support/harness.js";
import { makeClient, isState, waitUntil } from "./support/client.js";

/**
 * The workforce loop, end to end: task tools an agent invokes for real, cross-
 * agent assignment, coworker discovery, and the dispatcher waking an assignee.
 */

describe("task tools (e2e)", () => {
  let srv: E2EServer;
  let c: ReturnType<typeof makeClient>;

  beforeAll(async () => {
    srv = await startE2EServer();
    c = makeClient(srv.baseUrl);
    await c.createAgent("helper");
    await c.createAgent("worker");
  });
  afterAll(async () => {
    await srv.close();
  });

  it("an agent creates a task assigned to a coworker", async () => {
    await c.chat("helper", '[[mock:tool:task_create:{"title":"Ship the docs","assignee":"worker"}]]');

    await waitUntil(async () => {
      const { tasks } = await c.json("/api/tasks");
      return tasks.some((t: any) => t.title === "Ship the docs");
    });

    const { tasks } = await c.json("/api/tasks");
    const task = tasks.find((t: any) => t.title === "Ship the docs");
    expect(task.assignee).toBe("worker");
    expect(task.created_by).toBe("helper");
  });

  it("an agent advances and resolves a task through its lifecycle", async () => {
    await c.chat("helper", '[[mock:tool:task_create:{"title":"Fix the bug","assignee":"helper"}]]');
    await waitUntil(async () => {
      const { tasks } = await c.json("/api/tasks");
      return tasks.some((t: any) => t.title === "Fix the bug");
    });
    const task = (await c.json("/api/tasks")).tasks.find((t: any) => t.title === "Fix the bug");

    await c.chat("helper", `[[mock:tool:task_update:${JSON.stringify({ id: task.id, status: "in_progress" })}]]`);
    await waitUntil(async () => (await c.json(`/api/tasks/${task.id}`)).task.status === "in_progress");

    await c.chat("helper", `[[mock:tool:task_comment:${JSON.stringify({ id: task.id, body: "shipped it", mode: "result" })}]]`);
    await waitUntil(async () => {
      const { comments } = await c.json(`/api/tasks/${task.id}/comments`);
      return comments.some((cm: any) => cm.body.includes("shipped it"));
    });

    const { comments } = await c.json(`/api/tasks/${task.id}/comments`);
    expect(comments.some((cm: any) => cm.kind === "result")).toBe(true);
  });

  it("an agent can look up its coworkers", async () => {
    const { sessionId } = await c.chat("helper", "who's around? [[mock:tool:agent_list:{}]]");
    await waitUntil(async () => {
      const msgs = await c.messages(sessionId);
      const a = msgs.find((m) => m.role === "assistant");
      return !!a?.parts.some((p) => p?.type === "tool-agent_list" && p.state === "output-available");
    });
    const a = (await c.messages(sessionId)).find((m) => m.role === "assistant")!;
    const toolPart = a.parts.find((p) => p?.type === "tool-agent_list");
    expect(JSON.stringify(toolPart)).toContain("worker");
  });
});

describe("autonomous dispatch (e2e)", () => {
  let srv: E2EServer;
  let c: ReturnType<typeof makeClient>;

  beforeAll(async () => {
    // Short tick so the dispatcher wakes the assignee in ~1 tick, not 60s.
    srv = await startE2EServer({ dispatcher: true, tickMs: 400 });
    c = makeClient(srv.baseUrl);
    await c.createAgent("worker");
  });
  afterAll(async () => {
    await srv.close();
  });

  it("the dispatcher wakes the assignee for a ready task", async () => {
    // Bind to a real session we can watch (the task store requires the
    // session to exist), then open SSE before seeding the task.
    const session = srv.manager.sessionStore.create("worker");
    const sessionId = session.id;
    const sse = await openSSE(`${srv.baseUrl}/api/sessions/${sessionId}/stream`);

    // Seed a ready, assigned task bound to that session. The dispatcher's next
    // tick should spawn an autonomous turn into it.
    await srv.manager.taskStore.create({
      title: "Autonomous work",
      assignee: "worker",
      created_by: "user",
      session_id: sessionId,
    });

    // The wake fired: an autonomous turn ran on this exact session.
    await sse.waitFor(isState("running"), 8_000);
    await sse.waitFor(isState("idle"), 12_000);

    sse.close();
  });
});
