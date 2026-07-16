/**
 * System prompt builder. Memory section: index + convention + conditional
 * "keep organized" instruction. The Anthropic memory_20250818 protocol
 * preamble is left to the tool description (duplicating it over-primed
 * the agent into narrating "checking memory first" every turn).
 */

import type { IndexSnapshot } from "@openacme/memory";
import { MEMORY_CONVENTION } from "./prompt-fragments/memory-convention.js";

// Memory-index injection caps (CC `memdir/memdir.ts` lift). Byte cap
// catches long-line indexes that slip past the line cap.
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;

// Cluttered-memory thresholds. Triggers appending Anthropic's "keep
// organized" instruction.
const CLUTTERED_FILE_COUNT_THRESHOLD = 10;
const CLUTTERED_FILL_FRACTION_THRESHOLD = 0.8;

// Verbatim from Anthropic memory-tool docs.
const CLUTTERED_MEMORY_INSTRUCTION =
  "Note: when editing your memory folder, always try to keep its content " +
  "up-to-date, coherent and organized. You can rename or delete files that " +
  "are no longer relevant. Do not create new files unless necessary.";

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// CC `memdir/memdir.ts:truncateEntrypointContent` lift.
function truncateIndex(raw: string): {
  content: string;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
} {
  const trimmed = raw.trim();
  const contentLines = trimmed.split("\n");
  const lineCount = contentLines.length;
  const byteCount = trimmed.length;

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, wasLineTruncated, wasByteTruncated };
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n")
    : trimmed;

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatBytes(byteCount)} (limit: ${formatBytes(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatBytes(byteCount)}`;

  return {
    content:
      truncated +
      `\n\n> WARNING: MEMORY.md is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    wasLineTruncated,
    wasByteTruncated,
  };
}

// Always emits even when MEMORY.md is empty so the agent knows the tool exists.
function buildMemorySection(snapshot: IndexSnapshot): string {
  const parts: string[] = [];

  const used = snapshot.used;
  const limit = snapshot.limit;
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const entryWord = snapshot.entryCount === 1 ? "entry" : "entries";
  const header = `══════════════════════════════════════════════
MEMORY [${pct}% — ${used}/${limit} chars] · ${snapshot.entryCount} ${entryWord}
══════════════════════════════════════════════`;
  if (snapshot.content.length > 0) {
    const truncated = truncateIndex(snapshot.content);
    parts.push(`${header}\n${truncated.content}`);
  } else {
    parts.push(`${header}\n(empty — no memories yet)`);
  }

  parts.push(MEMORY_CONVENTION);

  const fillFraction = limit > 0 ? used / limit : 0;
  const isCluttered =
    snapshot.entryCount > CLUTTERED_FILE_COUNT_THRESHOLD ||
    fillFraction > CLUTTERED_FILL_FRACTION_THRESHOLD;
  if (isCluttered) {
    parts.push(CLUTTERED_MEMORY_INSTRUCTION);
  }

  return parts.join("\n\n");
}

/**
 * Behavioral guidance for the task tools. Injected when `task_create` is
 * available so the agent knows when to file tasks vs. just do the work,
 * how the queue / scheduler will pick them up, and the surprising
 * recurring-done semantic (done → open self-reset).
 */
