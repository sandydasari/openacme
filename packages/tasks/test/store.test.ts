import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore, TaskStoreError } from "../src/store.js";

let dir: string;
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "openacme-tasks-"));
  store = new TaskStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskStore CRUD", () => {
  it("creates a task and reads it back", async () => {
    const t = await store.create({
      title: "Ship the auth flow",
      assignee: "backend",
      created_by: "founder-agent",
      body: "Body content here.",
    });

    expect(t.id).toBeTruthy();
    expect(t.status).toBe("open");
    expect(t.created_at).toBe(t.updated_at);
    expect(existsSync(path.join(dir, `${t.id}.md`))).toBe(true);

    const read = store.get(t.id);
    expect(read).not.toBeNull();
    expect(read!.title).toBe("Ship the auth flow");
    expect(read!.body.trim()).toBe("Body content here.");
  });

  it("updates fields and bumps updated_at", async () => {
    const t = await store.create({
      title: "Original",
      assignee: "a",
      created_by: "a",
    });
    await new Promise((r) => setTimeout(r, 10));
    const updated = await store.update(t.id, {
      title: "Renamed",
      body: "New body",
    });
    expect(updated.title).toBe("Renamed");
    expect(updated.body).toBe("New body");
    expect(updated.updated_at > t.updated_at).toBe(true);
  });

  it("rejects update on missing id", async () => {
    await expect(
      store.update("does-not-exist", { title: "x" })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("delete removes the file", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
    });
    await store.delete(t.id);
    expect(store.get(t.id)).toBeNull();
  });

  it("delete refuses to remove tasks with dependents unless forced", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      depends_on: [a.id],
    });
    await expect(store.delete(a.id)).rejects.toMatchObject({
      code: "has_dependents",
    });
    await store.delete(a.id, { force: true });
    expect(store.get(a.id)).toBeNull();
    expect(store.get(b.id)).toBeNull();
  });

  it("assigns global sequence ids starting at 1", async () => {
    const a = await store.create({ title: "a", assignee: "x", created_by: "x" });
    const b = await store.create({ title: "b", assignee: "y", created_by: "x" });
    const c = await store.create({ title: "c", assignee: "z", created_by: "y" });
    expect([a.id, b.id, c.id]).toEqual(["1", "2", "3"]);
  });

  it("never reuses an id after delete", async () => {
    const a = await store.create({ title: "a", assignee: "x", created_by: "x" });
    expect(a.id).toBe("1");
    await store.delete(a.id);
    const b = await store.create({ title: "b", assignee: "x", created_by: "x" });
    expect(b.id).toBe("2");
    // Survives a fresh store on the same dir (counter file, not max-scan).
    await new TaskStore(dir).delete(b.id);
    const c = await new TaskStore(dir).create({
      title: "c",
      assignee: "x",
      created_by: "x",
    });
    expect(c.id).toBe("3");
  });

  it("renumbers non-sequence ids on construction and fixes references", async () => {
    await store.create({ title: "keep", assignee: "x", created_by: "x" });
    const fs = await import("node:fs");
    const legacyId = "3f9b2c1a-aaaa-bbbb-cccc-1234567890ab";
    fs.writeFileSync(
      path.join(dir, `${legacyId}.md`),
      [
        "---",
        `id: ${legacyId}`,
        "title: legacy",
        "status: open",
        "assignee: x",
        "session_id: null",
        "created_by: x",
        "parent_id: null",
        "depends_on: []",
        "start_at: null",
        "due_at: null",
        'created_at: "2024-01-01T00:00:00.000Z"',
        'updated_at: "2024-01-01T00:00:00.000Z"',
        "closed_at: null",
        "recurrence: null",
        "runs: 0",
        "last_run_at: null",
        "---",
        "legacy body",
      ].join("\n")
    );
    const dependent = await store.create({
      title: "dependent",
      assignee: "x",
      created_by: "x",
      depends_on: [legacyId],
    });

    const fresh = new TaskStore(dir);
    expect(fresh.get(legacyId)).toBeNull();
    const adopted = fresh.list().find((t) => t.title === "legacy");
    expect(adopted).toBeDefined();
    expect(adopted!.id).toMatch(/^[0-9]+$/);
    expect(adopted!.body.trim()).toBe("legacy body");
    expect(fresh.get(dependent.id)!.depends_on).toEqual([adopted!.id]);
    // New creates continue past the adopted number.
    const next = await fresh.create({
      title: "next",
      assignee: "x",
      created_by: "x",
    });
    expect(Number(next.id)).toBe(Number(adopted!.id) + 1);
  });

  it("list skips dotfiles and malformed", async () => {
    const t = await store.create({
      title: "ok",
      assignee: "a",
      created_by: "a",
    });
    // Drop a malformed file alongside.
    const fs = await import("node:fs");
    fs.writeFileSync(path.join(dir, "garbage.md"), "not yaml");
    fs.writeFileSync(path.join(dir, ".hidden.md"), "---\n---\nbody");
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(t.id);
  });
});

