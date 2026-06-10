import type { ToolCallContext } from "./session-context.js";

/**
 * Runtime binding for the per-agent sandboxed tool host. Tools tagged
 * `runtime: "worker"` route through this dispatcher when bound (the
 * server binds it at AgentManager construction); unbound, the registry
 * falls back to the local handler — unit tests and ad-hoc callers keep
 * working without a worker.
 *
 * The ALS context is passed explicitly: AsyncLocalStorage doesn't cross
 * process boundaries, and the worker re-enters it around the handler.
 */
export interface ToolHostDispatcher {
  /** Execute `toolName` in the agent's worker. Returns the final result
   *  string (the worker side applies spill). Must not throw for tool
   *  errors — return the error-JSON string like `registry.dispatch`. */
  dispatch(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolCallContext
  ): Promise<string>;
}

let dispatcher: ToolHostDispatcher | null = null;

export function bindToolHost(d: ToolHostDispatcher): void {
  dispatcher = d;
}

export function getToolHostDispatcher(): ToolHostDispatcher | null {
  return dispatcher;
}
