import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import matter from "gray-matter";
import { createAgentStore } from "../src/agent-store.js";
import type { AgentDefinition } from "../src/schema.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openacme-agent-store-"));
}

function makeAgent(
  id: string,
  provider = "anthropic",
  persona = "You are a helpful assistant."
): AgentDefinition {
  return {
    id,
    name: `${id} Agent`,
    role: "",
    model: {
      provider: provider as AgentDefinition["model"]["provider"],
      model: "test-model",
      auth: "api_key",
      cacheTtl: "5m",
    },
    persona,
    tools: ["shell"],
    mcpServers: {},
    mcpDisabled: [],
    skills: [],
    probeIntervalMs: 30 * 60 * 1000,
    paths: [],
  };
}

describe("file-based AgentStore (folder + AGENT.md)", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("list() returns [] for an empty / nonexistent directory", () => {
    const empty = path.join(dir, "agents");
    const store = createAgentStore(empty);
    expect(store.list()).toEqual([]);
  });

  it("upsert creates <id>/AGENT.md inside the agents directory", () => {
    const agentsDir = path.join(dir, "agents");
    const store = createAgentStore(agentsDir);
    store.upsert(makeAgent("foo"));
    expect(fs.existsSync(path.join(agentsDir, "foo", "AGENT.md"))).toBe(true);
  });

  it("upsert also creates the per-agent workspace/ subdirectory", () => {
    const agentsDir = path.join(dir, "agents");
    const store = createAgentStore(agentsDir);
    store.upsert(makeAgent("foo"));
    const ws = path.join(agentsDir, "foo", "workspace");
    expect(fs.existsSync(ws)).toBe(true);
    expect(fs.statSync(ws).isDirectory()).toBe(true);
  });

  it("AGENT.md has frontmatter for structured fields and body for persona", () => {
    const store = createAgentStore(dir);
    store.upsert(
      makeAgent(
        "foo",
        "anthropic",
        "Multi-paragraph persona.\n\nSecond paragraph here."
      )
    );
    const raw = fs.readFileSync(path.join(dir, "foo", "AGENT.md"), "utf-8");
    const { data, content } = matter(raw);
    // id lives in the folder name, not the frontmatter — duplicate ids
    // would be a footgun if hand-edits could drift from the folder.
    expect(data.id).toBeUndefined();
    expect(data.name).toBe("foo Agent");
    expect(data.model).toMatchObject({ provider: "anthropic" });
    expect(content.trim()).toBe(
      "Multi-paragraph persona.\n\nSecond paragraph here."
    );
    // Persona must NOT live in the frontmatter when it's in the body.
    expect(data.persona).toBeUndefined();
  });

  it("ignores frontmatter id; folder name wins", () => {
    const store = createAgentStore(dir);
    store.upsert(makeAgent("alice"));
    // Tamper: write a stale `id: other` into alice's frontmatter.
    const filePath = path.join(dir, "alice", "AGENT.md");
    const original = fs.readFileSync(filePath, "utf-8");
    fs.writeFileSync(filePath, original.replace("---\n", "---\nid: other\n"));

    const loaded = store.get("alice");
    expect(loaded?.id).toBe("alice");
    // list() also reports the folder-derived id, not the stale frontmatter one
    const ids = store.list().map((a) => a.id);
    expect(ids).toContain("alice");
    expect(ids).not.toContain("other");
  });

  it("get round-trips an agent through disk", () => {
    const store = createAgentStore(dir);
    const original = makeAgent("foo");
    store.upsert(original);
    const loaded = store.get("foo");
    expect(loaded).toEqual(original);
  });

  it("list returns all agents in id-sorted order", () => {
    const store = createAgentStore(dir);
    store.upsert(makeAgent("zebra"));
    store.upsert(makeAgent("alpha"));
    store.upsert(makeAgent("middle"));
    const ids = store.list().map((a) => a.id);
    expect(ids).toEqual(["alpha", "middle", "zebra"]);
  });

  it("delete removes the entire agent folder, including sibling assets", () => {
    const store = createAgentStore(dir);
    store.upsert(makeAgent("foo"));
    fs.writeFileSync(path.join(dir, "foo", "extra.txt"), "user-added asset");
    store.delete("foo");
    expect(store.get("foo")).toBeNull();
    expect(fs.existsSync(path.join(dir, "foo"))).toBe(false);
  });

  it("upsert overwrites an existing agent in place", () => {
    const store = createAgentStore(dir);
    store.upsert(makeAgent("foo", "anthropic"));
    store.upsert(makeAgent("foo", "openai"));
    expect(store.get("foo")?.model.provider).toBe("openai");
  });

  it("rejects unsafe ids — path traversal, leading dot, slashes", () => {
    const store = createAgentStore(dir);
    expect(() => store.upsert(makeAgent("../escape"))).toThrow();
    expect(() => store.upsert(makeAgent(".hidden"))).toThrow();
    expect(() => store.upsert(makeAgent("a/b"))).toThrow();
    expect(() => store.upsert(makeAgent(""))).toThrow();
  });

  it("get with an unsafe id returns null without throwing", () => {
    const store = createAgentStore(dir);
    expect(store.get("../escape")).toBeNull();
    expect(store.get(".hidden")).toBeNull();
  });

  it("skips folders without AGENT.md and ignores hidden folders", () => {
    fs.mkdirSync(dir, { recursive: true });
    const store = createAgentStore(dir);
    store.upsert(makeAgent("real"));
    fs.mkdirSync(path.join(dir, "no-agent-md"));
    fs.writeFileSync(path.join(dir, "no-agent-md", "README.md"), "stray");
    fs.mkdirSync(path.join(dir, ".hidden"));
    fs.writeFileSync(path.join(dir, ".hidden", "AGENT.md"), "id: ghost");
    expect(store.list().map((a) => a.id)).toEqual(["real"]);
  });

  it("accepts persona in frontmatter for backward compat (body still wins when set)", () => {
    fs.mkdirSync(path.join(dir, "fm-only"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "fm-only", "AGENT.md"),
      matter.stringify("\n", {
        id: "fm-only",
        name: "Frontmatter Persona",
        model: { provider: "anthropic", model: "x", auth: "api_key" },
        persona: "Persona kept in frontmatter.",
        tools: ["shell"],
        mcpServers: {},
        skills: [],
      })
    );
    const store = createAgentStore(dir);
    const def = store.get("fm-only");
    expect(def?.persona).toBe("Persona kept in frontmatter.");
  });

  it("upsert tolerates undefined values in optional schema fields", () => {
    // Regression: openai/anthropic provider configs reach the store with
    // `model.baseUrl: undefined` (no default base URL). gray-matter's
    // js-yaml dumper throws on undefined unless we strip them first —
    // historically this left an empty `<id>/` folder behind.
    const store = createAgentStore(dir);
    const agentWithUndefineds: AgentDefinition = {
      id: "openai-default",
      name: "OpenAI",
      model: {
        provider: "openai",
        model: "gpt-5.5",
        baseUrl: undefined,
        apiKey: undefined,
        auth: "oauth",
        headers: undefined,
      },
      persona: "Helpful.",
      tools: ["shell"],
      mcpServers: {},
      skills: [],
    };
    expect(() => store.upsert(agentWithUndefineds)).not.toThrow();
    expect(fs.existsSync(path.join(dir, "openai-default", "AGENT.md"))).toBe(
      true
    );
    const reloaded = store.get("openai-default");
    expect(reloaded?.model.provider).toBe("openai");
    expect(reloaded?.model.baseUrl).toBeUndefined();
  });

  it("upsert cleans up the new folder if write fails", () => {
    // If the writeFile step throws (e.g. EACCES), we shouldn't leave a
    // half-built `<id>/` folder behind for the user to puzzle over.
    const store = createAgentStore(dir);
    // Create a file at the spot where the folder would go to force mkdir
    // to fail. ensureDir uses recursive=true so it tolerates pre-existing
    // dirs but fails if the path is a file.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "blocked"), "i am a file");
    expect(() => store.upsert(makeAgent("blocked"))).toThrow();
    // Path is still the file, not a folder.
    expect(fs.statSync(path.join(dir, "blocked")).isFile()).toBe(true);
  });

  it("skips a folder whose AGENT.md is malformed", () => {
    fs.mkdirSync(path.join(dir, "broken"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "broken", "AGENT.md"),
      "---\nid: broken\n---\n# missing required fields"
    );
    const store = createAgentStore(dir);
    store.upsert(makeAgent("good"));
    expect(store.list().map((a) => a.id)).toEqual(["good"]);
  });
});
