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

/** Resolve a `paths` grant entry: `~` → home, absolute → literal, and a
 *  bare relative path → under dataDir. The last case lets platform grants
 *  (`mcp.json`, `agents`, `AGENTS.md`) be expressed in a static template
 *  without knowing the install's dataDir or the process CWD. */
function resolveGrantPath(p: string, dataDir: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  if (path.isAbsolute(p)) return p;
  return path.join(dataDir, p);
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
 * Two tiers of protection. HARD denies — secrets (auth/.env/tokens/db),
 * coworkers' minds + mailbox, and the agent's own AGENT.md — are
 * inviolable. SOFT denies — platform config surfaces (config.yaml /
 * mcp.json), AGENTS.md, coworkers' dirs, team rooms — can be re-opened by
 * an explicit per-agent `paths` grant in AGENT.md (this is how the Acme
 * platform agent gets admin write access: it grants the config surfaces;
 * no special flag). A grant never touches a hard deny.
 *
 * srt semantics note: `denyWrite` takes precedence over `allowWrite`, so
 * there is no allow-within-deny — a grant works by SUBTRACTING covered
 * entries from the soft-deny list, not by adding an allow.
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
  /** Paths to re-open for reads (srt `allowRead` punches holes in denyRead).
   *  Only grants that don't overlap a hard deny — so a broad grant can never
   *  re-expose a secret or a coworker's mind. */
  readAllow: string[];
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

  const others = agentDefs.filter((a) => a.id !== agentId);
  const homeCreds = HOME_CREDENTIAL_DIRS.map((p) => path.join(os.homedir(), p));

  // ── HARD denies — inviolable. An agent's `paths` grant can re-open the
  // SOFT denies below, but NEVER these: secrets, coworkers' minds + mailbox,
  // and the agent's own AGENT.md (writable would be self-escalation — it
  // carries the agent's own grants).
  const secretFiles = [
    path.join(dataDir, "auth.json"),
    path.join(dataDir, "state.db"),
    path.join(dataDir, "state.db-wal"),
    path.join(dataDir, "state.db-shm"),
    path.join(dataDir, "mcp-tokens"),
    path.join(dataDir, ".env"),
    path.join(dataDir, "push-vapid.json"),
  ];
  const othersPrivate = others.flatMap((a) => [
    path.join(agentsDir, a.id, "memory"),
    path.join(agentsDir, a.id, "sessions"),
    path.join(agentsDir, a.id, "browser-profiles"),
    path.join(agentsDir, a.id, "email.json"),
  ]);
  const hardDenyRead = [...secretFiles, ...othersPrivate, ...homeCreds];
  const hardDenyWrite = [
    ...secretFiles,
    ...othersPrivate,
    ...homeCreds,
    path.join(agentDir, "AGENT.md"),
  ];

  // ── SOFT denies — default-protected, but an explicit `paths` grant can
  // re-open the entries it covers (this is how Acme gets platform-admin
  // write access: its AGENT.md grants `agents`, `AGENTS.md`, `mcp.json`,
  // `config.yaml` — no special flag, just data).
  const configSurfaces = [
    path.join(dataDir, "config.yaml"),
    path.join(dataDir, "config.json"),
    path.join(dataDir, "mcp.json"),
  ];
  const softDenyRead = [...configSurfaces];
  const softDenyWrite = [
    ...configSurfaces,
    path.join(dataDir, "AGENTS.md"),
    // Coworkers' AGENT.md + resources + workspace (minds/mailbox stay hard-
    // denied above). Default-denied; an `agents` rw grant re-opens them.
    ...others.map((a) => path.join(agentsDir, a.id)),
    // Teams: member rooms co-owned (writable) but charter isn't; non-member
    // and archived team rooms are read-only entirely.
    ...teams.map((t) =>
      memberTeamIds.has(t.id)
        ? path.join(teamsDir, t.id, "TEAM.md")
        : path.join(teamsDir, t.id)
    ),
  ];

  // Per-agent grants from AGENT.md frontmatter (human-edited only — an agent
  // can't expand its own footprint at runtime). `rw` re-opens writes + reads;
  // `ro` re-opens reads. A grant covers a soft-deny D if D === grant or D is
  // under grant. Hard denies are never removed.
  const grants = (self?.paths ?? []).map((g) => ({
    path: realpathSafe(resolveGrantPath(g.path, dataDir)),
    access: g.access,
  }));
  const rwGrants = grants.filter((g) => g.access === "rw").map((g) => g.path);
  const readGrants = grants.map((g) => g.path);
  const coveredBy = (d: string, grantPaths: string[]) =>
    grantPaths.some((g) => d === g || d.startsWith(g + path.sep));

  const hardReadResolved = hardDenyRead.map(realpathSafe);
  const denyWrite = [
    ...hardDenyWrite.map(realpathSafe),
    ...softDenyWrite.map(realpathSafe).filter((d) => !coveredBy(d, rwGrants)),
  ];
  const denyRead = [
    ...hardReadResolved,
    ...softDenyRead.map(realpathSafe).filter((d) => !coveredBy(d, readGrants)),
  ];

  // `allowRead` re-opens reads INSIDE denyRead (srt: allowRead beats denyRead).
  // So a grant may only re-open reads if it doesn't overlap a hard deny in
  // EITHER direction — otherwise a broad grant like `agents` rw would punch a
  // hole through the hard denyRead on a coworker's memory/mailbox. Reads of
  // soft-protected paths are already handled by subtraction above (no allow
  // needed), so dropping an overlapping grant here costs nothing.
  const readAllow = readGrants.filter(
    (g) =>
      !hardReadResolved.some(
        (h) => h === g || h.startsWith(g + path.sep) || g.startsWith(h + path.sep)
      )
  );

  return {
    agentId,
    readWrite: ["/"],
    denyWrite: [...new Set(denyWrite)],
    denyRead: [...new Set(denyRead)],
    readAllow: [...new Set(readAllow)],
    notes: {
      workspaceDir: path.join(agentDir, "workspace"),
      teamWorkspaces: memberTeams.map((t) => ({
        teamId: t.id,
        teamName: t.name,
        dir: path.join(teamsDir, t.id, "workspace"),
      })),
      extraGrants: grants.map((g) => ({ path: g.path, access: g.access })),
    },
  };
}

