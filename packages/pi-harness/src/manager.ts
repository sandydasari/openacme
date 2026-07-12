import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { PiDigest } from "./digest.js";
import { PiRpcClient } from "./rpc-client.js";
import type {
  AgentPiOverrides,
  PiDelegationStatus,
  PiDelegationSummary,
  PiRuntimeConfig,
} from "./types.js";

const MAX_LIVE_GLOBAL = 16;
const FINISHED_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PROMPT_SUMMARY_CHARS = 200;

interface PiDelegation {
  id: string;
  agentId: string;
  client: PiRpcClient;
  digest: PiDigest;
  status: PiDelegationStatus;
  prompt: string;
  cwd: string;
  provider?: string;
  model?: string;
  startedAt: number;
  endedAt: number | null;
  timeoutTimer: NodeJS.Timeout | null;
}

export interface PiManagerOptions {
  /** Resolve the live `pi:` config slice at call time (reloadAll-friendly). */
  resolveConfig: () => PiRuntimeConfig;
  /** Look up per-agent provider/model overrides at start time. */
  resolveOverrides?: (agentId: string) => AgentPiOverrides | undefined;
  /** Spawn env; defaults to the daemon's process.env so API keys pass through. */
  env?: NodeJS.ProcessEnv;
}

export interface PiStartArgs {
  prompt: string;
  cwd: string;
  provider?: string;
  model?: string;
}

/**
 * Per-agent pi delegation orchestrator. Each `start` spawns one
 * `pi --mode rpc` subprocess owning one coding task; the delegating agent
 * polls progress between its own steps. Delegations deliberately survive
 * the OpenAcme turn that started them — cleanup happens only on stop,
 * timeout, deleteAgent, or daemon shutdown.
 *
 * Isolation mirrors the workforce model: every lookup enforces that the
 * delegation belongs to the calling agent.
 */
export class PiManager {
  private readonly resolveConfig: () => PiRuntimeConfig;
  private readonly resolveOverrides:
    | ((agentId: string) => AgentPiOverrides | undefined)
    | null;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly delegations = new Map<string, PiDelegation>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(opts: PiManagerOptions) {
    this.resolveConfig = opts.resolveConfig;
    this.resolveOverrides = opts.resolveOverrides ?? null;
    this.env = opts.env;
  }