const TASKS_GUIDANCE =
  "Tasks are persistent units of work backed by markdown files, numbered by " +
  "a single global sequence (1, 2, …) shared by the whole workforce — pass " +
  "that number as `id` to the task tools.\n" +
  "A periodic " +
  "dispatcher (60s tick) checks the board and spawns you when there's something " +
  "to do — a new assignment, an `in_progress` task you're working on, a ready " +
  "open task, or a comment from another agent / human in your inbox.\n" +
  "File a task when: the work spans multiple turns or sessions, has a future " +
  "start time, needs to wait on another task (depends_on), or should be handed " +
  "to a different agent. Don't file a task for something you can finish in the " +
  "current turn — just do it.\n" +
  "Each task binds to a session. The `session` field on `task_create` controls " +
  "where the work lives: `\"current\"` (only when self-assigning) puts the task in " +
  "your current session; `\"fresh\"` requests a brand-new session the dispatcher " +
  "allocates when ready; omit for the smart default (current when self-assigning, " +
  "fresh otherwise). If you intend to work on a task RIGHT NOW in this same turn, " +
  "use `\"current\"`. Per-session, at most one task is in_progress at a time — " +
  "the rest queue in created_at order. Try to claim a second concurrently and " +
  "the store rejects with a clear error.\n" +
  "Cross-agent: passing a different `assignee` files work for that agent. They'll " +
  "pick it up autonomously in a fresh session — you don't message them directly. " +
  "Comments on a shared task are the coordination channel.\n" +
  "Task comment discipline: ordinary comments are for progress, checkpoints, " +
  "blockers, errors, corrections, and partial updates — call `task_comment` " +
  "with `id`, `body`, and `mode: \"comment\"` (or omit `mode`; comment is the " +
  "default). Result comments are the assignee's single canonical final answer " +
  "for the task — include `mode: \"result\"` only for that final answer, immediately before marking " +
  "the task done.\n" +
  "Teams: tag tasks with `team: \"<team-id>\"` when the work belongs to one of " +
  "your teams; deliverables for team-tagged work go in that team's shared " +
  "workspace. With an explicit `assignee` the tag is organizational only. If you " +
  "don't know who in a team should do the work, set `team` and omit `assignee` — " +
  "the task lands on the team's manager to triage (errors if the team has no " +
  "manager). To split team work across members, decompose it: `task_create` " +
  "per piece with `depends_on` wiring the order.\n" +
  "Recurring tasks: pass `recurrence` (cron or interval). When you mark a recurring " +
  "task `done`, the store self-resets it to `open` with the next fire time — the " +
  "returned status is `open`, not `done`, and `runs` increments. This is intentional. " +
  "Use `status: \"canceled\"` to stop the recurrence permanently. Choose " +
  "`recurrence.session: \"reuse\"` for an ongoing thread (context accumulates), " +
  "`\"fresh\"` (default) for clean isolation each fire.\n" +
  "Status discipline (focus model): every turn ends with the focus task in one of " +
  "three explicit states. `done` (after the one `mode: \"result\"` final-answer " +
  "comment) when finished. `blocked` (with a reason) when you can't proceed without " +
  "external input — flip it back to `open` once unblocked. `open + start_at: " +
  "\"<future ISO>\"` to snooze a task to a wall-clock time. If you leave it in " +
  "`in_progress` and end the turn, the dispatcher will pick you back up on the " +
  "next tick to continue or close out — don't worry about forgetting it.\n" +
  "Constraints are enforced at the write boundary, not via the prompt. Try " +
  "anything: `task_update` rejects illegal transitions (cycles, in_progress " +
  "with unmet deps, two in_progress on the same session) with specific errors " +
  "that tell you exactly what's wrong and how to recover. Reads are unrestricted " +
  "— `task_list` / `task_view` / `task_comments` show everything in the system, " +
  "including other agents' tasks. The system-prompt snapshot is from session " +
  "start and may be stale; call the read tools for fresh state when it matters.\n" +
  "Dependencies are read-time predicates: a task's `depends_on` doesn't change " +
  "its stored status, but a task with unmet deps won't be picked up by the " +
  "dispatcher until they clear. Trying to claim it directly fails with " +
  "`deps_unsatisfied`.\n" +
  "Defer: if you have nothing actionable right now and only `blocked` tasks " +
  "remain — OR you've intentionally left work in_progress and want to be " +
  "quiet until a specific time — call `defer_session(\"5m\" | \"2h\" | \"24h\")` " +
  "to suppress routine 60s spawns until that timestamp. New inbox signals " +
  "(user messages, new tasks, comments) bypass the defer and wake you " +
  "immediately. Defer is sticky: a signal-driven wake fires the turn but the " +
  "remaining window keeps holding against subsequent routine ticks. One call " +
  "covers the whole duration; you don't need to re-call it each turn.";

