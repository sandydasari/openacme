import { z } from "zod";
import { registry } from "../../registry.js";
import { getCurrentAgentId } from "../../session-context.js";
import {
  getEmailBindings,
  notBoundError,
  requireAgentIdOr,
  toolError,
} from "./bindings.js";

// Body cap so a giant HTML email can't blow up a single tool result.
const MAX_BODY_CHARS = 40_000;

function clamp(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  if (s.length <= MAX_BODY_CHARS) return s;
  return s.slice(0, MAX_BODY_CHARS) + `\n…[truncated ${s.length - MAX_BODY_CHARS} chars]`;
}

const Params = z.object({
  messageId: z
    .string()
    .min(1)
    .describe("Message id from email_list / email_search."),
  mailbox: z
    .string()
    .optional()
    .describe("Folder the message lives in (IMAP only). Default INBOX."),
});

registry.register({
  name: "email_read",
  toolset: "email",
  emoji: "📧",
  parallelSafe: true,
  description:
    "Read one message from this agent's mailbox in full: headers, body (text preferred, html fallback), and attachment metadata (filename/mimeType/size). Body is truncated if very large.",
  parameters: Params,
  handler: async (args) => {
    const p = args as z.infer<typeof Params>;
    const b = getEmailBindings();
    if (!b) return notBoundError("email_read");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("email_read", agentId);
    if (guard) return guard;
    try {
      const m = await b.manager.read(agentId!, p.messageId, p.mailbox);
      return JSON.stringify({
        ...m,
        bodyText: clamp(m.bodyText),
        bodyHtml: clamp(m.bodyHtml),
      });
    } catch (e) {
      return toolError("email_read", e);
    }
  },
});
