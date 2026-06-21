import { describe, it, expect, beforeEach } from "vitest";
import { WasmDatabase } from "../src/wasm/adapter.js";
import { applySchema } from "../src/connection.js";
import { createSessionStore } from "../src/stores/session-store.js";
import { createMessageStore } from "../src/stores/message-store.js";

function freshDb() {
  const db = new WasmDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  // sessions.agent_id is now a plain text label (agents live as YAML files,
  // not in this DB) — no seed row needed.
  return db;
}

describe("SessionStore — fork chain", () => {
  let db: WasmDatabase;
  let sessions: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    db = freshDb();
    sessions = createSessionStore(db);
  });

  it("create roundtrips parent_session_id", () => {
    const parent = sessions.create("a1", { id: "s-parent" });
    expect(parent.parentSessionId).toBeNull();

    const child = sessions.create("a1", {
      id: "s-child",
      parentSessionId: parent.id,
    });
    expect(child.parentSessionId).toBe(parent.id);

    const refetched = sessions.get(child.id);
    expect(refetched?.parentSessionId).toBe(parent.id);
  });

  it("findChildOf returns null with no child, then the child once created", () => {
    const parent = sessions.create("a1", { id: "p1" });
    expect(sessions.findChildOf(parent.id)).toBeNull();
    const child = sessions.createChildIfNoSibling("a1", parent.id, {
      title: "x",
    });
    expect(child).not.toBeNull();
    const found = sessions.findChildOf(parent.id);
    expect(found?.id).toBe(child!.id);
    expect(found?.parentSessionId).toBe(parent.id);
  });

  it("createChildIfNoSibling refuses a second child of the same parent", () => {
    const parent = sessions.create("a1", { id: "p2" });
    const c1 = sessions.createChildIfNoSibling("a1", parent.id);
    const c2 = sessions.createChildIfNoSibling("a1", parent.id);
    expect(c1).not.toBeNull();
    expect(c2).toBeNull(); // race-loser
    // findChildOf still returns the original winner.
    expect(sessions.findChildOf(parent.id)?.id).toBe(c1!.id);
  });

  it("listActive hides compressed-away parents but keeps the active child visible", () => {
    const standalone = sessions.create("a1", { id: "standalone" });
    const parent = sessions.create("a1", { id: "parent" });
    const child = sessions.createChildIfNoSibling("a1", parent.id);

    const active = sessions.listActive("a1").map((s) => s.id);
    expect(active).toContain(standalone.id);
    expect(active).not.toContain(parent.id);
    // The child is the live conversation post-fork — it must stay visible
    // in the sidebar, otherwise the user loses access to their chat after
    // compression triggers.
    expect(active).toContain(child!.id);
  });

  it("inherits title via opts when forking from a titled parent", () => {
    sessions.create("a1", { id: "p3", title: "Parent title" });
    sessions.updateTitle("p3", "Parent title");
    const child = sessions.createChildIfNoSibling("a1", "p3", {
      title: "Parent title",
    });
    expect(child?.title).toBe("Parent title");
  });

  describe("getRoot", () => {
    it("returns the input id for a root session", () => {
      sessions.create("a1", { id: "root1" });
      expect(sessions.getRoot("root1")).toBe("root1");
    });

    it("walks one level up from a child", () => {
      sessions.create("a1", { id: "p" });
      sessions.create("a1", { id: "c", parentSessionId: "p" });
      expect(sessions.getRoot("c")).toBe("p");
    });

    it("walks the whole chain to the topmost ancestor", () => {
      sessions.create("a1", { id: "g" });
      sessions.create("a1", { id: "p", parentSessionId: "g" });
      sessions.create("a1", { id: "c", parentSessionId: "p" });
      expect(sessions.getRoot("c")).toBe("g");
    });

    it("returns the input id when the session row doesn't exist", () => {
      expect(sessions.getRoot("missing")).toBe("missing");
    });

    it("breaks cycles instead of looping forever", () => {
      // Sneak past the FK by inserting both rows then patching parents
      // through raw SQL — drizzle won't let us build a cycle via the API.
      sessions.create("a1", { id: "x" });
      sessions.create("a1", { id: "y", parentSessionId: "x" });
      db.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(
        "y",
        "x"
      );
      const root = sessions.getRoot("x");
      // Either node is acceptable; what matters is it returns rather than
      // hangs.
      expect(["x", "y"]).toContain(root);
    });
  });
});