  async start(
    agentId: string,
    args: PiStartArgs,
  ): Promise<PiDelegationSummary> {
    const config = this.resolveConfig();
    if (!config.enabled) {
      throw new Error("pi is disabled in config (pi.enabled: false)");
    }
    if (!existsSync(args.cwd)) {
      throw new Error(`cwd does not exist: ${args.cwd}`);
    }
    this.sweep();
    const live = [...this.delegations.values()].filter(
      (d) => d.status === "running",
    );
    if (live.length >= MAX_LIVE_GLOBAL) {
      throw new Error(
        `too many live pi delegations (${MAX_LIVE_GLOBAL}); stop some first`,
      );
    }
    if (
      live.filter((d) => d.agentId === agentId).length >=
      config.maxConcurrentPerAgent
    ) {
      throw new Error(
        `agent already has ${config.maxConcurrentPerAgent} running pi delegations; ` +
          `poll or stop them first`,
      );
    }

    const overrides = this.resolveOverrides?.(agentId);
    const provider = args.provider ?? overrides?.provider ?? config.provider;
    const model = args.model ?? overrides?.model ?? config.model;

    const rpcArgs = ["--mode", "rpc"];
    if (provider) rpcArgs.push("--provider", provider);
    if (model) rpcArgs.push("--model", model);
    rpcArgs.push(...config.extraArgs);

    const client = new PiRpcClient({
      command: config.executablePath,
      args: rpcArgs,
      cwd: args.cwd,
      env: this.env,
    });
    const digest = new PiDigest();
    const d: PiDelegation = {
      id: `pi_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      agentId,
      client,
      digest,
      status: "running",
      prompt: args.prompt,
      cwd: args.cwd,
      provider,
      model,
      startedAt: Date.now(),
      endedAt: null,
      timeoutTimer: null,
    };

    client.onEvent((ev) => {
      digest.feed(ev);
      if (ev.type === "agent_start" && d.status === "settled") {
        // A steer/follow_up woke pi back up.
        d.status = "running";
        d.endedAt = null;
      } else if (
        (ev.type === "agent_settled" || ev.type === "agent_end") &&
        d.status === "running"
      ) {
        d.status = "settled";
        d.endedAt = Date.now();
      }
    });
    client.onExit((code, signal) => {
      this.clearTimer(d);
      if (d.status === "running") {
        d.status = "failed";
        d.endedAt = Date.now();
        const diag = client.diagnostics.slice(-5).join("\n");
        digest.note(
          `[pi exited unexpectedly: code=${code ?? "null"} signal=${signal ?? "null"}]` +
            (diag ? `\n${diag}` : ""),
        );
      } else if (d.endedAt === null) {
        d.endedAt = Date.now();
      }
    });

    await client.spawn();
    // Prompt responses can arrive only at turn end — completion is observed
    // via agent_settled, so this write is deliberately fire-and-forget.
    client.sendNoWait({ type: "prompt", message: args.prompt });

    d.timeoutTimer = setTimeout(() => {
      if (d.status !== "running") return;
      d.status = "timed_out";
      d.endedAt = Date.now();
      d.digest.note(
        `[timed out after ${Math.round(config.taskTimeoutMs / 60_000)} min; killed]`,
      );
      d.client.kill();
    }, config.taskTimeoutMs);
    d.timeoutTimer.unref();

    this.delegations.set(d.id, d);
    this.ensureSweeper();
    return this.summarize(d);
  }

  list(agentId: string): PiDelegationSummary[] {
    this.sweep();
    return [...this.delegations.values()]
      .filter((d) => d.agentId === agentId)
      .map((d) => this.summarize(d));
  }

  status(agentId: string, id: string): PiDelegationSummary {
    return this.summarize(this.get(agentId, id));
  }

  /** Status + new progress since the last poll (drains the pending buffer). */
  poll(
    agentId: string,
    id: string,
  ): PiDelegationSummary & { progress: string } {
    const d = this.get(agentId, id);
    return { ...this.summarize(d), progress: d.digest.drainPending() };
  }

  /** Full (capped) progress transcript. */
  log(
    agentId: string,
    id: string,
  ): PiDelegationSummary & { transcript: string } {
    const d = this.get(agentId, id);
    return { ...this.summarize(d), transcript: d.digest.getAggregate() };
  }

  /** Redirect pi mid-turn. */
  async steer(
    agentId: string,
    id: string,
    message: string,
  ): Promise<PiDelegationSummary> {
    const d = this.getRunning(agentId, id);
    await this.sendSteering(d, { type: "steer", message });
    d.digest.note(`[steered: ${truncate(message, MAX_PROMPT_SUMMARY_CHARS)}]`);
    return this.summarize(d);
  }

  /** Queue a message for after pi finishes its current work. */
  async followUp(
    agentId: string,
    id: string,
    message: string,
  ): Promise<PiDelegationSummary> {
    const d = this.get(agentId, id);
    if (!d.client.isRunning) {
      throw new Error(`delegation ${id} is ${d.status}; its process is gone`);
    }
    if (d.status === "settled") {
      // Process is idle — a follow_up would sit queued forever; prompt runs now.
      d.client.sendNoWait({ type: "prompt", message });
      d.status = "running";
      d.endedAt = null;
      this.resetTimeout(d);
    } else {
      await this.sendSteering(d, { type: "follow_up", message });
    }
    d.digest.note(
      `[follow-up: ${truncate(message, MAX_PROMPT_SUMMARY_CHARS)}]`,
    );
    return this.summarize(d);
  }

  /** Abort pi's current turn but keep the process for a follow-up. */
  async abortTurn(agentId: string, id: string): Promise<PiDelegationSummary> {
    const d = this.getRunning(agentId, id);
    await this.sendSteering(d, { type: "abort" });
    d.digest.note("[turn aborted]");
    return this.summarize(d);
  }

  /** Kill the delegation's subprocess. A settled process stays "settled". */
  stop(agentId: string, id: string): PiDelegationSummary {
    const d = this.get(agentId, id);
    this.clearTimer(d);
    if (d.client.isRunning) {
      if (d.status === "running") {
        d.status = "stopped";
        d.endedAt = Date.now();
      }
      d.client.kill();
      d.digest.note("[stopped]");
    }
    return this.summarize(d);
  }

  /** Kill everything belonging to one agent (deleteAgent path). */
  async closeAgent(agentId: string): Promise<void> {
    for (const d of this.delegations.values()) {
      if (d.agentId !== agentId) continue;
      this.clearTimer(d);
      if (d.client.isRunning) {
        if (d.status === "running") {
          d.status = "stopped";
          d.endedAt = Date.now();
        }
        d.client.kill();
      }
    }
    for (const [id, d] of this.delegations) {
      if (d.agentId === agentId) this.delegations.delete(id);
    }
  }

  /** Kill everything (daemon shutdown). */
  async close(): Promise<void> {
    for (const d of this.delegations.values()) {
      this.clearTimer(d);
      if (d.client.isRunning) d.client.kill();
    }
    this.delegations.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private async sendSteering(
    d: PiDelegation,
    command: Record<string, unknown>,
  ): Promise<void> {
    if (!d.client.isRunning) {
      throw new Error(`delegation ${d.id} is ${d.status}; its process is gone`);
    }
    try {
      await d.client.send(command);
    } catch (e) {
      // Ack timeouts are tolerable — the command was written; events tell
      // the real story. Hard failures (process gone) still surface.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("did not acknowledge")) throw e;
    }
  }

  private get(agentId: string, id: string): PiDelegation {
    const d = this.delegations.get(id);
    if (!d || d.agentId !== agentId) {
      throw new Error(`unknown pi delegation id: ${id}`);
    }
    return d;
  }

  private getRunning(agentId: string, id: string): PiDelegation {
    const d = this.get(agentId, id);
    if (d.status !== "running") {
      throw new Error(`delegation ${id} is ${d.status}, not running`);
    }
    return d;
  }

  private summarize(d: PiDelegation): PiDelegationSummary {
    return {
      id: d.id,
      agentId: d.agentId,
      status: d.status,
      prompt: truncate(d.prompt, MAX_PROMPT_SUMMARY_CHARS),
      cwd: d.cwd,
      provider: d.provider,
      model: d.model,
      pid: d.client.pid,
      startedAt: d.startedAt,
      endedAt: d.endedAt,
      result: d.digest.lastAssistantText || undefined,
    };
  }

  private resetTimeout(d: PiDelegation): void {
    this.clearTimer(d);
    const config = this.resolveConfig();
    d.timeoutTimer = setTimeout(() => {
      if (d.status !== "running") return;
      d.status = "timed_out";
      d.endedAt = Date.now();
      d.digest.note(
        `[timed out after ${Math.round(config.taskTimeoutMs / 60_000)} min; killed]`,
      );
      d.client.kill();
    }, config.taskTimeoutMs);
    d.timeoutTimer.unref();
  }

  private clearTimer(d: PiDelegation): void {
    if (d.timeoutTimer) {
      clearTimeout(d.timeoutTimer);
      d.timeoutTimer = null;
    }
  }

  private ensureSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, d] of this.delegations) {
      if (d.status === "running") continue;
      if (d.client.isRunning) continue; // settled-but-alive stays addressable
      if (d.endedAt && now - d.endedAt > FINISHED_TTL_MS)
        this.delegations.delete(id);
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
