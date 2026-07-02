import { z } from "zod";
import { registry } from "../registry.js";
import { getCurrentAgentId } from "../session-context.js";

/**
 * Minimal agent shape this tool surfaces to peers. Defined locally so
 * `@openacme/tools` doesn't pull in `@openacme/config` at runtime —
 * `bindAgentTool` is wired up by `AgentManager` at boot, same pattern as
 * `bindSessionSearch` / `bindSkillView`.
 */
export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  /** Configured environment-touching tools (system tools omitted — every
   *  agent has those). What differentiates coworkers for triage. */
  tools?: string[];
  /** Per-agent skill filter. Empty means all shared skills are exposed. */
  skills?: string[];
  /** Names of the agent's private MCP servers. */
  mcp_servers?: string[];
}

export interface PeerNote {
  /** UTF-8 body of `peers/<id>.md` (frontmatter included if present). */
  content: string;
  mtimeMs: number;
}

export interface AgentToolBindings {
  /** Every agent currently registered in the workforce. Self is included;
   *  the tool filters it out before returning to the caller. */
  listAgents(): AgentSummary[];
  /** Read the calling agent's peer note for `peerId`, or null if absent.
   *  Resolves to `<dataDir>/agents/<callerId>/memory/peers/<peerId>.md`. */
  peerNoteFor(callerId: string, peerId: string): PeerNote | null;
}

let bindings: AgentToolBindings | null = null;

export function bindAgentTool(b: AgentToolBindings): void {
  bindings = b;
}

// Half of MAX_MEMORY_BYTES (4096) — the tool returns N peer notes at
// once, so each individual one gets a tighter budget than the recall
// pipeline applies to a single surfaced memory.
const MAX_PEER_NOTE_BYTES = 2048;
const DEFAULT_LIMIT = 25;

function truncateNote(
  content: string,
  peerId: string
): { content: string; truncated: boolean } {
  if (Buffer.byteLength(content, "utf-8") <= MAX_PEER_NOTE_BYTES) {
    return { content, truncated: false };
  }
  const buf = Buffer.from(content, "utf-8").subarray(0, MAX_PEER_NOTE_BYTES);
  // Cut at the last newline so we don't end mid-line. Invalid trailing
  // UTF-8 bytes from `subarray` get U+FFFD on `toString`, not a crash.
  const cut = buf.lastIndexOf(0x0a);
  const head = (cut > 0 ? buf.subarray(0, cut) : buf).toString("utf-8");
  return {
    content:
      head +
      `\n\n> Peer note truncated. Use the \`memory\` tool's \`view\` ` +
      `command to read the full file at \`peers/${peerId}.md\`.`,
    truncated: true,
  };
}

function matchesQuery(a: AgentSummary, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    a.name.toLowerCase().includes(needle) ||
    a.role.toLowerCase().includes(needle) ||
    a.id.toLowerCase().includes(needle) ||
    (a.tools ?? []).some((t) => t.toLowerCase().includes(needle)) ||
    (a.skills ?? []).some((s) => s.toLowerCase().includes(needle)) ||
    (a.mcp_servers ?? []).some((m) => m.toLowerCase().includes(needle))
  );
}

const TOOL_DESCRIPTION =
  "List your coworkers (other agents in this workforce). Each result " +
  "carries the peer's stable `id`, their display `name`, and their " +
  "`role` (a paragraph the peer's creator wrote describing what they " +
  "do, what they own, and where they redirect work). If you have a " +
  "peer note saved at `peers/<id>.md`, its body is returned " +
  "inline as `peer_note` — that's your lived experience with this " +
  "coworker (from prior delegations), distinct from the canonical role. " +
  "Each result also lists the peer's capabilities — `tools` (their " +
  "configured environment-touching tools), `skills`, and `mcp_servers` " +
  "(their private integrations) — so you can match work to who can " +
  "actually do it (e.g. browser work needs browser_* tools). " +
  "Use this tool when you're about to delegate a task and aren't sure " +
  "who the right assignee is. Pass `query` to narrow the result by " +
  "substring match over role/name/id/tools/skills/mcp servers.";

registry.register({
  name: "agent_list",
  toolset: "agents",
  description: TOOL_DESCRIPTION,
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe(
        "Optional substring filter (case-insensitive) over each agent's " +
          "role, name, or id."
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Max number of agents to return. Default 25."),
  }),
  emoji: "👥",
  parallelSafe: true,
  handler: async (args) => {
    if (!bindings) {
      return JSON.stringify({
        ok: false,
        error:
          "agent_list not initialized — AgentManager must call bindAgentTool().",
      });
    }
    const a = args as { query?: string; limit?: number };
    const callerId = getCurrentAgentId();
    if (!callerId) {
      return JSON.stringify({
        ok: false,
        error: "agent_list requires an active agent context.",
      });
    }

    const all = bindings.listAgents().filter((p) => p.id !== callerId);
    const filtered = a.query ? all.filter((p) => matchesQuery(p, a.query!)) : all;
    const limited = filtered.slice(0, a.limit ?? DEFAULT_LIMIT);

    const enriched = limited.map((p) => {
      const base = {
        id: p.id,
        name: p.name,
        role: p.role,
        ...(p.tools ? { tools: p.tools } : {}),
        ...(p.skills ? { skills: p.skills } : {}),
        ...(p.mcp_servers ? { mcp_servers: p.mcp_servers } : {}),
      };
      const note = bindings!.peerNoteFor(callerId, p.id);
      if (!note) return base;
      const { content, truncated } = truncateNote(note.content, p.id);
      return {
        ...base,
        peer_note: {
          content,
          mtime: new Date(note.mtimeMs).toISOString(),
          ...(truncated ? { truncated: true } : {}),
        },
      };
    });

    return JSON.stringify({
      ok: true,
      count: enriched.length,
      total: filtered.length,
      agents: enriched,
    });
  },
});