/**
 * Workforce-side primitives for talking to the human and pacing your
 * own wakeups. Both are always-on system tools, so the guidance only
 * fires when those tools are present — but in practice they're in
 * every agent's effective tool set.
 */
const PING_USER_GUIDANCE =
  "`ping_user(message)` is the single agent → user attention primitive. " +
  "Use when: (a) you're genuinely blocked and the assigner is the human (not " +
  "another agent), (b) you have a result the user specifically asked to see, " +
  "(c) you need a credential or a human-only action. For agent-to-agent " +
  "clarification, comment on the task instead — the assigner wakes on the " +
  "event pipe; ping_user is the human boundary.\n" +
  "Behavior: write the message text as your assistant response AND call " +
  "`ping_user(message)` with the same text — the chat shows the message via " +
  "your response, the inbox surfaces it via the tool. Two paths, same string. " +
  "After calling, end the turn — the user's reply lands as a regular message " +
  "that wakes you on its own.";

const SLEEP_GUIDANCE =
  "`sleep(duration)` sets when the scheduler next probes this session if " +
  "nothing else moves the world. Default cadence is your agent's " +
  "`probeIntervalMs` (typically 30 min). Override when:\n" +
  "- Polling external state that changes fast → `sleep(\"5m\")`.\n" +
  "- Natural pause and nothing's likely to change for a while → `sleep(\"4h\")`.\n" +
  "- You're confident only events will move things → `sleep(\"never\")` " +
  "  (capped at 24h by the platform).\n" +
  "Events (tasks, comments, dep unblocks, user messages) wake you regardless. " +
  "The override resets each turn; call it again if you still want a custom cadence.";

// Cap on the per-prompt `## Resources` listing. More than this fast-paths
// to a `... and N more` tail so an agent with hundreds of files doesn't
// blow the prefix cache. Agent can still `read_file` anything; this is
// just the index.
const MAX_RESOURCE_LINES = 50;

// Total budget for team charters across all of an agent's teams. Keeps
// an agent on many teams from paying unbounded prompt tokens; pushes
// charters toward being charters, not dumping grounds.
export const TEAM_CHARTER_CHAR_LIMIT = 4000;

/** One prompt-visible team membership. */
export interface PromptTeam {
  id: string;
  name: string;
  members: ReadonlyArray<string>;
  /** Agent id of the team's manager (routing default for team-addressed
   *  tasks), when one is set. */
  manager?: string | null;
  /** True when the agent whose prompt this is holds the manager seat —
   *  computed by the caller; prompt assembly doesn't know agent ids. */
  isManager?: boolean;
  charter: string;
  workspaceDir: string;
}

// Charters consume a shared budget in team order; anything past the
// budget is cut with a per-team marker plus one trailing warning.
function buildTeamsSection(teams: ReadonlyArray<PromptTeam>): string {
  const parts: string[] = [
    "You are a member of the following teams. Each team has a shared " +
      "workspace directory all members can read and write — co-owned " +
      "work belongs there, not in your personal workspace. The charter " +
      "is the team's shared context.",
  ];
  let budget = TEAM_CHARTER_CHAR_LIMIT;
  let truncated = false;
  for (const team of teams) {
    const lines = [
      `### ${team.name} (\`${team.id}\`)`,
      `Members: ${team.members.join(", ")}`,
      ...(team.manager ? [`Manager: ${team.manager}`] : []),
      `Shared workspace: \`${team.workspaceDir}\``,
    ];
    const charter = team.charter.trim();
    if (charter.length > 0) {
      if (charter.length <= budget) {
        lines.push("", charter);
        budget -= charter.length;
      } else if (budget > 0) {
        const cutAt = charter.lastIndexOf("\n", budget);
        lines.push("", charter.slice(0, cutAt > 0 ? cutAt : budget), "(charter truncated)");
        budget = 0;
        truncated = true;
      } else {
        lines.push("", "(charter omitted)");
        truncated = true;
      }
    }
    if (team.isManager) {
      lines.push(
        "",
        `You are this team's manager. Tasks addressed to the team without ` +
          `an assignee land on you to triage: claim it, reassign it to the ` +
          `right member via task_update, or split it into subtasks — decide, ` +
          `don't relay. Escalate to the human only when the team can't ` +
          `resolve it. Being manager grants no authority over teammates; ` +
          `it's a routing duty.`
      );
    }
    parts.push(lines.join("\n"));
  }
  if (truncated) {
    parts.push(
      `> WARNING: combined team charters exceed ${TEAM_CHARTER_CHAR_LIMIT} chars; some were cut. Read the full charter at <teamDir>/TEAM.md.`
    );
  }
  return parts.join("\n\n");
}

