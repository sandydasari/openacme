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
  messageId: z
    .string()
    .min(1)
    .describe("Id of the message to reply to (from email_list / email_search)."),
  text: z.string().optional().describe("Plain-text reply body."),
  html: z.string().optional().describe("HTML reply body (takes precedence over text)."),
  replyAll: z.boolean().optional().describe("Reply to all original recipients."),
  mailbox: z
    .string()
    .optional()
    .describe("Folder the original message lives in (IMAP only). Default INBOX."),
});

registry.register({
  name: "email_reply",
  toolset: "email",
  emoji: "↩️",
  parallelSafe: false,
  description:
    "Reply to a message in this agent's mailbox, preserving the thread (subject + In-Reply-To). Sends immediately. Returns { ok: true } plus the message id when the provider supplies one.",
  parameters: Params,
  handler: async (args) => {
    const p = args as z.infer<typeof Params>;
    const b = getEmailBindings();
    if (!b) return notBoundError("email_reply");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("email_reply", agentId);
    if (guard) return guard;
    if (!p.text && !p.html) {
      return JSON.stringify({ error: "email_reply requires `text` or `html`." });
    }
    try {
      const r = await b.manager.reply(agentId!, {
        messageId: p.messageId,
        text: p.text,
        html: p.html,
        replyAll: p.replyAll,
        mailbox: p.mailbox,
      });
      return JSON.stringify({ ok: true, ...r });
    } catch (e) {
      return toolError("email_reply", e);
    }
  },
});
