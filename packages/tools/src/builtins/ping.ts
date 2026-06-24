import { z } from "zod";
import { registry } from "../registry.js";
import { getCurrentAgentId, getCurrentSessionId } from "../session-context.js";

/**
 * `ping_user` — the single agent → operator attention primitive.
 *
 * Fires a `ping_user` event scoped to the current session. The
 * operator's inbox surfaces the message; resolution rule: the ping
 * stays "unresolved" until any user message in the session has a
 * later created_at. Use for questions, approvals, FYIs, credential
 * requests, anything that needs human attention. The agent's prose
 * carries the semantic — the tool itself doesn't know or care which
 * kind of ask this is.
 *
 * The tool returns immediately. The agent decides whether to end the
 * turn (typical, when blocked on the answer) or keep working on
 * independent tasks while the human responds.
 *
 * NOTE on rendering: the message text should also be the agent's
 * regular assistant response in the chat — this tool is the
 * *attention signal*, not the *content channel*. The chat pane
 * naturally surfaces the message via the assistant's own text;
 * the inbox surfaces it via the tool's stored payload. Two paths,
 * same string.
 */

export interface PingUserEventEmit {
  taskId?: string | null;
  sessionId: string;
  agentId: string;
  message: string;
}

export interface PingUserBindings {
  /** Emit a ping event. AgentManager binds this to EventStore.append
   *  with the right `kind` and payload shape. */
  emit: (event: PingUserEventEmit) => void;
}

let bindings: PingUserBindings | null = null;

export function bindPingUser(b: PingUserBindings): void {
  bindings = b;
}

export interface WithdrawPingBindings {
  /** Retire the calling agent's own outstanding ping on `sessionId`.
   *  AgentManager scopes this to `agentId`'s own pings — an agent can
   *  only withdraw a request it made. Returns the cleared message, or
   *  null when this agent has no open ping on that session. */
  withdraw: (
    sessionId: string,
    agentId: string,
    reason: string
  ) => { message: string } | null;
}

let withdrawBindings: WithdrawPingBindings | null = null;

export function bindWithdrawPing(b: WithdrawPingBindings): void {
  withdrawBindings = b;
}

const DESCRIPTION =
  "Bring the user into the loop. Use when you (a) genuinely need their input " +
  "(stuck, missing context, blocked on a credential, asking for approval on a " +
  "high-blast-radius action), or (b) have a result they specifically asked to " +
  "see, or (c) need an action only they can perform (logging into a service, " +
  "etc.). The message text carries the question / FYI / approval ask — be " +
  "specific so they can respond without re-reading the whole session.\n\n" +
  "For agent-to-agent clarification, comment on the task instead (the assigner " +
  "wakes via the event pipe). Reserve ping_user for the human boundary.\n\n" +
  "Behavior: fires immediately, no blocking. After calling it, end your turn " +
  "and wait — the user's reply lands as a regular message that wakes you on " +
  "its own.";

registry.register({
  name: "ping_user",
  toolset: "system",
  description: DESCRIPTION,
  parameters: z.object({
    message: z
      .string()
      .min(1)
      .describe(
        "What you want to tell or ask the user. Same content you'd write " +
          "as your assistant response — repeat it here so the inbox row " +
          "and the chat transcript agree."
      ),
  }),
  emoji: "🔔",
  parallelSafe: false,
  handler: async (args) => {
    const { message } = args as { message: string };
    if (!bindings) {
      return JSON.stringify({
        error:
          "ping_user not initialized — AgentManager must call bindPingUser().",
      });
    }
    const sessionId = getCurrentSessionId();
    const agentId = getCurrentAgentId();
    if (!sessionId || !agentId) {
      return JSON.stringify({
        error:
          "ping_user requires an active session + agent context (use during a turn).",
      });
    }
    try {
      bindings.emit({ sessionId, agentId, message });
      return JSON.stringify({ acknowledged: true });
    } catch (e) {
      return JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});

const WITHDRAW_DESCRIPTION =
  "Withdraw a request you made to the user with `ping_user` when it no " +
  "longer needs an answer — the task was canceled, the situation moved on, " +
  "or you've since worked out the answer yourself. This clears the request " +
  "from the user's 'Waiting for you' list without them having to reply. It " +
  "only acts on YOUR own outstanding ping in this session; you can't " +
  "withdraw another agent's request. If you're still genuinely waiting on " +
  "the user, leave it. Pass a one-line reason for the audit trail.";

registry.register({
  name: "withdraw_ping",
  toolset: "system",
  description: WITHDRAW_DESCRIPTION,
  parameters: z.object({
    reason: z
      .string()
      .min(1)
      .describe(
        "Why the request no longer needs the user — recorded on the close " +
          "event so there's a trail of what was withdrawn and why."
      ),
  }),
  emoji: "✅",
  parallelSafe: false,
  handler: async (args) => {
    const { reason } = args as { reason: string };
    if (!withdrawBindings) {
      return JSON.stringify({
        error:
          "withdraw_ping not initialized — AgentManager must call bindWithdrawPing().",
      });
    }
    const sessionId = getCurrentSessionId();
    const agentId = getCurrentAgentId();
    if (!sessionId || !agentId) {
      return JSON.stringify({
        error:
          "withdraw_ping requires an active session + agent context (use during a turn).",
      });
    }
    try {
      const cleared = withdrawBindings.withdraw(sessionId, agentId, reason);
      if (!cleared) {
        return JSON.stringify({
          withdrawn: false,
          note: "No outstanding request from you on this session — nothing to withdraw (the user may have already replied).",
        });
      }
      return JSON.stringify({
        withdrawn: true,
        closedQuestion: cleared.message,
        reason,
      });
    } catch (e) {
      return JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
