import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@openacme/config";
import { createApp } from "../src/app.js";
import type { AgentManager } from "../src/agent-manager.js";
import type { Hono } from "hono";

/**
 * Route-level tests over a real createApp() against a temp data dir.
 * Everything here stays short of an actual agent turn — no LLM is
 * ever called; the chat tests exercise only the validation layers
 * that run before runChatTurn kicks off.
 */

let dataDir: string;
let app: Hono;
let manager: AgentManager;
let authToken: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-routes-"));
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  ({ app, manager } = await createApp(config));
  // Auth is always on now — seed an operator and a session so the route
  // tests authenticate via a bearer token.
  const member = manager.authStore.createMember({
    email: "test@example.com",
    password: "test-password-123",
  });
  authToken = manager.authStore.createSession(member.id).token;
});

afterEach(async () => {
  await manager.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// Attach the seeded session as a bearer token (synthetic app.request
// Requests carry no cookie). Host header is irrelevant to auth now.
function req(p: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1");
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${authToken}`);
  return app.request(`http://127.0.0.1${p}`, { ...init, headers });
}

async function createAgent(id = "helper", name = "Helper") {
  const res = await req("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

// Uploads sniff magic bytes and only accept the allowed MIME set —
// a bare PNG signature is the smallest thing that passes.
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

async function uploadFile(filename = "pix.png") {
  const form = new FormData();
  form.append(
    "files",
    new File([PNG_BYTES], filename, { type: "image/png" })
  );
  const res = await req("/api/uploads", {
    method: "POST",
    body: form,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    attachments: Array<{ pendingId: string; url: string; filename: string }>;
  };
  return body.attachments[0]!;
}

describe("health", () => {
  it("reports ok with zero agents on a fresh data dir", async () => {
    const res = await req("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.agents).toBe(0);
  });
});

describe("agents CRUD", () => {
  it("creates, lists, updates, deletes", async () => {
    await createAgent();

    let res = await req("/api/agents");
    let list = (await res.json()) as Array<{ id: string; name: string }>;
    expect(list.map((a) => a.id)).toEqual(["helper"]);

    res = await req("/api/agents/helper", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Helper Two" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Helper Two");

    res = await req("/api/agents/helper", { method: "DELETE" });
    expect(res.status).toBe(200);

    res = await req("/api/agents");
    list = await res.json();
    expect(list).toHaveLength(0);
  });

  it("rejects invalid definitions and unknown ids", async () => {
    const bad = await req("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x" }),
    });
    expect(bad.status).toBe(400);

    const missing = await req("/api/agents/nope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "y" }),
    });
    expect(missing.status).toBe(404);

    const del = await req("/api/agents/nope", { method: "DELETE" });
    expect(del.status).toBe(404);
  });
});

describe("chat validation", () => {
  it("rejects malformed bodies before touching any state", async () => {
    const badJson = await req("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);

    const missingFields = await req("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingFields.status).toBe(400);

    const unknownAgent = await req("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "nope", messages: [] }),
    });
    expect(unknownAgent.status).toBe(404);
  });

  it("rejects an unknown pending attachment without moving valid ones (validate-then-commit)", async () => {
    await createAgent();
    const att = await uploadFile();

    const res = await req("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "helper",
        sessionId: "11111111-1111-4111-8111-111111111111",
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [
              { type: "text", text: "look at these" },
              {
                type: "file",
                url: att.url,
                mediaType: "image/png",
                filename: att.filename,
              },
              {
                type: "file",
                url: "/api/attachments/__pending__/pend_bogus/x.png",
                mediaType: "image/png",
                filename: "x.png",
              },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown or expired attachment/);

    // The valid pending file must NOT have been committed — a partial
    // commit would orphan it under the session dir.
    const pendingPath = path.join(
      dataDir,
      "attachments",
      "__pending__",
      att.pendingId,
      att.filename
    );
    expect(existsSync(pendingPath)).toBe(true);
  });
});

describe("attachments", () => {
  it("serves uploaded pending files back", async () => {
    const att = await uploadFile();
    const res = await req(att.url);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(PNG_BYTES);
  });

  it("rejects path traversal out of the attachments root", async () => {
    // Bare `..` segments are normalized away by the URL parser before
    // routing; %2F-embedded dots survive to the param decode and hit
    // the route's own containment check.
    const res = await req(
      "/api/attachments/a%2F..%2F..%2F..%2Fsecret/x/config.yaml"
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/escapes root/);
  });

  it("404s for unknown attachments", async () => {
    const res = await req(
      "/api/attachments/no-session/no-att/missing.txt"
    );
    expect(res.status).toBe(404);
  });
});

describe("sessions", () => {
  it("lists, fetches, and deletes sessions", async () => {
    await createAgent();
    const session = manager.sessionStore.create("helper", { title: "t1" });

    let res = await req("/api/agents/helper/sessions");
    expect(((await res.json()) as unknown[]).length).toBe(1);

    res = await req(`/api/sessions/${session.id}`);
    expect(res.status).toBe(200);

    res = await req(`/api/sessions/${session.id}/messages`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);

    res = await req(`/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    res = await req(`/api/sessions/${session.id}`);
    expect(res.status).toBe(404);
  });

  it("active-turn cancel is a 404 when no turn is running", async () => {
    const res = await req("/api/sessions/whatever/active-turn", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns session-scoped events (ping_resolved) for the chat badge", async () => {
    await createAgent();
    const session = manager.sessionStore.create("helper");
    manager.eventStore.append({
      sessionId: session.id,
      agentId: "helper",
      kind: "ping_user",
      payload: { message: "deploy now?" },
    });
    manager.eventStore.append({
      sessionId: session.id,
      agentId: "helper",
      actor: "helper",
      kind: "ping_resolved",
      payload: { resolvedBy: "acme", reason: "window passed" },
    });

    const res = await req(`/api/sessions/${session.id}/events`);
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as {
      events: Array<{ kind: string; payload: string | null; createdAt: number }>;
    };
    const resolved = events.find((e) => e.kind === "ping_resolved");
    expect(resolved).toBeTruthy();
    expect(typeof resolved!.createdAt).toBe("number");
    expect(JSON.parse(resolved!.payload!).reason).toBe("window passed");
  });

  it("session events endpoint is lazy on unknown sessions (empty, not 404)", async () => {
    const res = await req("/api/sessions/does-not-exist/events");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [] });
  });

  it("queued-message cancel 404s on unknown sessions and reports cancelled=0 on drained ones", async () => {
    const unknown = await req("/api/sessions/nope/queued/m1", {
      method: "DELETE",
    });
    expect(unknown.status).toBe(404);

    await createAgent();
    const session = manager.sessionStore.create("helper");
    const res = await req(
      `/api/sessions/${session.id}/queued/m1`,
      { method: "DELETE" }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: 0 });
  });
});

describe("tasks", () => {
  it("lists (body stripped), fetches, patches, comments, deletes", async () => {
    const task = await manager.taskStore.create({
      title: "Ship it",
      assignee: "helper",
      created_by: "user",
      body: "Long spec body",
    });

    let res = await req("/api/tasks");
    const list = (await res.json()) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]!.id).toBe(task.id);
    expect(list.tasks[0]!.body).toBeUndefined();
    expect(list.tasks[0]!.comment_count).toBe(0);

    res = await req(`/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
    // The store normalizes bodies with a trailing newline.
    expect((await res.json()).task.body).toBe("Long spec body\n");

    res = await req(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });
    expect(res.status).toBe(400);

    res = await req(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).task.status).toBe("done");

    res = await req(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "looks good" }),
    });
    expect(res.status).toBe(200);

    // HTTP comments are always untagged — result/system are reserved.
    res = await req(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "x", kind: "system" }),
    });
    expect(res.status).toBe(400);

    res = await req(`/api/tasks/${task.id}/comments`);
    const comments = (await res.json()) as { comments: unknown[] };
    expect(comments.comments).toHaveLength(1);

    res = await req(`/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    res = await req(`/api/tasks/${task.id}`);
    expect(res.status).toBe(404);
  });

  it("404s unknown ids and 400s malformed ones", async () => {
    const notFound = await req("/api/tasks/zzzz9999");
    expect([400, 404]).toContain(notFound.status);

    const malformed = await req(
      `/api/tasks/${encodeURIComponent("../escape")}`
    );
    expect(malformed.status).toBe(400);
  });
});

describe("skills edit", () => {
  it("PUT updates body/tags and 404s on unknown names", async () => {
    const create = await req("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "triage",
        description: "Triage issues",
        tags: ["ops"],
        body: "# v1",
      }),
    });
    expect(create.status).toBe(201);

    const update = await req("/api/skills/triage", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "# v2", tags: ["ops", "github"] }),
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as {
      body: string;
      tags: string[];
      description: string;
    };
    expect(updated.body.trim()).toBe("# v2");
    expect(updated.tags).toEqual(["ops", "github"]);
    expect(updated.description).toBe("Triage issues");

    const missing = await req("/api/skills/nope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "x" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("teams", () => {
  it("creates, fetches, and updates a team; manager must be a member", async () => {
    await createAgent();

    let res = await req("/api/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "core",
        name: "Core",
        members: ["helper"],
        manager: "helper",
        charter: "# Core charter",
      }),
    });
    expect(res.status).toBe(201);

    res = await req("/api/teams/core");
    expect(res.status).toBe(200);
    const team = await res.json();
    expect(team.manager).toBe("helper");
    expect(team.charter).toBe("# Core charter");

    res = await req("/api/teams/core", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manager: "ghost" }),
    });
    expect(res.status).toBe(400);

    res = await req("/api/teams/nope");
    expect(res.status).toBe(404);
  });
});
