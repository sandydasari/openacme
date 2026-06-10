import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDefinition, TeamDefinition } from "./schema.js";

/** Resolve symlinks where possible — sandbox profiles match on REAL
 *  paths (macOS: /tmp and /var are symlinks into /private), so a rule
 *  written against the symlinked form silently fails to match. Falls
 *  back to the input for paths that don't exist yet. */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathSafe(parent), path.basename(p));
  }
}

/**
 * Per-agent filesystem access policy — the single source of truth for
 * what an agent's tool-host may touch. Compiled from human-edited state
 * only (AGENT.md, TEAM.md, the dataDir layout); never from runtime
 * state, so an agent can't expand its own footprint.
 *
 * Posture: the machine is OPEN by default — reads and writes both —
 * and the policy enumerates what is protected:
 *   - `denyWrite`: platform state, identity files (AGENT.md / TEAM.md),
 *     coworkers' directories, non-member team rooms, credential dirs.
 *     Everything else is fair game (agents do real work anywhere).
 *   - `denyRead`: secrets and other agents' minds (memory / sessions),
 *     credential dirs.
 *
 * srt semantics note: `denyWrite` takes precedence over `allowWrite`,
 * so protected entries must be precise paths — there is no
 * allow-within-deny.
 *
 * All paths are literal directory subpaths or files — never globs.
 * srt's glob support is macOS-only; literals behave identically through
 * Seatbelt profiles and bubblewrap bind mounts.
 */
export interface PathPolicy {
  agentId: string;
  /** Roots the agent may write under (normally just `/`). */
  readWrite: string[];
  /** Protected paths writes can never touch, regardless of readWrite. */
  denyWrite: string[];
  /** Paths whose reads are denied (secrets, platform state, others' minds). */
  denyRead: string[];
  /** Structured context for rendering the prompt's `## Access` section. */
  notes: {
    workspaceDir: string;
    teamWorkspaces: Array<{ teamId: string; teamName: string; dir: string }>;
    extraGrants: Array<{ path: string; access: "ro" | "rw" }>;
  };
}

/** Structural mirror of srt's filesystem config block — kept local so
 *  `@openacme/config` takes no dependency on the sandbox runtime. */
export interface SandboxFsConfig {
  allowWrite: string[];
  denyWrite: string[];
  denyRead: string[];
  allowRead: string[];
}

// Credential dirs in the user's home — reading leaks them, writing them
// is privilege escalation (~/.ssh/authorized_keys). Both denied, always.
const HOME_CREDENTIAL_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gcloud",
  ".kube",
  ".docker",
  ".netrc",
];

// Core OS directories are NOT in this policy: agents run as the user,
// so root-ownership/SIP already denies writes to /etc, /System, /usr
// and friends. The policy only protects what the OS can't know about —
// platform state, identity files, coworkers' dirs, credentials.

