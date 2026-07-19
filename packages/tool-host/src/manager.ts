import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { createLogger } from "@openacme/config/logger";
import type { PathPolicy } from "@openacme/config";
import type {
  ProcessCompletionEvent,
  ToolCallContext,
  ToolHostDispatcher,
} from "@openacme/tools";
import {
  INIT_ENV_VAR,
  WorkerMessageSchema,
  type DaemonMessage,
  type McpServerDiscovery,
  type WorkerInit,
} from "./protocol.js";
import { checkSandboxSupport, wrapSpawn, resetSandbox } from "./sandbox.js";

const log = createLogger("tool-host.manager");

/** Ceiling on a single RPC — tools carry their own (much shorter)
 *  timeouts; this is the backstop against a wedged worker call. */
const RPC_TIMEOUT_MS = 10 * 60 * 1000;
const READY_TIMEOUT_MS = 15_000;
const TERM_GRACE_MS = 3_000;

type WorkerProc = ChildProcessByStdio<Writable, Readable, Readable>;

interface WorkerHandle {
  agentId: string;
  proc: WorkerProc;
  pending: Map<string, { resolve: (result: string) => void; timer: NodeJS.Timeout }>;
  alive: boolean;
}

export interface ToolHostManagerOptions {
  dataDir: string;
  /** Compile the agent's path policy at spawn time — fresh on every
   *  (re)spawn so team/definition edits take effect on the next worker.
   *  Consumed by the sandbox wrapper; a plain spawn ignores it. */
  compilePolicyFor: (agentId: string) => PathPolicy;
  /** stdio-only MCP server configs for an agent — connected INSIDE the
   *  worker so the server processes inherit the sandbox. Resolved at
   *  spawn time, same freshness rule as the policy. */
  stdioMcpServersFor?: (agentId: string) => Record<string, unknown>;
  /** Fired after a worker becomes ready. Used by the daemon to refresh
   *  cache-served MCP discovery once a real worker exists. Must not
   *  throw; called synchronously after the ready handshake. */
  onWorkerSpawned?: (agentId: string) => void;
  /** Fired when a detached `process.run` completes inside the worker. */
  onProcessCompleted?: (event: ProcessCompletionEvent) => void;
}

// Env keys that never reach the worker (and therefore never reach the
// agent's shell or its children). Blocklist over allowlist: the worker
// legitimately inherits the user's PATH/toolchain; what must not leak
// are credentials — same posture as mcp-client's buildSafeEnv.
const SENSITIVE_ENV =
  /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|AUTH)/i;

function workerEnv(dataDir: string, agentId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV.test(key)) continue;
    env[key] = value;
  }
  env["OPENACME_DATA_DIR"] = dataDir;
  // The worker's stdout is the RPC channel — divert pino to a file.
  // Lives under the agent's sessions dir, which the policy grants rw.
  env["OPENACME_LOG_FILE"] = path.join(
    dataDir,
    "agents",
    agentId,
    "sessions",
    "_tool-host.log"
  );
  return env;
}

/** Worker entrypoint resolution. Built output (dist/worker.js) is
 *  preferred — plain node, no loader assumptions. Running from src/
 *  (tsx dev, vitest) we still prefer the built sibling when it exists
 *  (package `dev` runs tsc --watch, so it stays fresh); the .ts + parent
 *  execArgv fallback covers a loader-based dev process with no dist. */
const WORKER_ENTRY: { path: string; useExecArgv: boolean } = (() => {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  if (here.endsWith(".ts")) {
    const dist = path.resolve(dir, "..", "dist", "worker.js");
    if (fs.existsSync(dist)) return { path: dist, useExecArgv: false };
    return { path: path.join(dir, "worker.ts"), useExecArgv: true };
  }
  return { path: path.join(dir, "worker.js"), useExecArgv: false };
})();

function errorResult(message: string): string {
  return JSON.stringify({ error: message });
}

/**
 * Per-agent tool-host workers — lazy Map lifecycle copied from
 * BrowserManager: nothing spawns until the first worker-runtime tool
 * call; N idle agents hold 0 workers. Implements ToolHostDispatcher for
 * the registry's `bindToolHost` seam.
 */