export function buildSystemPrompt(options: {
  persona: string;
  toolNames: string[];
  skillsIndex?: string;
  tasksContext?: string;
  memorySnapshot?: IndexSnapshot;
  platformHints?: string;
  /** Verbatim AGENTS.md contents. Empty/undefined ⇒ section omitted. */
  agentsMd?: string;
  /** Teams this agent belongs to (non-archived). When non-empty, a
   *  `## Teams` section injects each team's roster, shared-workspace
   *  path, and charter — the context layer between org (AGENTS.md)
   *  and individual (persona). */
  teams?: ReadonlyArray<PromptTeam>;
  /** Agent's workspace dir. When set, a short "## Workspace" section is
   *  injected so the agent knows where its default cwd is and that shell
   *  state persists across calls. */
  workspaceDir?: string;
  /** Pre-rendered `## Access` section body (from `describePolicy` in
   *  @openacme/config) — what the agent may read/write and why the rest
   *  is off-limits. Passed pre-rendered (like `agentsMd`) so agent-core
   *  stays decoupled from policy compilation. */
  accessSection?: string;
  /** Files under `<agentDir>/resources/`. When non-empty, a `## Resources`
   *  section lists relPath + size + absolute path so the agent can
   *  `read_file` directly. */
  resources?: ReadonlyArray<{
    relPath: string;
    size: number;
    absPath: string;
  }>;
}): string {
  const parts: string[] = [];

  // Identity / persona
  parts.push(options.persona);

  // Generic preface so AGENTS.md reads as shared background, not persona drift.
  if (options.agentsMd && options.agentsMd.trim().length > 0) {
    parts.push(
      `\nShared context (from AGENTS.md):\n\n${options.agentsMd.trim()}`
    );
  }

  // Teams — org → team → individual context hierarchy. Sits after the
  // org-wide AGENTS.md and before the agent's own workspace section.
  if (options.teams && options.teams.length > 0) {
    parts.push(`\n## Teams\n${buildTeamsSection(options.teams)}`);
  }

  // Workspace section — tells the agent its default cwd + that shell
  // state persists across calls within this session.
  if (options.workspaceDir && options.workspaceDir.length > 0) {
    parts.push(
      `\n## Workspace\nYour workspace directory is \`${options.workspaceDir}\`. ` +
        `Shell commands, file ops, and the Python REPL default to this location. ` +
        `Your shell maintains state across calls in this session — \`cd\`, ` +
        `exported environment variables, and shell functions all persist. ` +
        `Absolute paths are allowed; what you can actually read and write ` +
        `is listed under Access below.`
    );
  }

  // Access — rendered from the compiled per-agent path policy. The
  // enforcement is OS-level (the tool host runs sandboxed); this section
  // carries the *meaning* so a bare EPERM doesn't read as a bug.
  if (options.accessSection && options.accessSection.length > 0) {
    parts.push(`\n## Access\n${options.accessSection}`);
  }

  // Resources — user-supplied files under `<agentDir>/resources/`. The
  // framing also tells the agent that files mentioned by name in its
  // persona (e.g. "use the style guide", "follow template.json") resolve
  // to entries here — that mapping is otherwise non-obvious.
  if (options.resources && options.resources.length > 0) {
    const shown = options.resources.slice(0, MAX_RESOURCE_LINES);
    const lines = shown.map(
      (r) => `- \`${r.relPath}\` (${r.size}B) — ${r.absPath}`
    );
    const overflow = options.resources.length - shown.length;
    const tail =
      overflow > 0
        ? `\n... and ${overflow} more (see the resources directory).`
        : "";
    parts.push(
      `\n## Resources\nFiles in your folder. If your persona references a ` +
        `file by name, find it here. Read via the absolute path.\n${lines.join("\n")}${tail}`
    );
  }

  // Tool usage guidance. The MCP-namespace line is unconditional —
  // emitting it only when an MCP tool happens to be in scope makes the
  // prompt byte-string change as MCP availability flips on/off, which
  // would break the provider-side prefix cache for sessions that
  // toggle. Always-on is byte-stable and the cost is a single sentence.
  // Models trained on Claude Desktop / Cursor conventions habitually
  // reach for bare MCP tool names (e.g. `arxiv__search_papers`); our
  // registry exposes them as `mcp_<server>__<tool>` so a bare call hits
  // the unknown-tool path and costs a turn.
  if (options.toolNames.length > 0) {
    parts.push(
      `\n## Available Tools\nYou have access to the following tools: ${options.toolNames.join(", ")}.\n` +
        `Use tools proactively to gather information and complete tasks. ` +
        `When a task requires multiple steps, use tools sequentially until complete. ` +
        `MCP tools are namespaced \`mcp_<server>__<tool>\` — call them with that exact prefix, not the bare name.`
    );
  }

  // Memory section — emitted whenever the agent has the memory tool
  // (presence of memorySnapshot from the caller signals this). Always
  // includes protocol + convention; index is empty-formatted when there
  // are no entries yet.
  if (options.toolNames.includes("memory") && options.memorySnapshot) {
    parts.push(`\n## Memory\n${buildMemorySection(options.memorySnapshot)}`);
  }

  // Tasks behavioral guidance — gated on `task_create` so the agent
  // doesn't see this when tasks aren't enabled. Stays in the prompt
  // regardless of whether any tasks currently exist.
  if (options.toolNames.includes("task_create")) {
    parts.push(`\n## Tasks tool\n${TASKS_GUIDANCE}`);
  }

  // ping_user + sleep — always-on system tools; the guidance is short
  // but load-bearing for the workforce shape (when to bring the human
  // in vs comment on a task; what cadence to wake at).
  if (options.toolNames.includes("ping_user")) {
    parts.push(`\n## Talking to the user\n${PING_USER_GUIDANCE}`);
  }
  if (options.toolNames.includes("sleep")) {
    parts.push(`\n## Pacing your own wakeups\n${SLEEP_GUIDANCE}`);
  }

  // Skills index (Level 0 — names + descriptions). Bodies aren't loaded
  // until the agent calls `skill_view` for one that applies.
  if (options.skillsIndex) {
    parts.push(
      `\n## Skills\nYou have the following skills available. Each entry is name + short description; ` +
        `call \`skill_view\` with the name to load the full instructions when one applies.\n${options.skillsIndex}`
    );
  }

  // Tasks snapshot — what's assigned to / created by this agent in this
  // session. Built once at session start; tools (`task_list`, `task_view`)
  // give the agent live state mid-turn. Recent activity (event feed) is
  // NOT in the system prompt — runAutonomous appends it to the user
  // message instead so it stays per-turn fresh and doesn't get cached.
  if (options.tasksContext) {
    parts.push(`\n## Tasks\n${options.tasksContext}`);
  }

  // Platform-specific hints
  if (options.platformHints) {
    parts.push(`\n## Platform\n${options.platformHints}`);
  }

  return parts.join("\n\n");
}