describe("TaskStore team tag", () => {
  it("round-trips team through create / disk / update, null clears", async () => {
    const t = await store.create({
      title: "Redesign hero section",
      assignee: "zoe",
      created_by: "founder-agent",
      team: "website",
    });
    expect(t.team).toBe("website");

    // Survives a fresh read off disk (frontmatter persisted).
    const reread = new TaskStore(dir).get(t.id);
    expect(reread?.team).toBe("website");

    const moved = await store.update(t.id, { team: "growth" });
    expect(moved.team).toBe("growth");

    const cleared = await store.update(t.id, { team: null });
    expect(cleared.team).toBeNull();

    // Untouched by unrelated patches.
    const retitled = await store.update(t.id, { title: "Hero v2" });
    expect(retitled.team).toBeNull();
  });

  it("defaults to null and filters by team in list()", async () => {
    const a = await store.create({
      title: "A", assignee: "zoe", created_by: "x", team: "website",
    });
    const b = await store.create({
      title: "B", assignee: "zoe", created_by: "x",
    });
    expect(b.team).toBeNull();
    const filtered = store.list({ team: "website" });
    expect(filtered.map((t) => t.id)).toEqual([a.id]);
  });
});

describe("TaskStore team-manager resolution", () => {
  const resolver = (teamId: string) =>
    teamId === "website" ? "zoe-manager" : null;

  it("team + no assignee resolves to the team's manager", async () => {
    const s = new TaskStore(dir, { resolveTeamManager: resolver });
    const t = await s.create({
      title: "Triage me",
      created_by: "founder-agent",
      team: "website",
    });
    expect(t.assignee).toBe("zoe-manager");
    expect(t.team).toBe("website");
    // Stored task carries the concrete assignee on disk.
    expect(new TaskStore(dir).get(t.id)?.assignee).toBe("zoe-manager");
  });

  it("explicit assignee wins — resolver not consulted", async () => {
    const spy = vi.fn(resolver);
    const s = new TaskStore(dir, { resolveTeamManager: spy });
    const t = await s.create({
      title: "Direct",
      assignee: "max",
      created_by: "founder-agent",
      team: "website",
    });
    expect(t.assignee).toBe("max");
    expect(spy).not.toHaveBeenCalled();
  });

  it("team without a manager (or unknown team) rejects with a clear error", async () => {
    const s = new TaskStore(dir, { resolveTeamManager: resolver });
    await expect(
      s.create({ title: "Orphan", created_by: "x", team: "growth" })
    ).rejects.toThrow(/has no manager/);
  });

  it("no assignee and no team rejects with an actionable error", async () => {
    const s = new TaskStore(dir, { resolveTeamManager: resolver });
    await expect(
      s.create({ title: "Nowhere", created_by: "x" })
    ).rejects.toThrow(/assignee is required/);
  });

  it("store without a resolver rejects team-addressed creation", async () => {
    await expect(
      store.create({ title: "No resolver", created_by: "x", team: "website" })
    ).rejects.toThrow(/has no manager/);
  });
});

describe("TaskStore dependencies", () => {
  it("stores the caller's status verbatim — deps don't auto-flip", async () => {
    // Pre-refactor the store auto-flipped to `blocked` on unmet deps
    // and back to `open` on satisfy. That moved to the read side —
    // the dispatcher / prompt rendering computes eligibility live via
    // `isQueueEligible`. The stored status is purely what the caller
    // (or recurrence reset) requested. `blocked` is now explicit-only.
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      depends_on: [a.id],
    });
    expect(b.status).toBe("open");

    await store.update(a.id, { status: "done" });
    const refreshed = store.get(b.id)!;
    expect(refreshed.status).toBe("open");
  });

  it("rejects unknown dep ids", async () => {
    await expect(
      store.create({
        title: "x",
        assignee: "a",
        created_by: "a",
        depends_on: ["missing-id"],
      })
    ).rejects.toMatchObject({ code: "unknown_deps" });
  });

  it("rejects cycles", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      depends_on: [a.id],
    });
    // Now make a depend on b → cycle.
    await expect(
      store.update(a.id, { depends_on: [b.id] })
    ).rejects.toMatchObject({ code: "cycle" });
  });

  it("dependent's stored status is unaffected by dep being canceled", async () => {
    // Read-time predicate: a canceled dep means the dependent isn't
    // eligible (`isQueueEligible` returns false), but the stored
    // status stays `open`. Eligibility is a query-time concept now,
    // not stored. To explicitly mark it stuck, a human/agent calls
    // `task_update(status: "blocked")`.
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      depends_on: [a.id],
    });
    await store.update(a.id, { status: "canceled" });
    const refreshed = store.get(b.id)!;
    expect(refreshed.status).toBe("open");
  });

  it("rejects in_progress transition when deps aren't done", async () => {
    // Constraint enforcement at the write boundary: the agent can
    // read everything but trying to claim a task with unmet deps
    // fails with `deps_unsatisfied`. This is the actionable error
    // the agent uses to learn the rule.
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      depends_on: [a.id],
    });
    await expect(
      store.update(b.id, { status: "in_progress" })
    ).rejects.toMatchObject({ code: "deps_unsatisfied" });
  });
});