export class ToolHostManager implements ToolHostDispatcher {
  private instances = new Map<string, WorkerHandle>();
  private connecting = new Map<string, Promise<WorkerHandle>>();
  private readonly opts: ToolHostManagerOptions;

  /** Non-null when workers run UNCONFINED (unsupported platform /
   *  missing Linux deps). Set at construction so the degradation is
   *  known — and reportable — before any tool runs. */
  readonly degradeReason: string | null;

  constructor(opts: ToolHostManagerOptions) {
    this.opts = opts;
    const support = checkSandboxSupport();
    this.degradeReason = support.supported ? null : support.reason;
  }

  async dispatch(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolCallContext
  ): Promise<string> {
    let handle: WorkerHandle;
    try {
      handle = await this.ensureWorker(ctx.agentId);
    } catch (e) {
      return errorResult(
        `tool-host worker failed to start: ${(e as Error).message}`
      );
    }

    const msg: DaemonMessage = {
      id: randomUUID(),
      method: "tool_call",
      params: { name: toolName, args, ctx },
    };
    return this.sendRequest(handle, msg.id, msg, RPC_TIMEOUT_MS);
  }

  /** Query the agent's worker for stdio MCP state + raw tool schemas.
   *  Spawns the worker (eagerly, from the caller's perspective) so MCP
   *  tool definitions exist before the first prompt build. */
  async discoverMcp(agentId: string): Promise<McpServerDiscovery[]> {
    // A worker that exits mid-call is retryable by contract — respawn (the
    // exit handler already evicted the dead handle) and try again, so a
    // transient blip during agent creation doesn't silently drop MCP tools.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const handle = await this.ensureWorker(agentId);
      const id = randomUUID();
      const raw = await this.sendRequest(
        handle,
        id,
        { id, method: "mcp_discover" },
        RPC_TIMEOUT_MS
      );
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as McpServerDiscovery[];
      const err =
        (parsed as { error?: string })?.error ??
        "malformed mcp_discover response";
      if (/worker exited/i.test(err) && attempt < MAX_ATTEMPTS) continue;
      throw new Error(err);
    }
    /* unreachable — the loop returns or throws */
    throw new Error("mcp_discover failed");
  }

  private sendRequest(
    handle: WorkerHandle,
    id: string,
    msg: DaemonMessage,
    timeoutMs: number
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        handle.pending.delete(id);
        resolve(errorResult(`tool-host call timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      handle.pending.set(id, { resolve, timer });
      handle.proc.stdin.write(JSON.stringify(msg) + "\n", (err) => {
        if (err) {
          const entry = handle.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            handle.pending.delete(id);
            resolve(errorResult(`tool-host write failed: ${err.message}`));
          }
        }
      });
    });
  }

  /** Forward session teardown so the worker can close that session's
   *  persistent shell. No-op when the agent has no live worker. */
  notifySessionClosed(agentId: string, sessionId: string): void {
    const handle = this.instances.get(agentId);
    if (!handle?.alive) return;
    const msg: DaemonMessage = {
      method: "session_closed",
      params: { agentId, sessionId },
    };
    handle.proc.stdin.write(JSON.stringify(msg) + "\n", () => {});
  }

  /** Kill an agent's worker (policy change, eviction, deletion). The
   *  next worker-runtime tool call respawns with a fresh policy. */
  async stopWorker(agentId: string): Promise<void> {
    const inflight = this.connecting.get(agentId);
    if (inflight) {
      try {
        await inflight;
      } catch {
        // failed spawn — nothing to stop
      }
    }
    const handle = this.instances.get(agentId);
    if (!handle) return;
    this.instances.delete(agentId);
    await this.terminate(handle);
  }

  async stopAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    await Promise.all(ids.map((id) => this.stopWorker(id)));
  }

  /** Full teardown: every worker plus srt's host-side proxies. */
  async close(): Promise<void> {
    await this.stopAll();
    await resetSandbox();
  }

  private ensureWorker(agentId: string): Promise<WorkerHandle> {
    const existing = this.instances.get(agentId);
    if (existing?.alive) return Promise.resolve(existing);
    if (existing) this.instances.delete(agentId);

    const inflight = this.connecting.get(agentId);
    if (inflight) return inflight;

    const promise = this.spawnWorker(agentId).finally(() => {
      this.connecting.delete(agentId);
    });
    this.connecting.set(agentId, promise);
    return promise;
  }

  /** Resolve the final argv + env for the worker. Sandboxed when the
   *  platform supports it; otherwise the same worker, unconfined, with
   *  the degradation already announced at construction. */
  private async buildSpawnPlan(policy: PathPolicy): Promise<{
    argv: string[];
    env: NodeJS.ProcessEnv;
  }> {
    const baseArgv = [
      process.execPath,
      ...(WORKER_ENTRY.useExecArgv ? process.execArgv : []),
      WORKER_ENTRY.path,
    ];
    if (this.degradeReason !== null) {
      return { argv: baseArgv, env: {} };
    }
    return wrapSpawn(baseArgv, policy);
  }

  private async spawnWorker(agentId: string): Promise<WorkerHandle> {
    const policy = this.opts.compilePolicyFor(agentId);
    const plan = await this.buildSpawnPlan(policy);
    fs.mkdirSync(this.opts.dataDir, { recursive: true });

    fs.mkdirSync(
      path.join(this.opts.dataDir, "agents", agentId, "sessions"),
      { recursive: true }
    );
    const init: WorkerInit = {
      agentId,
      mcpServers: this.opts.stdioMcpServersFor?.(agentId),
    };
    const proc = spawn(plan.argv[0]!, plan.argv.slice(1), {
      env: {
        ...workerEnv(this.opts.dataDir, agentId),
        ...plan.env,
        [INIT_ENV_VAR]: JSON.stringify(init),
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as WorkerProc;

    const handle: WorkerHandle = {
      agentId,
      proc,
      pending: new Map(),
      alive: true,
    };

    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) log.warn({ agentId, stderr: text }, "tool-host worker stderr");
    });

    const ready = new Promise<void>((resolve, reject) => {
      const readyTimer = setTimeout(
        () => reject(new Error("worker did not become ready in time")),
        READY_TIMEOUT_MS
      );
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line: string) => {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          return; // stray non-protocol output — ignore
        }
        const parsed = WorkerMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        const msg = parsed.data;
        if ("method" in msg) {
          if (msg.method === "ready") {
            clearTimeout(readyTimer);
            resolve();
          } else if (msg.method === "process_completed") {
            try {
              this.opts.onProcessCompleted?.(msg.params);
            } catch (e) {
              log.warn(
                { err: e, agentId, processId: msg.params.result.id },
                "process completion handler failed"
              );
            }
          }
          return;
        }
        const entry = handle.pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        handle.pending.delete(msg.id);
        entry.resolve(
          "result" in msg ? msg.result : errorResult(msg.error)
        );
      });

      proc.on("error", (err) => {
        clearTimeout(readyTimer);
        reject(err);
      });
      proc.on("exit", (code, signal) => {
        clearTimeout(readyTimer);
        handle.alive = false;
        // Settle anything in flight; the next call respawns.
        for (const [id, entry] of handle.pending) {
          clearTimeout(entry.timer);
          entry.resolve(
            errorResult(
              `tool-host worker exited (code=${code ?? "null"}, signal=${signal ?? "null"}) — state (shell cwd, REPL) was reset; retry the call`
            )
          );
          handle.pending.delete(id);
        }
        if (this.instances.get(agentId) === handle) {
          this.instances.delete(agentId);
        }
        reject(new Error("worker exited before ready"));
      });
    });

    await ready;
    this.instances.set(agentId, handle);
    log.info({ agentId, pid: proc.pid }, "tool-host worker started");
    try {
      this.opts.onWorkerSpawned?.(agentId);
    } catch (e) {
      log.warn({ err: e, agentId }, "onWorkerSpawned hook failed");
    }
    return handle;
  }

  private async terminate(handle: WorkerHandle): Promise<void> {
    if (!handle.alive) return;
    const msg: DaemonMessage = { method: "shutdown" };
    try {
      handle.proc.stdin.write(JSON.stringify(msg) + "\n", () => {});
    } catch {
      // stdin may already be gone
    }
    handle.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          handle.proc.kill("SIGKILL");
        } catch {
          // already dead
        }
        resolve();
      }, TERM_GRACE_MS);
      handle.proc.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      if (!handle.alive) {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }
}