export function compilePolicy(opts: {
  agentId: string;
  agentDefs: ReadonlyArray<AgentDefinition>;
  teams: ReadonlyArray<TeamDefinition>;
  dataDir: string;
}): PathPolicy {
  const { agentId, agentDefs, teams, dataDir } = opts;
  const agentsDir = path.join(dataDir, "agents");
  const teamsDir = path.join(dataDir, "teams");
  const agentDir = path.join(agentsDir, agentId);
  const self = agentDefs.find((a) => a.id === agentId);

  const memberTeams = teams.filter(
    (t) => !t.archived && t.members.includes(agentId)
  );
  const memberTeamIds = new Set(memberTeams.map((t) => t.id));

  // Platform state + secrets — protected from both reads and writes.
  const platformFiles = [
    path.join(dataDir, "auth.json"),
    path.join(dataDir, "state.db"),
    path.join(dataDir, "state.db-wal"),
    path.join(dataDir, "state.db-shm"),
    path.join(dataDir, "config.yaml"),
    path.join(dataDir, "config.json"),
    path.join(dataDir, "mcp.json"),
    path.join(dataDir, "mcp-tokens"),
    path.join(dataDir, ".env"),
    path.join(dataDir, "push-vapid.json"),
  ];

  const denyRead: string[] = [
    ...platformFiles,
    // Other agents' minds and session artifacts. Their workspace/ and
    // resources/ stay readable (open-office posture). Caveat: their
    // AGENT.md also stays readable and may carry mcpServers env values —
    // future hardening could deny <other>/AGENT.md too.
    ...agentDefs
      .filter((a) => a.id !== agentId)
      .flatMap((a) => [
        path.join(agentsDir, a.id, "memory"),
        path.join(agentsDir, a.id, "sessions"),
        path.join(agentsDir, a.id, "browser-profiles"),
      ]),
    ...HOME_CREDENTIAL_DIRS.map((p) => path.join(os.homedir(), p)),
  ];

  const denyWrite: string[] = [
    ...platformFiles,
    // Workforce-wide shared context — human-owned, injected into every
    // agent's prompt.
    path.join(dataDir, "AGENTS.md"),
    // Identity files are human-owned. Own AGENT.md included: it carries
    // the agent's grants and persona, so writing it would be
    // self-escalation. Charters likewise (they inject into members'
    // prompts — agent-writable would be cross-agent prompt injection).
    path.join(agentDir, "AGENT.md"),
    // Coworkers' directories: readable (minus minds), never writable.
    ...agentDefs
      .filter((a) => a.id !== agentId)
      .map((a) => path.join(agentsDir, a.id)),
    // Teams: member rooms are co-owned (writable) but the charter is
    // not; rooms of teams the agent isn't on — and archived teams —
    // are read-only entirely.
    ...teams.map((t) =>
      memberTeamIds.has(t.id)
        ? path.join(teamsDir, t.id, "TEAM.md")
        : path.join(teamsDir, t.id)
    ),
    ...HOME_CREDENTIAL_DIRS.map((p) => path.join(os.homedir(), p)),
  ];

  // Per-agent extra grants from AGENT.md frontmatter (human-edited).
  // With writes open by default these mostly matter as `ro` re-allows
  // under denied subtrees; `rw` entries are kept for forward-compat.
  const extraGrants = (self?.paths ?? []).map((g) => ({
    path: path.resolve(g.path.replace(/^~(?=\/|$)/, os.homedir())),
    access: g.access,
  }));

  return {
    agentId,
    readWrite: ["/"],
    denyWrite: [...new Set(denyWrite.map(realpathSafe))],
    denyRead: [...new Set(denyRead.map(realpathSafe))],
    notes: {
      workspaceDir: path.join(agentDir, "workspace"),
      teamWorkspaces: memberTeams.map((t) => ({
        teamId: t.id,
        teamName: t.name,
        dir: path.join(teamsDir, t.id, "workspace"),
      })),
      extraGrants,
    },
  };
}

/** Render the policy as srt-shaped filesystem config. */
export function toSandboxConfig(policy: PathPolicy): SandboxFsConfig {
  return {
    allowWrite: [...policy.readWrite],
    denyWrite: [...policy.denyWrite],
    denyRead: [...policy.denyRead],
    allowRead: policy.notes.extraGrants
      .filter((g) => g.access === "ro")
      .map((g) => g.path),
  };
}

/** Render the human-readable `## Access` prompt section. Tells the agent
 *  what it can touch and why the rest is off-limits — the error a denied
 *  call produces is a bare EPERM, so this section carries the meaning. */
export function describePolicy(policy: PathPolicy): string {
  const lines: string[] = [];
  lines.push(
    "Your filesystem access is enforced at the OS level (a protected path " +
      "surfaces as a permission error):"
  );
  lines.push("");
  lines.push(
    "Read-write: most of this machine. Do real work wherever it lives — " +
      "repos, installs, scratch files. Your own places:"
  );
  lines.push(`- \`${policy.notes.workspaceDir}\` — your workspace (default cwd)`);
  for (const tw of policy.notes.teamWorkspaces) {
    lines.push(
      `- \`${tw.dir}\` — shared workspace of team "${tw.teamName}" (co-owned with members)`
    );
  }
  lines.push("");
  lines.push(
    "Read-only: your coworkers' directories and the rooms of teams you're " +
      "not on — you can read their work product, not change it. Agent and " +
      "team definition files (AGENT.md, TEAM.md, AGENTS.md) are human-owned " +
      "— readable, never writable, including your own. To co-edit, use a " +
      "shared team workspace; to request a change, file a task."
  );
  lines.push("");
  lines.push(
    "No access: platform credentials and state (auth, config, database), " +
      "coworkers' memory and session files, and credential directories " +
      "like ~/.ssh (no reads OR writes). System directories are protected " +
      "by the OS itself. These are off-limits by design; don't try to " +
      "work around a permission error — if you believe you need access, " +
      "say so."
  );
  return lines.join("\n");
}
