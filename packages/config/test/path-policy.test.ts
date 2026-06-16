import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import {
  compilePolicy,
  toSandboxConfig,
  describePolicy,
} from "../src/path-policy.js";
import {
  AgentDefinitionSchema,
  TeamDefinitionSchema,
  type AgentDefinition,
  type TeamDefinition,
} from "../src/schema.js";

const DATA_DIR = "/data/openacme";

function agent(id: string, over: Partial<AgentDefinition> = {}): AgentDefinition {
  return AgentDefinitionSchema.parse({ id, name: id, ...over });
}

function team(
  id: string,
  members: string[],
  over: Partial<TeamDefinition> = {}
): TeamDefinition {
  return TeamDefinitionSchema.parse({ id, name: id, members, ...over });
}

function compile(opts: {
  agentId?: string;
  agentDefs?: AgentDefinition[];
  teams?: TeamDefinition[];
}) {
  return compilePolicy({
    agentId: opts.agentId ?? "zoe",
    agentDefs: opts.agentDefs ?? [agent("zoe"), agent("max")],
    teams: opts.teams ?? [],
    dataDir: DATA_DIR,
  });
}

describe("compilePolicy (open-by-default writes, protected deny list)", () => {
  it("writes are open by default — the machine is the writable root", () => {
    const p = compile({});
    expect(p.readWrite).toEqual(["/"]);
  });

  it("write-protects platform state, identity files, and coworkers' dirs", () => {
    const p = compile({});
    expect(p.denyWrite).toContain(`${DATA_DIR}/auth.json`);
    expect(p.denyWrite).toContain(`${DATA_DIR}/state.db`);
    expect(p.denyWrite).toContain(`${DATA_DIR}/config.yaml`);
    expect(p.denyWrite).toContain(`${DATA_DIR}/mcp.json`);
    expect(p.denyWrite).toContain(`${DATA_DIR}/AGENTS.md`);
    // Own AGENT.md too — it carries grants/persona (self-escalation guard).
    expect(p.denyWrite).toContain(`${DATA_DIR}/agents/zoe/AGENT.md`);
    // Coworker's WHOLE dir is write-denied (open-office reads, no writes).
    expect(p.denyWrite).toContain(`${DATA_DIR}/agents/max`);
    // Own workspace is NOT write-denied.
    expect(p.denyWrite).not.toContain(`${DATA_DIR}/agents/zoe`);
    expect(p.denyWrite).not.toContain(`${DATA_DIR}/agents/zoe/workspace`);
    // Credential dirs: denied for writes as well as reads.
    expect(p.denyWrite).toContain(path.join(os.homedir(), ".ssh"));
  });

  it("member teams: room writable, charter not; non-member/archived rooms read-only", () => {
    const p = compile({
      teams: [
        team("website", ["zoe", "max"]),
        team("research", ["max"]),
        team("old", ["zoe"], { archived: true }),
      ],
    });
    // Member team: only TEAM.md protected, workspace stays writable.
    expect(p.denyWrite).toContain(`${DATA_DIR}/teams/website/TEAM.md`);
    expect(p.denyWrite).not.toContain(`${DATA_DIR}/teams/website`);
    expect(p.denyWrite).not.toContain(`${DATA_DIR}/teams/website/workspace`);
    // Non-member + archived: whole team dir write-denied.
    expect(p.denyWrite).toContain(`${DATA_DIR}/teams/research`);
    expect(p.denyWrite).toContain(`${DATA_DIR}/teams/old`);
    expect(p.notes.teamWorkspaces.map((t) => t.teamId)).toEqual(["website"]);
  });

  it("denies reads of platform secrets/state and other agents' minds, not their workspaces", () => {
    const p = compile({});
    expect(p.denyRead).toContain(`${DATA_DIR}/auth.json`);
    expect(p.denyRead).toContain(`${DATA_DIR}/state.db`);
    expect(p.denyRead).toContain(`${DATA_DIR}/config.yaml`);
    expect(p.denyRead).toContain(`${DATA_DIR}/agents/max/memory`);
    expect(p.denyRead).toContain(`${DATA_DIR}/agents/max/sessions`);
    // Open-office posture: coworker workspace is NOT read-denied.
    expect(p.denyRead).not.toContain(`${DATA_DIR}/agents/max/workspace`);
    expect(p.denyRead).not.toContain(`${DATA_DIR}/agents/max`);
    // Own dirs are never read-denied.
    expect(p.denyRead).not.toContain(`${DATA_DIR}/agents/zoe/memory`);
    expect(p.denyRead).toContain(path.join(os.homedir(), ".ssh"));
  });

  it("carries ro + rw extra grants into allowRead (both grant reads)", () => {
    const defs = [
      agent("zoe", {
        paths: [
          { path: "/opt/shared-data", access: "ro" },
          { path: "~/dev/myrepo", access: "rw" },
        ],
      }),
      agent("max"),
    ];
    const p = compile({ agentDefs: defs });
    const sandbox = toSandboxConfig(p);
    expect(sandbox.allowRead).toContain("/opt/shared-data");
    expect(sandbox.allowRead).toContain(path.join(os.homedir(), "dev/myrepo"));
    expect(p.notes.extraGrants).toContainEqual({
      path: path.join(os.homedir(), "dev/myrepo"),
      access: "rw",
    });
  });

  it("rw grants subtract from SOFT denies but never from HARD denies", () => {
    // Admin-style grants (what the Acme template ships): bare paths resolve
    // under the data dir.
    const defs = [
      agent("zoe", {
        paths: [
          { path: "agents", access: "rw" },
          { path: "AGENTS.md", access: "rw" },
          { path: "mcp.json", access: "rw" },
          { path: "config.yaml", access: "rw" },
        ],
      }),
      agent("max"),
    ];
    const p = compile({ agentDefs: defs });
    // Soft denies re-opened for writes:
    expect(p.denyWrite).not.toContain(`${DATA_DIR}/config.yaml`);
    expect(p.denyWrite).not.toContain(`${DATA_DIR}/mcp.json`);
    expect(p.denyWrite).not.toContain(`${DATA_DIR}/AGENTS.md`);
    expect(p.denyWrite).not.toContain(`${DATA_DIR}/agents/max`);
    // …and for reads (config surfaces become readable):
    expect(p.denyRead).not.toContain(`${DATA_DIR}/config.yaml`);
    expect(p.denyRead).not.toContain(`${DATA_DIR}/mcp.json`);
    // HARD denies survive the `agents` rw grant — secrets, coworker minds +
    // mailbox, and own AGENT.md stay locked even though they're under granted
    // paths:
    expect(p.denyWrite).toContain(`${DATA_DIR}/auth.json`);
    expect(p.denyWrite).toContain(`${DATA_DIR}/.env`);
    expect(p.denyWrite).toContain(`${DATA_DIR}/state.db`);
    expect(p.denyWrite).toContain(`${DATA_DIR}/agents/max/memory`);
    expect(p.denyWrite).toContain(`${DATA_DIR}/agents/max/email.json`);
    expect(p.denyWrite).toContain(`${DATA_DIR}/agents/zoe/AGENT.md`);
    expect(p.denyRead).toContain(`${DATA_DIR}/auth.json`);
    expect(p.denyRead).toContain(`${DATA_DIR}/agents/max/email.json`);
    expect(p.denyRead).toContain(`${DATA_DIR}/agents/max/memory`);
    // …and the broad `agents` grant must NOT land in allowRead — srt's
    // allowRead beats denyRead, so that would re-expose coworkers' minds.
    const sandbox = toSandboxConfig(p);
    expect(sandbox.allowRead).not.toContain(`${DATA_DIR}/agents`);
  });

  it("a grant can never re-open a hard secret, even named directly", () => {
    const defs = [
      agent("zoe", { paths: [{ path: "auth.json", access: "rw" }] }),
      agent("max"),
    ];
    const p = compile({ agentDefs: defs });
    expect(p.denyWrite).toContain(`${DATA_DIR}/auth.json`);
    expect(p.denyRead).toContain(`${DATA_DIR}/auth.json`);
  });

  it("emits no globs anywhere (Linux literal-bind parity)", () => {
    const p = compile({
      teams: [team("website", ["zoe"]), team("other", ["max"])],
      agentDefs: [agent("zoe", { paths: [{ path: "~/x", access: "ro" }] }), agent("max")],
    });
    const sandbox = toSandboxConfig(p);
    for (const list of [
      sandbox.allowWrite,
      sandbox.denyWrite,
      sandbox.denyRead,
      sandbox.allowRead,
    ]) {
      for (const entry of list) {
        expect(entry).not.toMatch(/[*?[\]]/);
        expect(path.isAbsolute(entry)).toBe(true);
      }
    }
  });
});

describe("describePolicy", () => {
  it("names team workspaces and explains the tiers", () => {
    const p = compile({ teams: [team("website", ["zoe"], { name: "Website" })] });
    const text = describePolicy(p);
    expect(text).toContain(`${DATA_DIR}/agents/zoe/workspace`);
    expect(text).toContain('team "Website"');
    expect(text).toContain("Read-write: most of this machine");
    expect(text).toContain("Read-only by default");
    expect(text).toContain("No access:");
  });

  it("lists rw grants as overrides in the Access section", () => {
    const p = compile({
      agentDefs: [
        agent("zoe", { paths: [{ path: "mcp.json", access: "rw" }] }),
        agent("max"),
      ],
    });
    const text = describePolicy(p);
    expect(text).toContain("OVERRIDE the read-only defaults");
    expect(text).toMatch(new RegExp(`${DATA_DIR}/mcp\\.json.*read\\+write`));
  });
});