describe("TaskStore session queue", () => {
  it("enforces at most one in_progress per session", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
    });

    await store.update(a.id, { status: "in_progress" });
    await expect(
      store.update(b.id, { status: "in_progress" })
    ).rejects.toMatchObject({ code: "session_busy" });
  });

  it("queueFor orders by created_at and skips ineligible", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
    });
    await new Promise((r) => setTimeout(r, 10));
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
    });
    await new Promise((r) => setTimeout(r, 10));
    // future-dated task → not eligible.
    const future = new Date(Date.now() + 60_000).toISOString();
    await store.create({
      title: "future",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
      start_at: future,
    });

    const q = store.queueFor("s1");
    expect(q.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("nextEligibleFor returns the head", async () => {
    const a = await store.create({
      title: "a",
      assignee: "x",
      created_by: "x",
      session_id: "s1",
    });
    expect(store.nextEligibleFor("s1")?.id).toBe(a.id);
    await store.update(a.id, { status: "in_progress" });
    expect(store.nextEligibleFor("s1")?.id).toBeUndefined();
  });

  it("reassignment clears session_id automatically", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      session_id: "s1",
    });
    const updated = await store.update(t.id, { assignee: "b" });
    expect(updated.session_id).toBeNull();
  });

  it("explicit session_id in same call as reassignment wins", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      session_id: "s1",
    });
    const updated = await store.update(t.id, {
      assignee: "b",
      session_id: "s2",
    });
    expect(updated.session_id).toBe("s2");
  });
});

describe("TaskStore restart sweep", () => {
  it("resets in_progress tasks older than threshold to open", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      session_id: "s1",
    });
    await store.update(t.id, { status: "in_progress" });

    // simulate stale: write the file with an old updated_at.
    const fs = await import("node:fs");
    const file = path.join(dir, `${t.id}.md`);
    let content = fs.readFileSync(file, "utf-8");
    const oldIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    content = content.replace(
      /updated_at:.*\n/,
      `updated_at: '${oldIso}'\n`
    );
    fs.writeFileSync(file, content);

    const reset = await store.sweepStale();
    expect(reset).toContain(t.id);
    expect(store.get(t.id)!.status).toBe("open");
  });
});

describe("TaskStore renderForPrompt", () => {
  it("groups by status and includes due/start info", async () => {
    const a = await store.create({
      title: "Active task",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });
    await store.update(a.id, { status: "in_progress" });

    await store.create({
      title: "Queued task",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
    });

    await store.create({
      title: "Future task",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
      start_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await store.create({
      title: "Other session",
      assignee: "me",
      created_by: "me",
      session_id: "s2",
    });

    await store.create({
      title: "Delegated",
      assignee: "you",
      created_by: "me",
    });

    const out = store.renderForPrompt("me", "s1", () => true);
    expect(out).toContain("Active in this session");
    expect(out).toContain("Queued in this session");
    expect(out).toContain("Scheduled later");
    expect(out).toContain("In another session");
    expect(out).toContain("Created by me, assigned to others");
    expect(out).toContain("Active task");
    expect(out).toContain("Delegated");
  });

  it("returns empty string when no tasks for agent", () => {
    expect(store.renderForPrompt("nobody", "s1", () => true)).toBe("");
  });

  it("filters out tasks bound to deleted sessions", async () => {
    await store.create({
      title: "ghost",
      assignee: "me",
      created_by: "me",
      session_id: "deleted-session",
    });
    const out = store.renderForPrompt("me", "s1", () => false);
    expect(out).not.toContain("ghost");
  });
});

describe("TaskStore onChange", () => {
  it("fires onChange after mutating calls", async () => {
    let count = 0;
    store.setOnChange(() => {
      count++;
    });
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
    });
    expect(count).toBe(1);
    await store.update(t.id, { title: "y" });
    expect(count).toBe(2);
    await store.delete(t.id);
    expect(count).toBe(3);
  });
});

