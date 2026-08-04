/**
 * Tool-host worker entrypoint — one process per agent, spawned by
 * ToolHostManager (sandboxed under @anthropic-ai/sandbox-runtime where
 * the platform supports it; plain otherwise).
 *
 * Importing @openacme/tools self-registers every builtin into THIS
 * process's registry singleton — the handlers are byte-identical to the
 * daemon's; only the process (and therefore the kernel's view of it)
 * differs. Zero policy logic lives here: a denied path simply surfaces
 * as the OS error the handler already reports.
 *
 * Module state that used to be daemon-lifetime (persistent ShellSession
 * registry, python REPL, background `process` entries) now lives here —
 * worker restart resets it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as readline from "node:readline";
import {
  registry,
  toolCallContext,
  bindProcessEvents,
  closeShellSession,
  closeAllShellSessions,
  type ToolCallContext,
} from "@openacme/tools";
import { MCPClient } from "@openacme/mcp-client";
import type { MCPServerConfig } from "@openacme/config";
import {
  DaemonMessageSchema,
  INIT_ENV_VAR,
  WorkerInitSchema,
  type McpServerDiscovery,
  type WorkerMessage,
} from "./protocol.js";

function send(msg: WorkerMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

bindProcessEvents({
  emitCompletion: (event) => {
    send({ method: "process_completed", params: event });
  },
});

// The sandbox redirects TMPDIR (srt uses /tmp/claude) but doesn't create
// it; the shell/python tools write temp files there.
try {
  fs.mkdirSync(os.tmpdir(), { recursive: true });
} catch {
  // tools surface their own errors if temp is truly unusable
}

// stdio MCP servers connect as children of THIS process, inheriting the
// sandbox. Connection starts at boot; tool calls for `mcp_*` names and
// `mcp_discover` await it.
const init = (() => {
  const raw = process.env[INIT_ENV_VAR];
  if (!raw) return null;
  try {
    return WorkerInitSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
})();

const mcpServers = (init?.mcpServers ?? {}) as Record<string, MCPServerConfig>;
const mcpClient = Object.keys(mcpServers).length > 0 ? new MCPClient(registry) : null;
const mcpReady: Promise<void> = mcpClient
  ? mcpClient.connect(mcpServers).then(
      () => undefined,
      () => undefined
    )
  : Promise.resolve();

async function discoverMcp(): Promise<McpServerDiscovery[]> {
  await mcpReady;
  if (!mcpClient) return [];
  return mcpClient.getStatus().map((s) => ({
    server: s.name,
    state: s.state,
    connected: s.connected,
    lastError: s.lastError,
    tools: mcpClient.getToolSchemas(s.name),
  }));
}

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    closeAllShellSessions();
  } catch {
    // best-effort teardown
  }
  if (mcpClient) {
    void mcpClient.disconnect().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
    return;
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return; // not protocol traffic
  }
  const parsed = DaemonMessageSchema.safeParse(raw);
  if (!parsed.success) return;
  const msg = parsed.data;

  if (msg.method === "shutdown") {
    shutdown();
    return;
  }

  if (msg.method === "session_closed") {
    try {
      closeShellSession(msg.params.agentId, msg.params.sessionId);
    } catch {
      // session may never have opened a shell
    }
    return;
  }

  if (msg.method === "mcp_discover") {
    const { id } = msg;
    void discoverMcp().then(
      (servers) => send({ id, result: JSON.stringify(servers) }),
      (e) => send({ id, error: (e as Error).message || "mcp discovery failed" })
    );
    return;
  }

  // tool_call — async, multiplexed by id; parallel-safe tools interleave.
  const { id, params } = msg;
  void (async () => {
    try {
      // MCP tools register only after the worker-side connect settles.
      if (params.name.startsWith("mcp_")) await mcpReady;
      const ctx: ToolCallContext = { ...params.ctx };
      const result = await toolCallContext.run(ctx, () =>
        registry.dispatch(params.name, params.args)
      );
      send({ id, result });
    } catch (e) {
      send({ id, error: (e as Error).message || "tool-host worker error" });
    }
  })();
});

// Daemon closing our stdin means it's gone — don't outlive it.
rl.on("close", shutdown);

send({ method: "ready" });
