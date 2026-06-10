import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import matter from "gray-matter";
import { createTeamStore } from "../src/team-store.js";
import type { TeamDefinition } from "../src/schema.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openacme-team-store-"));
}

function makeTeam(
  id: string,
  members: string[] = ["zoe", "max"],
  charter = "We ship the landing page. Zoe is the manager."
): TeamDefinition {
  return { id, name: `${id} team`, members, charter };
}

describe("file-based TeamStore (folder + TEAM.md)", () => {
  let dir: string;
  let teamsDir: string;

  beforeEach(() => {
    dir = tmpDir();
    teamsDir = path.join(dir, "teams");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("list() returns [] for an empty / nonexistent directory", () => {
    const store = createTeamStore(teamsDir);
    expect(store.list()).toEqual([]);
  });

  it("upsert creates <id>/TEAM.md and <id>/workspace/", () => {
    const store = createTeamStore(teamsDir);
    store.upsert(makeTeam("website"));
    expect(fs.existsSync(path.join(teamsDir, "website", "TEAM.md"))).toBe(true);
    expect(
      fs.statSync(path.join(teamsDir, "website", "workspace")).isDirectory()
    ).toBe(true);
  });

  it("round-trips charter as the markdown body, not frontmatter", () => {
    const store = createTeamStore(teamsDir);
    store.upsert(makeTeam("website"));
    const raw = fs.readFileSync(
      path.join(teamsDir, "website", "TEAM.md"),
      "utf-8"
    );
    const { data, content } = matter(raw);
    expect(data["charter"]).toBeUndefined();
    expect(content.trim()).toBe(
      "We ship the landing page. Zoe is the manager."
    );

    const back = store.get("website");
    expect(back).not.toBeNull();
    expect(back!.charter).toBe(
      "We ship the landing page. Zoe is the manager."
    );
    expect(back!.members).toEqual(["zoe", "max"]);
    expect(back!.archived).toBeUndefined();
  });

  it("folder name wins over frontmatter id", () => {
    const store = createTeamStore(teamsDir);
    const folder = path.join(teamsDir, "real-id");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "TEAM.md"),
      matter.stringify("Charter body\n", { id: "fake-id", name: "X", members: [] }),
      "utf-8"
    );
    const team = store.get("real-id");
    expect(team).not.toBeNull();
    expect(team!.id).toBe("real-id");
  });

  it("rejects invalid team ids and invalid member ids", () => {
    const store = createTeamStore(teamsDir);
    expect(() => store.upsert(makeTeam("../escape"))).toThrow(/Invalid team id/);
    expect(() =>
      store.upsert(makeTeam("ok", ["fine", "../not-fine"]))
    ).toThrow(/Invalid member id/);
    expect(store.get("../escape")).toBeNull();
    expect(store.teamDir("../escape")).toBeNull();
    expect(store.workspaceDir("../escape")).toBeNull();
  });

  it("teamsFor returns non-archived teams containing the agent", () => {
    const store = createTeamStore(teamsDir);
    store.upsert(makeTeam("website", ["zoe", "max"]));
    store.upsert(makeTeam("research", ["zoe"]));
    store.upsert({ ...makeTeam("old-project", ["zoe"]), archived: true });

    const zoe = store.teamsFor("zoe").map((t) => t.id);
    expect(zoe).toEqual(["research", "website"]);
    expect(store.teamsFor("max").map((t) => t.id)).toEqual(["website"]);
    expect(store.teamsFor("nobody")).toEqual([]);
  });

  it("archived flag round-trips and stays absent when false-y", () => {
    const store = createTeamStore(teamsDir);
    store.upsert({ ...makeTeam("done"), archived: true });
    const raw = fs.readFileSync(path.join(teamsDir, "done", "TEAM.md"), "utf-8");
    expect(matter(raw).data["archived"]).toBe(true);
    expect(store.get("done")!.archived).toBe(true);

    store.upsert(makeTeam("active"));
    const raw2 = fs.readFileSync(
      path.join(teamsDir, "active", "TEAM.md"),
      "utf-8"
    );
    expect("archived" in matter(raw2).data).toBe(false);
  });

  it("list() skips malformed team files and dotted folders", () => {
    const store = createTeamStore(teamsDir);
    store.upsert(makeTeam("good"));
    const bad = path.join(teamsDir, "bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "TEAM.md"), "---\nname: [unclosed\n---\n");
    fs.mkdirSync(path.join(teamsDir, ".hidden"), { recursive: true });
    expect(store.list().map((t) => t.id)).toEqual(["good"]);
  });

  it("upsert updates an existing team in place", () => {
    const store = createTeamStore(teamsDir);
    store.upsert(makeTeam("website", ["zoe"]));
    store.upsert(makeTeam("website", ["zoe", "max"], "Updated charter."));
    const team = store.get("website");
    expect(team!.members).toEqual(["zoe", "max"]);
    expect(team!.charter).toBe("Updated charter.");
    expect(store.list()).toHaveLength(1);
  });
});