describe("MessageStore — appendMany and ordering", () => {
  let db: WasmDatabase;
  let sessions: ReturnType<typeof createSessionStore>;
  let messages: ReturnType<typeof createMessageStore>;

  function uiMessage(role: "user" | "assistant", text: string) {
    return {
      id: `m-${role}-${text}`,
      role,
      parts: [{ type: "text", text }],
    };
  }

  function getText(m: { parts: unknown[] }): string {
    const p = m.parts.find(
      (x): x is { type: "text"; text: string } =>
        !!x && typeof x === "object" && (x as { type?: unknown }).type === "text"
    );
    return p?.text ?? "";
  }

  beforeEach(() => {
    db = freshDb();
    sessions = createSessionStore(db);
    messages = createMessageStore(db);
    sessions.create("a1", { id: "s1" });
  });

  it("appendMany inserts all messages and returns them in order", () => {
    const out = messages.appendMany("s1", [
      uiMessage("user", "a"),
      uiMessage("assistant", "b"),
      uiMessage("user", "c"),
    ]);
    expect(out.length).toBe(3);
    expect(out.map(getText)).toEqual(["a", "b", "c"]);
  });

  it("getHistory returns messages in insertion order even when created_at ties", () => {
    // unixepoch() is second-resolution; a tight bulk insert lands inside
    // a single second. The ORDER BY rowid tie-break must keep insertion
    // order so consumers see deterministic ordering.
    const inputs: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (let i = 0; i < 50; i++) {
      inputs.push({ role: i % 2 === 0 ? "user" : "assistant", text: `m${i}` });
    }
    messages.appendMany(
      "s1",
      inputs.map((m, i) => ({
        id: `m-${i}`,
        role: m.role,
        parts: [{ type: "text", text: m.text }],
      }))
    );

    const loaded = messages.getHistory("s1");
    expect(loaded.length).toBe(50);
    expect(loaded.map(getText)).toEqual(inputs.map((i) => i.text));
  });

  it("appendMany is atomic — partial failure rolls back", () => {
    // Force a NOT NULL violation on the second row to trigger rollback.
    expect(() =>
      messages.appendMany("s1", [
        uiMessage("user", "ok"),
        // Invalid: role is NOT NULL — passing null reaches the bind layer
        // and SQLite rejects the row.
        {
          id: "bad",
          role: null as unknown as "user",
          parts: [{ type: "text", text: "bad" }],
        },
      ])
    ).toThrow();

    // Neither row should have been persisted.
    const history = messages.getHistory("s1");
    expect(history.length).toBe(0);
  });

  it("FTS5 search finds text from text-parts after appendMany", () => {
    messages.appendMany("s1", [
      uiMessage("user", "the quick brown fox"),
      uiMessage("assistant", "lazy dog"),
    ]);
    const hits = messages.search("brown");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain("brown");
  });

  it("FTS5 indexes only text parts, not tool-${name} or file parts", () => {
    messages.appendMany("s1", [
      uiMessage("user", "the quick brown fox"),
      {
        id: "m-tool",
        role: "assistant",
        parts: [
          { type: "text", text: "calling shell" },
          {
            type: "tool-shell",
            toolCallId: "c1",
            state: "output-available",
            input: { command: "secret-keyword-xyz" },
            output: { stdout: "result-keyword-abc" },
          },
        ],
      },
    ]);
    // Tool input/output JSON shouldn't appear in FTS hits.
    expect(messages.search("secret-keyword-xyz").length).toBe(0);
    expect(messages.search("result-keyword-abc").length).toBe(0);
    // Text parts still hit.
    expect(messages.search("calling").length).toBeGreaterThan(0);
  });
});

