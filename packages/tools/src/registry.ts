import { z } from "zod";
import { createLogger } from "@openacme/config/logger";
import type { ToolEntry, ToolDefinition, ToolInfo } from "./types.js";
import { SYSTEM_TOOLS } from "./system.js";
import { maybeSpill } from "./spill.js";
import { toolCallContext } from "./session-context.js";
import { getToolHostDispatcher } from "./tool-host-binding.js";

const log = createLogger("tools.registry");

const SYSTEM_TOOL_SET = new Set<string>(SYSTEM_TOOLS);

/**
 * Singleton tool registry — mirrors Hermes tools/registry.py ToolRegistry.
 *
 * Tools self-register via `registry.register()`. MCP tools are dynamically
 * added/removed. The registry provides definitions for the LLM API and
 * dispatches tool calls to their handlers.
 */
export class ToolRegistry {
  private _tools = new Map<string, ToolEntry>();
  private _generation = 0;

  /**
   * Register a tool. Called at initialization time or dynamically for MCP tools.
   */
  register(entry: ToolEntry): void {
    const existing = this._tools.get(entry.name);
    if (existing && existing.toolset !== entry.toolset) {
      // Prevent shadowing unless both are MCP tools (legitimate: server refresh)
      const bothMcp =
        existing.toolset.startsWith("mcp-") && entry.toolset.startsWith("mcp-");
      if (!bothMcp) {
        log.error(
          {
            tool: entry.name,
            toolset: entry.toolset,
            existingToolset: existing.toolset,
          },
          "tool registration rejected: would shadow existing tool"
        );
        return;
      }
    }
    this._tools.set(entry.name, entry);
    this._generation++;
  }

  /**
   * Remove a tool from the registry. Used by MCP dynamic tool discovery.
   */
  deregister(name: string): void {
    if (this._tools.delete(name)) {
      this._generation++;
    }
  }

  /**
   * Get a tool entry by name.
   */
  get(name: string): ToolEntry | undefined {
    return this._tools.get(name);
  }

  /**
   * Get all registered tool names.
   */
  getAllToolNames(): string[] {
    return [...this._tools.keys()].sort();
  }

  /**
   * Serializable description of every registered tool — used by API clients
   * (web UI, etc.) to render tool pickers without leaking handler internals.
   */
  getInfo(): ToolInfo[] {
    return [...this._tools.values()]
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        toolset: entry.toolset,
        emoji: entry.emoji,
        system: SYSTEM_TOOL_SET.has(entry.name) || undefined,
      }))
      .sort((a, b) =>
        a.toolset === b.toolset
          ? a.name.localeCompare(b.name)
          : a.toolset.localeCompare(b.toolset)
      );
  }

  /**
   * Model-facing emission order. Map iteration is insertion order and MCP
   * servers connect in parallel, so the raw order can shuffle across
   * restarts — which reorders the serialized `tools` block and invalidates
   * the provider-side prompt cache for the entire prefix. Name-sorted is
   * byte-stable.
   */
  private sortedEntries(): ToolEntry[] {
    return [...this._tools.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  /**
   * Get tool definitions in the format expected by the Vercel AI SDK.
   * Only includes tools whose checkFn() passes (or have no checkFn).
   */
  getDefinitions(toolNames?: Set<string>): ToolDefinition[] {
    const result: ToolDefinition[] = [];
    for (const entry of this.sortedEntries()) {
      if (toolNames && !toolNames.has(entry.name)) continue;
      if (entry.checkFn && !entry.checkFn()) continue;

      result.push({
        type: "function",
        function: {
          name: entry.name,
          description: entry.description,
          parameters: z.toJSONSchema(entry.parameters, { target: "draft-07" }),
        },
      });
    }
    return result;
  }

  /**
   * Get tools as a Vercel AI SDK `tools` object for generateText/streamText.
   */
  getVercelTools(toolNames?: Set<string>): Record<string, unknown> {
    const tools: Record<string, unknown> = {};
    for (const entry of this.sortedEntries()) {
      if (toolNames && !toolNames.has(entry.name)) continue;
      if (entry.checkFn && !entry.checkFn()) continue;

      const toolDef: Record<string, unknown> = {
        description: entry.description,
        inputSchema: entry.parameters,
        execute: async (
          args: Record<string, unknown>,
          opts: { toolCallId?: string } = {}
        ) => {
          // Thread the per-call id into the ALS context so handlers
          // (read_file image/PDF, browser_take_screenshot) can namespace
          // their tool-files-dir copies without changing tool signatures.
          const store = toolCallContext.getStore();
          if (store && opts.toolCallId) {
            store.toolCallId = opts.toolCallId;
          }
          try {
            // Worker-runtime tools route to the per-agent sandboxed tool
            // host when one is bound. The worker re-enters the context,
            // runs the same handler module, and applies spill — so no
            // daemon-side maybeSpill here (the spill dir is only writable
            // by the worker). Unbound (tests, scripts) → local fallback.
            if (entry.runtime === "worker" && store) {
              const dispatcher = getToolHostDispatcher();
              if (dispatcher) {
                return await dispatcher.dispatch(entry.name, args, {
                  ...store,
                });
              }
            }
            const result = await entry.handler(args);
            return maybeSpill(result, entry);
          } finally {
            if (store) store.toolCallId = undefined;
          }
        },
      };
      if (entry.toModelOutput) {
        toolDef.toModelOutput = entry.toModelOutput;
      }
      tools[entry.name] = toolDef;
    }
    return tools;
  }

  /**
   * Dispatch a tool call by name.
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const entry = this._tools.get(name);
    if (!entry) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    // Validate + apply schema defaults, mirroring what the AI SDK does
    // before `execute`. Without this, optional-with-default params (e.g.
    // shell's `timeout`) arrive undefined on the dispatch path — the
    // tool-host worker routes every call through here.
    const parsed = entry.parameters.safeParse(args);
    if (!parsed.success) {
      return JSON.stringify({
        error: `Invalid arguments for ${name}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
    }
    try {
      const result = await entry.handler(
        parsed.data as Record<string, unknown>
      );
      return await maybeSpill(result, entry);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: `Tool execution failed: ${message}` });
    }
  }

  /**
   * Current generation counter. Consumers can cache against this.
   */
  get generation(): number {
    return this._generation;
  }

  /**
   * Get unique toolset names.
   */
  getToolsets(): string[] {
    const sets = new Set<string>();
    for (const entry of this._tools.values()) {
      sets.add(entry.toolset);
    }
    return [...sets].sort();
  }
}

/** Module-level singleton */
export const registry = new ToolRegistry();
