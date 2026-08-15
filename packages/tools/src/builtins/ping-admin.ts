import { z } from "zod";
import { registry } from "../registry.js";
import { getCurrentAgentId } from "../session-context.js";

/**
 * Operator-ping administration — Acme-only platform tools for the
 * "Waiting for you" list.
 *
 * `ping_user` (the all-agents primitive) puts a session into the
 * waiting bucket; today only a user message clears it. These two tools
 * give the platform overseer the other half: `ping_list` to see what's
 * outstanding (with age), and `resolve_ping` to retire a request the
 * user no longer needs to answer — a question gone stale because the
 * situation moved on. Resolving emits a `ping_resolved` event the
 * waiting query treats as a clear, so the row drops off the home page
 * without the user typing anything.
 *
 * Both are gated by being listed in Acme's AGENT.md `tools` (toolset
 * "platform", like `reload_config`); no other agent gets cross-session
 * authority over another agent's pings.
 */

export interface UnresolvedPing {
  sessionId: string;
  agentId: string;
  agentName: string;
  sessionTitle: string | null;
  message: string;
  /** Whole seconds since the ping fired. */
  ageSeconds: number;
}

export interface PingAdminBindings {
  /** Every unresolved ping across the workforce, oldest-first. */
  list: () => UnresolvedPing[];
  /** Retire the unresolved ping on `sessionId`. `resolvedBy` is the
   *  agent doing the closing (recorded for the audit trail). Returns the
   *  cleared ping's details, or `null` when that session had none. */
  resolve: (
    sessionId: string,
    reason: string,
    resolvedBy: string
  ) => { agentId: string; message: string } | null;
}

let bindings: PingAdminBindings | null = null;

export function bindPingAdmin(b: PingAdminBindings): void {
  bindings = b;
}

function ageLabel(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 90) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

registry.register({
  name: "ping_list",
  toolset: "platform",
  description:
    "List the workforce's open 'Waiting for you' requests — every " +
    "ping_user that no agent has had answered yet, oldest first, with " +
    "the asking agent, the question, and how long it's been waiting. Use " +
    "this to review the waiting list before deciding whether any request " +
    "has gone stale (the situation moved on, the task was canceled, the " +
    "answer is now obvious) and can be closed with resolve_ping.",
  parameters: z.object({}),
  emoji: "🔔",
  parallelSafe: true,
  handler: async () => {
    if (!bindings) {
      return JSON.stringify({
        error:
          "ping_list not initialized — AgentManager must call bindPingAdmin().",
      });
    }
    const pings = bindings.list();
    return JSON.stringify({
      count: pings.length,
      waiting: pings.map((p) => ({
        sessionId: p.sessionId,
        agent: p.agentName,
        agentId: p.agentId,
        sessionTitle: p.sessionTitle,
        age: ageLabel(p.ageSeconds),
        ageSeconds: p.ageSeconds,
        message: p.message,
      })),
    });
  },
});

registry.register({
  name: "resolve_ping",
  toolset: "platform",
  description:
    "Proactively close a stale 'Waiting for you' request so it stops " +
    "demanding the user's attention. Use ONLY when the request genuinely " +
    "no longer needs an answer — the task was canceled, the situation " +
    "changed, the work moved on, or the answer is now obvious. Pass the " +
    "session's id (from ping_list) and a one-line reason for the audit " +
    "trail. This does not answer the agent's question; it withdraws it. " +
    "If you're unsure whether the user still needs to weigh in, leave it.",
  parameters: z.object({
    sessionId: z
      .string()
      .min(1)
      .describe("The waiting session's id (from ping_list)."),
    reason: z
      .string()
      .min(1)
      .describe(
        "Why this request no longer needs the user — recorded on the " +
          "close event so there's a trail of what was auto-cleared and why."
      ),
  }),
  emoji: "✅",
  parallelSafe: false,
  handler: async (args) => {
    const { sessionId, reason } = args as { sessionId: string; reason: string };
    if (!bindings) {
      return JSON.stringify({
        error:
          "resolve_ping not initialized — AgentManager must call bindPingAdmin().",
      });
    }
    const resolvedBy = getCurrentAgentId() ?? "platform";
    const cleared = bindings.resolve(sessionId, reason, resolvedBy);
    if (!cleared) {
      return JSON.stringify({
        resolved: false,
        note: `No unresolved ping on session ${sessionId} — nothing to close (it may have already been answered).`,
      });
    }
    return JSON.stringify({
      resolved: true,
      sessionId,
      agentId: cleared.agentId,
      closedQuestion: cleared.message,
      reason,
    });
  },
});