describe("TaskStore atomic write", () => {
  it("does not leave .tmp files on success", async () => {
    await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
    });
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith(".task_"))).toBe(false);
  });
});

describe("TaskStore malformed-file handling", () => {
  it("warns once per malformed file across many list() calls", async () => {
    const fs = await import("node:fs");
    // The logger resolves its destination lazily on first write. Set
    // OPENACME_LOG_FILE + resetModules so the fresh import lands on our
    // tempfile instead of fd=2 (which bypasses any process.stderr spy).
    const logFile = path.join(dir, "test-logs.ndjson");
    const prev = process.env["OPENACME_LOG_FILE"];
    process.env["OPENACME_LOG_FILE"] = logFile;
    vi.resetModules();
    try {
      const mod = await import("../src/store.js");
      const fresh = new mod.TaskStore(dir);
      fs.writeFileSync(path.join(dir, "broken.md"), "not yaml");
      fresh.list();
      fresh.list();
      fresh.list();
      const content = fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8")
        : "";
      const calls = content
        .split("\n")
        .filter((l) => l.includes("skipping malformed task file"));
      expect(calls.length).toBe(1);
    } finally {
      if (prev === undefined) delete process.env["OPENACME_LOG_FILE"];
      else process.env["OPENACME_LOG_FILE"] = prev;
    }
  });
});

