import type { EmailManager } from "@openacme/email";

/** The email tool names — one source of truth, shared by the config default,
 *  the CLI/web binders, and AgentManager's "hide email tools when no mailbox"
 *  gate. */
export const EMAIL_TOOL_NAMES = [
  "email_list",
  "email_search",
  "email_read",
  "email_send",
  "email_reply",
  "email_mark",
] as const;

export interface EmailBindings {
  manager: EmailManager;
}

// Bound at runtime by AgentManager so this package stays free of a runtime
// dependency on @openacme/email. Mirrors browser/bindings.ts. Email tools are
// gated by AgentManager (excluded from an agent's effective tool set when it
// has no mailbox) — not by a per-tool checkFn, because the tool list is built
// before the AsyncLocalStorage agent context is set.
let bindings: EmailBindings | null = null;

export function bindEmail(b: EmailBindings): void {
  bindings = b;
}

/** Returns the bindings or null if bindEmail hasn't been called yet. */
export function getEmailBindings(): EmailBindings | null {
  return bindings;
}

/** Convenience: returns a JSON-stringified error result if not bound. */
export function notBoundError(toolName: string): string {
  return JSON.stringify({
    error: `${toolName} not initialized — AgentManager must call bindEmail().`,
  });
}

/** Returns the agentId from AsyncLocalStorage or a JSON-stringified error. */
export function requireAgentIdOr(
  toolName: string,
  agentId: string | null
): string | null {
  if (!agentId) {
    return JSON.stringify({
      error: `${toolName} requires an active agent context.`,
    });
  }
  return null;
}

/** Marshal an unknown error into a JSON tool result. */
export function toolError(toolName: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return JSON.stringify({ error: `${toolName} failed: ${msg}` });
}
