import { z } from "zod";
import { registry } from "../../registry.js";
import { getCurrentAgentId } from "../../session-context.js";
import {
  getEmailBindings,
  notBoundError,
  requireAgentIdOr,
  toolError,
} from "./bindings.js";

const Params = z.object({
  messageId: z.string().min(1).describe("Message id to act on."),
  action: z
    .enum(["read", "unread", "flag", "unflag", "trash"])
    .describe("read/unread toggle \\Seen; flag/unflag toggle the star; trash moves to Trash."),
  mailbox: z.string().optional().describe("Folder the message lives in (IMAP only). Default INBOX."),
});

registry.register({
  name: "email_mark",
  toolset: "email",
  emoji: "🏷️",
  parallelSafe: false,
  description:
    "Change a message's state in this agent's mailbox: mark read/unread, flag/unflag (star), or move to Trash.",
  parameters: Params,
  handler: async (args) => {
    const p = args as z.infer<typeof Params>;
    const b = getEmailBindings();
    if (!b) return notBoundError("email_mark");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("email_mark", agentId);
    if (guard) return guard;
    try {
      const r = await b.manager.mark(agentId!, {
        messageId: p.messageId,
        action: p.action,
        mailbox: p.mailbox,
      });
      return JSON.stringify(r);
    } catch (e) {
      return toolError("email_mark", e);
    }
  },
});
