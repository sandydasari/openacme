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
  mailbox: z
    .string()
    .optional()
    .describe("Folder (IMAP) or label (Gmail) to list. Default INBOX."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max messages to return (default 20)."),
  unreadOnly: z.boolean().optional().describe("Only return unread messages."),
});

registry.register({
  name: "email_list",
  toolset: "email",
  emoji: "📬",
  parallelSafe: true,
  description:
    "List recent messages in this agent's own mailbox as summaries (id, from, subject, date, unread, hasAttachments). Use email_read with an id to get the full body.",
  parameters: Params,
  handler: async (args) => {
    const p = args as z.infer<typeof Params>;
    const b = getEmailBindings();
    if (!b) return notBoundError("email_list");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("email_list", agentId);
    if (guard) return guard;
    try {
      const messages = await b.manager.list(agentId!, {
        mailbox: p.mailbox,
        limit: p.limit,
        unreadOnly: p.unreadOnly,
      });
      return JSON.stringify({ messages });
    } catch (e) {
      return toolError("email_list", e);
    }
  },
});
