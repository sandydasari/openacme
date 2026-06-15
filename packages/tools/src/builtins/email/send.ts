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
  to: z.array(z.string()).min(1).describe("Recipient email addresses."),
  cc: z.array(z.string()).optional().describe("CC addresses."),
  bcc: z.array(z.string()).optional().describe("BCC addresses."),
  subject: z.string().describe("Subject line."),
  text: z.string().optional().describe("Plain-text body."),
  html: z.string().optional().describe("HTML body (takes precedence over text)."),
});

registry.register({
  name: "email_send",
  toolset: "email",
  emoji: "📤",
  parallelSafe: false,
  description:
    "Send an email FROM this agent's own address. Provide text and/or html. Sends immediately — there is no human confirmation step. Returns { ok: true } plus the message id when the provider supplies one (Microsoft Graph does not).",
  parameters: Params,
  handler: async (args) => {
    const p = args as z.infer<typeof Params>;
    const b = getEmailBindings();
    if (!b) return notBoundError("email_send");
    const agentId = getCurrentAgentId();
    const guard = requireAgentIdOr("email_send", agentId);
    if (guard) return guard;
    if (!p.text && !p.html) {
      return JSON.stringify({ error: "email_send requires `text` or `html`." });
    }
    try {
      const r = await b.manager.send(agentId!, {
        to: p.to,
        cc: p.cc,
        bcc: p.bcc,
        subject: p.subject,
        text: p.text,
        html: p.html,
      });
      return JSON.stringify({ ok: true, ...r });
    } catch (e) {
      return toolError("email_send", e);
    }
  },
});
