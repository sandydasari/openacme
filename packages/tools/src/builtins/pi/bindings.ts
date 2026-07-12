import type { PiManager } from "@openacme/pi-harness";

export interface PiBindings {
  manager: PiManager;
}

// Bound at runtime by AgentManager so this package stays free of a runtime
// dependency on @openacme/pi-harness. Mirrors browser/bindings.ts.
let bindings: PiBindings | null = null;

export function bindPi(b: PiBindings): void {
  bindings = b;
}

export function getPiBindings(): PiBindings | null {
  return bindings;
}

export function piNotBoundError(): string {
  return JSON.stringify({
    error: "pi not initialized — AgentManager must call bindPi().",
  });
}

export function requirePiAgentId(agentId: string | null): string | null {
  if (!agentId) {
    return JSON.stringify({ error: "pi requires an active agent context." });
  }
  return null;
}

export function piToolError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return JSON.stringify({ error: `pi failed: ${msg}` });
}