describe("TaskStore input validation", () => {
  it("rejects invalid start_at on create", async () => {
    await expect(
      store.create({
        title: "x",
        assignee: "a",
        created_by: "a",
        start_at: "not-an-iso",
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects invalid due_at on update", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
    });
    await expect(
      store.update(t.id, { due_at: "garbage" })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects empty title on create", async () => {
    await expect(
      store.create({ title: "", assignee: "a", created_by: "a" })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("accepts valid ISO with offset", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      start_at: "2030-01-01T00:00:00.000Z",
    });
    expect(t.start_at).toBe("2030-01-01T00:00:00.000Z");
  });
});

describe("TaskStore recurrence", () => {
  it("interval recurrence: done self-resets to open with advanced start_at, runs+1, last_run_at set", async () => {
    const t = await store.create({
      title: "ping",
      assignee: "a",
      created_by: "a",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    expect(t.recurrence).toEqual({
      kind: "interval",
      every_ms: 60_000,
      session: "reuse",
    });
    expect(t.runs).toBe(0);
    expect(t.last_run_at).toBeNull();
    expect(t.start_at).toBeTruthy();

    const before = Date.parse(t.start_at!);
    const result = await store.update(t.id, { status: "done" });

    expect(result.status).toBe("open");
    expect(result.runs).toBe(1);
    expect(result.last_run_at).toBeTruthy();
    expect(result.closed_at).toBeNull();
    expect(Date.parse(result.start_at!)).toBeGreaterThan(before);
  });

  it("cron recurrence: first start_at honors expression; reset advances to nextRun", async () => {
    const t = await store.create({
      title: "daily",
      assignee: "a",
      created_by: "a",
      recurrence: { kind: "cron", expr: "0 0 * * *", session: "fresh" },
    });
    const firstStart = Date.parse(t.start_at!);
    expect(firstStart).toBeGreaterThan(Date.now());

    const after = await store.update(t.id, { status: "done" });
    expect(after.status).toBe("open");
    expect(Date.parse(after.start_at!)).toBeGreaterThan(firstStart);
  });

  it("count cap stops self-reset once reached", async () => {
    const t = await store.create({
      title: "twice",
      assignee: "a",
      created_by: "a",
      recurrence: {
        kind: "interval",
        every_ms: 60_000,
        count: 2,
        session: "reuse",
      },
    });
    const r1 = await store.update(t.id, { status: "done" });
    expect(r1.status).toBe("open");
    expect(r1.runs).toBe(1);

    const r2 = await store.update(t.id, { status: "done" });
    expect(r2.status).toBe("done");
    expect(r2.runs).toBe(2);
    expect(r2.closed_at).toBeTruthy();
  });

  it("until cap: nextFire past until → stays done", async () => {
    const soon = new Date(Date.now() + 200).toISOString();
    const t = await store.create({
      title: "fleeting",
      assignee: "a",
      created_by: "a",
      recurrence: {
        kind: "interval",
        every_ms: 60_000,
        until: soon,
        session: "reuse",
      },
    });
    await new Promise((r) => setTimeout(r, 250));
    const r = await store.update(t.id, { status: "done" });
    expect(r.status).toBe("done");
    expect(r.closed_at).toBeTruthy();
  });

  it("session: fresh clears session_id on reset; reuse keeps it", async () => {
    const tFresh = await store.create({
      title: "fresh",
      assignee: "a",
      created_by: "a",
      session_id: "s1",
      recurrence: { kind: "interval", every_ms: 60_000, session: "fresh" },
    });
    const rFresh = await store.update(tFresh.id, { status: "done" });
    expect(rFresh.session_id).toBeNull();

    const tReuse = await store.create({
      title: "reuse",
      assignee: "a",
      created_by: "a",
      session_id: "s2",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    const rReuse = await store.update(tReuse.id, { status: "done" });
    expect(rReuse.session_id).toBe("s2");
  });

  it("canceled never self-resets even with active recurrence", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    const r = await store.update(t.id, { status: "canceled" });
    expect(r.status).toBe("canceled");
    expect(r.runs).toBe(0);
    expect(r.closed_at).toBeTruthy();
  });

  it("explicit blocked never self-resets (errored turn shouldn't loop)", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    const r = await store.update(t.id, { status: "blocked" });
    expect(r.status).toBe("blocked");
    expect(r.runs).toBe(0);
  });

  it("recurrence: null on update strips recurrence; subsequent done sticks", async () => {
    const t = await store.create({
      title: "x",
      assignee: "a",
      created_by: "a",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    const stripped = await store.update(t.id, { recurrence: null });
    expect(stripped.recurrence).toBeNull();
    const closed = await store.update(t.id, { status: "done" });
    expect(closed.status).toBe("done");
    expect(closed.runs).toBe(0);
    expect(closed.closed_at).toBeTruthy();
  });

  it("addComment emits comment_added with a single-line ≤80-char excerpt", async () => {
    const { commentStore, eventStore, events } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    events.length = 0;
    const longMulti =
      "Line one with detail.\n  Line two — even more detail.\n\nThird paragraph that runs on and on and on past the cap.";
    await s.addComment({ taskId: t.id, author: "u", body: longMulti });
    const ev = events.find((e) => e.kind === "comment_added");
    expect(ev).toBeTruthy();
    const excerpt = (ev!.payload as { excerpt: string }).excerpt;
    expect(excerpt.length).toBeLessThanOrEqual(80);
    expect(excerpt).not.toContain("\n");
    expect(excerpt.startsWith("Line one with detail.")).toBe(true);
  });

  it("renderRecentActivity excludeActor drops events caused by that actor", async () => {
    const { commentStore, eventStore } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({
      title: "x",
      assignee: "owner",
      created_by: "owner",
      session_id: "sX",
    });
    // owner adds a self comment (actor=owner) and outsider adds another.
    await s.addComment({ taskId: t.id, author: "owner", body: "self note" });
    await s.addComment({ taskId: t.id, author: "outsider", body: "from elsewhere" });

    // Unfiltered: task_assigned + 2 comment_added → 3 lines.
    const full = s.renderRecentActivity("sX", "owner", 0);
    expect(full.split("\n").length).toBe(3);

    // excludeActor=owner: task_assigned now carries the honest actor
    // (creator=owner) — the old `actor: null` carve-out is gone. So
    // the assigned event AND owner's self comment both get dropped;
    // only outsider's comment remains → 1 line.
    const filtered = s.renderRecentActivity("sX", "owner", 0, new Date(), {
      excludeActor: "owner",
    });
    expect(filtered.split("\n").length).toBe(1);
    expect(filtered).toContain("comment by outsider");
    expect(filtered).not.toContain("comment by owner");
  });

  it("rejects create with an unknown session_id when validateSession is wired", async () => {
    const known = new Set<string>(["real-session"]);
    const s = new TaskStore(dir, {
      validateSession: (id) => known.has(id),
    });
    await expect(
      s.create({
        title: "x",
        assignee: "a",
        created_by: "a",
        session_id: "ghost-uuid",
      })
    ).rejects.toMatchObject({ code: "unknown_session" });

    // Known session works.
    const t = await s.create({
      title: "y",
      assignee: "a",
      created_by: "a",
      session_id: "real-session",
    });
    expect(t.session_id).toBe("real-session");
  });

  it("rejects update binding to an unknown session_id", async () => {
    const known = new Set<string>(["s1"]);
    const s = new TaskStore(dir, {
      validateSession: (id) => known.has(id),
    });
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    await expect(
      s.update(t.id, { session_id: "ghost" })
    ).rejects.toMatchObject({ code: "unknown_session" });
    // Detaching to null is always permitted.
    const detached = await s.update(t.id, { session_id: null });
    expect(detached.session_id).toBeNull();
  });

  it("recurring task done emits task_completed_run before status_changed (in_progress → open)", async () => {
    const { commentStore, eventStore, events } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({
      title: "daily",
      assignee: "x",
      created_by: "x",
      recurrence: { kind: "interval", every_ms: 60_000, session: "fresh" },
    });
    await s.update(t.id, { status: "in_progress" });
    // Drain events emitted by create + first transition so we only check the
    // close sequence below.
    events.length = 0;

    const closed = await s.update(t.id, { status: "done" });
    expect(closed.status).toBe("open");
    expect(closed.runs).toBe(1);

    const kinds = events.map((e) => e.kind);
    const completedIdx = kinds.indexOf("task_completed_run");
    const statusIdx = kinds.indexOf("status_changed");
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeGreaterThan(completedIdx);

    const completed = events[completedIdx]!;
    expect(completed.payload).toMatchObject({ runs: 1 });
    expect(typeof (completed.payload as { next_fire?: string }).next_fire).toBe(
      "string"
    );

    const status = events[statusIdx]!;
    expect(status.payload).toMatchObject({ from: "in_progress", to: "open" });
  });

  it("recurring task transient close: dependent stored status is stable", async () => {
    // The recurrence reset (done → open with next start_at) doesn't
    // touch dependents. Eligibility is read-time anyway — `isQueueEligible`
    // will see the recurring task back in `open`, treat it as not-done,
    // and exclude the dependent from the ready set.
    const a = await store.create({
      title: "recurring-a",
      assignee: "x",
      created_by: "x",
      recurrence: { kind: "interval", every_ms: 60_000, session: "reuse" },
    });
    const b = await store.create({
      title: "b",
      assignee: "x",
      created_by: "x",
      depends_on: [a.id],
    });
    expect(b.status).toBe("open");
    await store.update(a.id, { status: "done" });
    const refreshedB = store.get(b.id)!;
    expect(refreshedB.status).toBe("open");
  });

  it("rejects invalid cron expr at the write boundary", async () => {
    await expect(
      store.create({
        title: "x",
        assignee: "a",
        created_by: "a",
        recurrence: { kind: "cron", expr: "not a cron", session: "fresh" },
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects recurrence.until in the past", async () => {
    await expect(
      store.create({
        title: "x",
        assignee: "a",
        created_by: "a",
        recurrence: {
          kind: "interval",
          every_ms: 60_000,
          until: "2000-01-01T00:00:00.000Z",
          session: "fresh",
        },
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects every_ms < MIN_INTERVAL_MS", async () => {
    await expect(
      store.create({
        title: "x",
        assignee: "a",
        created_by: "a",
        recurrence: {
          kind: "interval",
          every_ms: 1000,
          session: "fresh",
        },
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("renderForPrompt annotates recurring tasks with cadence + run count", async () => {
    const t = await store.create({
      title: "daily check",
      assignee: "me",
      created_by: "me",
      session_id: "s1",
      recurrence: { kind: "cron", expr: "0 9 * * *", session: "reuse" },
    });
    await store.update(t.id, { status: "in_progress" });
    const out = store.renderForPrompt("me", "s1", () => true);
    expect(out).toContain("daily check");
    expect(out).toContain("cron 0 9 * * *");
    expect(out).toContain("ran 0×");
  });
});

// ── Comments + events wiring ────────────────────────────────────────

import type {
  Comment,
  CommentInput,
  CommentListOptions,
  CommentStorePort,
  EventInput,
  EventStorePort,
} from "../src/ports.js";
import { randomUUID } from "node:crypto";

function makeStores() {
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
      if (opts.sinceTs !== undefined) {
        out = out.filter((c) => c.createdAt > opts.sinceTs!);
      }
      if (opts.kinds && opts.kinds.length > 0) {
        out = out.filter((c) => c.kind && opts.kinds!.includes(c.kind));
      }
      if (opts.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    },
    latestResult(taskId: string): Comment | null {
      const results = comments
        .filter((c) => c.taskId === taskId && c.kind === "result")
        .sort((a, b) => b.createdAt - a.createdAt);
      return results[0] ?? null;
    },
    countByTask(taskIds: string[]): Map<string, number> {
      const m = new Map<string, number>();
      for (const c of comments) {
        if (taskIds.includes(c.taskId)) {
          m.set(c.taskId, (m.get(c.taskId) ?? 0) + 1);
        }
      }
      return m;
    },
    deleteByTask(taskId: string): void {
      for (let i = comments.length - 1; i >= 0; i--) {
        if (comments[i]!.taskId === taskId) comments.splice(i, 1);
      }
    },
  };

  const events: (EventInput & { ts: number; id: string })[] = [];
  const eventStore: EventStorePort = {
    append(input: EventInput) {
      const row = {
        ...input,
        ts: Date.now(),
        id: randomUUID(),
      };
      events.push(row);
      return row;
    },
    recentForTasks(taskIds: string[], sinceTs: number, limit = 20) {
      const want = new Set(taskIds);
      // Convert internal rows to TaskEvent shape — createdAt is unix-seconds.
      return events
        .filter((e) => want.has(e.taskId))
        .filter((e) => Math.floor(e.ts / 1000) > sinceTs)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
        .map((e) => ({
          id: e.id,
          taskId: e.taskId,
          agentId: e.agentId,
          actor: e.actor ?? null,
          kind: e.kind,
          payload: e.payload !== undefined ? JSON.stringify(e.payload) : null,
          createdAt: Math.floor(e.ts / 1000),
        }));
    },
  };

  return { commentStore, eventStore, comments, events };
}

describe("TaskStore comments", () => {
  it("adds and lists comments via store delegation", async () => {
    const { commentStore, eventStore, comments } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({
      title: "review pr",
      assignee: "reviewer",
      created_by: "author",
    });

    const c = await s.addComment({
      taskId: t.id,
      author: "author",
      body: "any blockers?",
    });
    expect(c).not.toBeNull();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toBe("any blockers?");

    const list = s.listComments(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.author).toBe("author");
  });

  it("marks the assignee's result comment as the canonical result", async () => {
    const { commentStore, eventStore } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({
      title: "compute",
      assignee: "data",
      created_by: "pm",
    });
    await s.addComment({
      taskId: t.id,
      author: "data",
      body: "first attempt",
    });
    await s.addComment({
      taskId: t.id,
      author: "data",
      body: "answer is 42",
      kind: "result",
    });
    const r = s.latestResult(t.id);
    expect(r).not.toBeNull();
    expect(r!.body).toBe("answer is 42");
  });

  it("returns counts grouped by task", async () => {
    const { commentStore, eventStore } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t1 = await s.create({ title: "a", assignee: "x", created_by: "x" });
    const t2 = await s.create({ title: "b", assignee: "x", created_by: "x" });
    await s.addComment({ taskId: t1.id, author: "x", body: "1" });
    await s.addComment({ taskId: t1.id, author: "x", body: "2" });
    await s.addComment({ taskId: t2.id, author: "x", body: "3" });
    const counts = s.commentCounts([t1.id, t2.id]);
    expect(counts.get(t1.id)).toBe(2);
    expect(counts.get(t2.id)).toBe(1);
  });

  it("rejects comment on missing task", async () => {
    const { commentStore, eventStore } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    await expect(
      s.addComment({ taskId: "ghost", author: "x", body: "?" })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("clears comments on task delete", async () => {
    const { commentStore, eventStore, comments } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    await s.addComment({ taskId: t.id, author: "a", body: "note" });
    expect(comments).toHaveLength(1);
    await s.delete(t.id);
    expect(comments).toHaveLength(0);
  });

  it("no-ops when no commentStore is wired", async () => {
    const s = new TaskStore(dir);
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    const c = await s.addComment({
      taskId: t.id,
      author: "a",
      body: "ignored",
    });
    expect(c).toBeNull();
    expect(s.listComments(t.id)).toEqual([]);
    expect(s.latestResult(t.id)).toBeNull();
    expect(s.commentCounts([t.id]).size).toBe(0);
  });
});

describe("TaskStore event emission", () => {
  it("emits task_assigned on create", async () => {
    const { commentStore, eventStore, events } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    await s.create({ title: "x", assignee: "doer", created_by: "boss" });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("task_assigned");
    // `agent_id` is the assignee (the event's recipient). `actor` is
    // the honest creator now — the old `actor: null` carve-out for
    // task_assigned is gone. Echo suppression moved to the inbox-
    // delivery boundary in AgentManager; the store emits the truth.
    expect(events[0]!.agentId).toBe("doer");
    expect(events[0]!.actor).toBe("boss");
    expect(events[0]!.payload).toMatchObject({
      assignee: "doer",
      created_by: "boss",
    });
  });

  it("emits status_changed only when status actually changes", async () => {
    const { commentStore, eventStore, events } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    events.length = 0;
    await s.update(t.id, { title: "renamed" }); // not a status change
    expect(events.filter((e) => e.kind === "status_changed")).toHaveLength(0);
    await s.update(t.id, { status: "in_progress" });
    const change = events.find((e) => e.kind === "status_changed");
    expect(change).toBeDefined();
    expect(change!.payload).toMatchObject({ from: "open", to: "in_progress" });
  });

  it("emits comment_added on addComment", async () => {
    const { commentStore, eventStore, events } = makeStores();
    const s = new TaskStore(dir, { commentStore, eventStore });
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    events.length = 0;
    await s.addComment({
      taskId: t.id,
      author: "b",
      body: "hi",
      kind: "result",
    });
    const e = events.find((e) => e.kind === "comment_added");
    expect(e).toBeDefined();
    // `agentId` is the RECIPIENT (the task's assignee), so the inbox
    // delivery boundary routes the notice to whoever should be notified.
    // The author lives in `actor` (and now also in payload.author).
    expect(e!.agentId).toBe("a");
    expect(e!.actor).toBe("b");
    expect(e!.payload).toMatchObject({ kind: "result", author: "b" });
  });

  // (Removed: "emits dep_unblocked when dependents auto-unblock"
  // — the store no longer auto-unblocks dependents. Dependency
  // eligibility is computed at read time by the dispatcher's
  // readiness predicate; no `dep_unblocked` event is emitted, no
  // graph-walk runs on close.)

  it("does not emit when no eventStore is wired", async () => {
    const s = new TaskStore(dir);
    const t = await s.create({ title: "x", assignee: "a", created_by: "a" });
    await s.update(t.id, { status: "in_progress" });
    // Just confirm nothing throws and store works without the dep.
    expect(s.get(t.id)?.status).toBe("in_progress");
  });
});

describe("TaskStore park + failure escalation", () => {
  it("park bumps the failures counter and blocks with a retry floor", async () => {
    const t = await store.create({
      title: "flaky",
      assignee: "worker",
      created_by: "worker",
    });
    const retryAt = new Date(Date.now() + 5 * 60_000);
    const parked = await store.park({ id: t.id, retryAt, reason: "[error] boom" });
    expect(parked.status).toBe("blocked");
    expect(parked.failures).toBe(1);
    expect(parked.assignee).toBe("worker");
    expect(parked.start_at).toBe(retryAt.toISOString());

    const again = await store.park({ id: t.id, retryAt, reason: "[error] boom" });
    expect(again.failures).toBe(2);
  });

  it("marking done resets the failures counter", async () => {
    const t = await store.create({
      title: "x",
      assignee: "worker",
      created_by: "worker",
    });
    await store.park({
      id: t.id,
      retryAt: new Date(Date.now() + 60_000),
      reason: "[timeout] slow",
    });
    const done = await store.update(t.id, { status: "done" });
    expect(done.failures).toBe(0);
  });

  it("escalating park reassigns to the team manager as open work", async () => {
    const routed = new TaskStore(dir, {
      resolveTeamManager: (team) => (team === "eng" ? "lead" : null),
    });
    const t = await routed.create({
      title: "mis-scoped",
      assignee: "worker",
      created_by: "founder",
      team: "eng",
    });
    const retryAt = new Date(Date.now() + 30 * 60_000);
    const escalated = await routed.park({
      id: t.id,
      retryAt,
      reason: "[error] boom",
      escalate: true,
    });
    expect(escalated.assignee).toBe("lead");
    // Open + start_at floor, not blocked — the new owner has no bound
    // session, so it must flow through the normal readiness path.
    expect(escalated.status).toBe("open");
    expect(escalated.start_at).toBe(retryAt.toISOString());
    // Reassignment resets the counter and clears the session.
    expect(escalated.failures).toBe(0);
    expect(escalated.session_id).toBeNull();
  });

  it("escalation falls back to the creator when there is no team manager", async () => {
    const t = await store.create({
      title: "x",
      assignee: "worker",
      created_by: "founder",
    });
    const escalated = await store.park({
      id: t.id,
      retryAt: new Date(Date.now() + 60_000),
      reason: "[error] boom",
      escalate: true,
    });
    expect(escalated.assignee).toBe("founder");
    expect(escalated.status).toBe("open");
  });

  it("escalation with no distinct target keeps the assignee and stays blocked", async () => {
    const t = await store.create({
      title: "self-created",
      assignee: "worker",
      created_by: "worker",
    });
    await store.park({
      id: t.id,
      retryAt: new Date(Date.now() + 60_000),
      reason: "[error] a",
    });
    const escalated = await store.park({
      id: t.id,
      retryAt: new Date(Date.now() + 60_000),
      reason: "[error] b",
      escalate: true,
    });
    expect(escalated.assignee).toBe("worker");
    expect(escalated.status).toBe("blocked");
    expect(escalated.failures).toBe(2);
  });
});