describe("EventStore — unresolvedPingsBySession (inbox resolution rule)", () => {
  let db: WasmDatabase;
  let sessions: ReturnType<typeof createSessionStore>;
  let messages: ReturnType<typeof createMessageStore>;

  beforeEach(async () => {
    db = freshDb();
    sessions = createSessionStore(db);
    messages = createMessageStore(db);
  });

  it("returns pings that have no user message after them", async () => {
    const { createEventStore } = await import("../src/stores/event-store.js");
    const events = createEventStore(db);
    const s = sessions.create("a1");
    events.append({
      sessionId: s.id,
      agentId: "a1",
      kind: "ping_user",
      payload: { message: "need help" },
    });
    const unresolved = events.unresolvedPingsBySession();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.sessionId).toBe(s.id);
    expect(unresolved[0]!.message).toBe("need help");
  });

  it("filters out pings followed by any user message in the session", async () => {
    const { createEventStore } = await import("../src/stores/event-store.js");
    const events = createEventStore(db);
    const s = sessions.create("a1");
    events.append({
      sessionId: s.id,
      agentId: "a1",
      kind: "ping_user",
      payload: { message: "need help" },
    });
    // Wait a beat so the user message has a strictly later created_at
    // (unixepoch() is second-resolution).
    await new Promise((r) => setTimeout(r, 1100));
    messages.append(s.id, { id: "m1", role: "user", parts: [] });
    const unresolved = events.unresolvedPingsBySession();
    expect(unresolved).toHaveLength(0);
  });

  it("returns only the latest ping per session", async () => {
    const { createEventStore } = await import("../src/stores/event-store.js");
    const events = createEventStore(db);
    const s = sessions.create("a1");
    events.append({
      sessionId: s.id,
      agentId: "a1",
      kind: "ping_user",
      payload: { message: "first" },
    });
    await new Promise((r) => setTimeout(r, 1100));
    events.append({
      sessionId: s.id,
      agentId: "a1",
      kind: "ping_user",
      payload: { message: "second" },
    });
    const unresolved = events.unresolvedPingsBySession();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.message).toBe("second");
  });

  it("scopes per session — pings in different sessions are independent", async () => {
    const { createEventStore } = await import("../src/stores/event-store.js");
    const events = createEventStore(db);
    const s1 = sessions.create("a1");
    const s2 = sessions.create("a1");
    events.append({
      sessionId: s1.id,
      agentId: "a1",
      kind: "ping_user",
      payload: { message: "s1" },
    });
    events.append({
      sessionId: s2.id,
      agentId: "a1",
      kind: "ping_user",
      payload: { message: "s2" },
    });
    // Resolve only s1 with a user message.
    await new Promise((r) => setTimeout(r, 1100));
    messages.append(s1.id, { id: "m1", role: "user", parts: [] });
    const unresolved = events.unresolvedPingsBySession();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.sessionId).toBe(s2.id);
  });

  it("filters out pings retired by a later ping_resolved event (proactive close)", async () => {
    const { createEventStore } = await import("../src/stores/event-store.js");
    const events = createEventStore(db);
    const s = sessions.create("a1");
    events.append({
      sessionId: s.id,
      agentId: "a1",
      kind: "ping_user",
      payload: { message: "still relevant?" },
    });
    // Acme withdraws it — no user message ever arrives.
    events.append({
      sessionId: s.id,
      agentId: "a1",
      actor: "a1",
      kind: "ping_resolved",
      payload: { resolvedBy: "acme", reason: "task canceled" },
    });
    const unresolved = events.unresolvedPingsBySession();
    expect(unresolved).toHaveLength(0);
  });

  it("a ping_resolved before a newer ping does not clear the newer ping", async () => {
    const { createEventStore } = await import("../src/stores/event-store.js");
    const events = createEventStore(db);
    const s = sessions.create("a1");
    events.append({
      sessionId: s.id,
      agentId: "a1",
      kind: "ping_user",
      payload: { message: "first" },
    });
    events.append({
      sessionId: s.id,
      agentId: "a1",
      actor: "a1",
      kind: "ping_resolved",
      payload: { resolvedBy: "acme", reason: "stale" },
    });
    await new Promise((r) => setTimeout(r, 1100));
    events.append({
      sessionId: s.id,
      agentId: "a1",
      kind: "ping_user",
      payload: { message: "second — new question" },
    });
    const unresolved = events.unresolvedPingsBySession();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.message).toBe("second — new question");
  });
});
