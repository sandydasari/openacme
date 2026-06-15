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
  query: z
    .string()
    .min(1)
    .describe(
      "Search text. Matched against subject, from, to, and body (Gmail accepts its native search operators)."
    ),
  mailbox: z.string().optional().describe("Folder to search (IMAP only). Default INBOX."),
  limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
});

registry.register({
  name: "email_search",
  toolset: "email",
  emoji: "🔎",
  parallelSafe: true,
  description:
    "Search this agent's own mailbox and return matching message summaries. Use email_read with an id for the full message.",
  parameters: Params,
  handler: async (args) => {
    const p = args as z.infer<typeof Params>;
    const b = getEmailBindings();
    if (!b) return notBoundError("email_search");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("email_search", agentId);
    if (guard) return guard;
    try {
      const messages = await b.manager.search(agentId!, {
        query: p.query,
        mailbox: p.mailbox,
        limit: p.limit,
      });
      return JSON.stringify({ messages });
    } catch (e) {
      return toolError("email_search", e);
    }
  },
});
