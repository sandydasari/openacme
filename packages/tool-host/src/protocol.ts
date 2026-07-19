import { z } from "zod";

/**
 * Newline-delimited JSON-RPC over stdio between the daemon and a
 * per-agent tool-host worker. Requests are multiplexed by `id` —
 * parallel-safe tools interleave, unlike the serialized python sidecar.
 *
 * The worker's stdout is the protocol channel; anything non-protocol on
 * it (a stray library print) is skipped by the daemon-side parser. The
 * manager diverts pino to a file via OPENACME_LOG_FILE for this reason.
 */

/** Serializable mirror of @openacme/tools' ToolCallContext — ALS does
 *  not cross processes, so the context rides each request explicitly. */
export const WireContextSchema = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  workspaceDir: z.string(),
  toolCallId: z.string().optional(),
  toolResultMediaSupport: z
    .object({ image: z.boolean(), pdf: z.boolean() })
    .optional(),
});
export type WireContext = z.infer<typeof WireContextSchema>;

export const DaemonMessageSchema = z.union([
  z.object({
    id: z.string(),
    method: z.literal("tool_call"),
    params: z.object({
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
      ctx: WireContextSchema,
    }),
  }),
  z.object({
    method: z.literal("session_closed"),
    params: z.object({ agentId: z.string(), sessionId: z.string() }),
  }),
  // Report stdio MCP connection state + raw tool schemas. Awaits the
  // worker's MCP connect; replies on the standard {id, result} channel
  // with a JSON-encoded McpDiscovery.
  z.object({ id: z.string(), method: z.literal("mcp_discover") }),
  z.object({ method: z.literal("shutdown") }),
]);
export type DaemonMessage = z.infer<typeof DaemonMessageSchema>;

export const WorkerMessageSchema = z.union([
  z.object({ id: z.string(), result: z.string() }),
  z.object({ id: z.string(), error: z.string() }),
  z.object({ method: z.literal("ready") }),
  z.object({
    method: z.literal("process_completed"),
    params: z.object({
      sessionId: z.string(),
      agentId: z.string(),
      result: z.record(z.string(), z.unknown()),
    }),
  }),
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

/** Env var carrying the worker's one-time init payload. */
export const INIT_ENV_VAR = "OPENACME_TOOLHOST_INIT";

export const WorkerInitSchema = z.object({
  agentId: z.string(),
  // stdio-only MCP server configs — the worker connects them as its own
  // children so they inherit the sandbox. Shape is MCPServerConfig;
  // kept loose here to avoid a schema dependency across the boundary.
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});
export type WorkerInit = z.infer<typeof WorkerInitSchema>;

/** Per-server discovery result returned by `mcp_discover`. */
export interface McpServerDiscovery {
  server: string;
  state: string;
  connected: boolean;
  lastError?: string;
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
}