/** Render the policy as srt-shaped filesystem config. */
export function toSandboxConfig(policy: PathPolicy): SandboxFsConfig {
  return {
    allowWrite: [...policy.readWrite],
    denyWrite: [...policy.denyWrite],
    denyRead: [...policy.denyRead],
    // Only grants that don't overlap a hard deny (computed in compilePolicy);
    // an overlapping grant must never re-open a secret or a coworker's mind.
    allowRead: [...(policy.readAllow ?? [])],
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
  const rwGrants = policy.notes.extraGrants.filter((g) => g.access === "rw");
  const roGrants = policy.notes.extraGrants.filter((g) => g.access === "ro");
  const hasGrants = rwGrants.length > 0 || roGrants.length > 0;
  lines.push(
    "Read-only by default" +
      (hasGrants ? " (except where granted below)" : "") +
      ": your coworkers' directories and the rooms of teams you're not on — " +
      "you can read their work product, not change it. Agent and team " +
      "definition files (AGENT.md, TEAM.md, AGENTS.md) are human-owned — " +
      "readable, and not writable unless a grant below says otherwise. To " +
      "co-edit without a grant, use a shared team workspace or file a task."
  );
  if (hasGrants) {
    lines.push("");
    lines.push(
      "Granted to you specifically — these OVERRIDE the read-only defaults " +
        "above, and you are expected to edit them directly when asked:"
    );
    for (const g of rwGrants) lines.push(`- \`${g.path}\` — read+write`);
    for (const g of roGrants) lines.push(`- \`${g.path}\` — read-only`);
    lines.push(
      "Even with these, secrets (auth, .env, tokens, database) and your " +
        "coworkers' memory / sessions / mailbox stay off-limits."
    );
  }
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
