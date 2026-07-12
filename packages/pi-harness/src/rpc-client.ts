import { spawn, type ChildProcess } from "node:child_process";
import { PiNotInstalledError, isPiEvent, type PiEvent } from "./types.js";

const ACK_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_LINES = 100;

export interface PiRpcClientOptions {
  /** Executable to spawn — the resolved pi binary (or a test double). */
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface PendingCommand {
  resolve: (line: PiEvent) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

/**
 * Thin JSONL client over a `pi --mode rpc` subprocess.
 *
 * Commands go to stdin as one JSON object per LF-terminated line; responses
 * echo the command's `id` and settle the matching promise. Everything else
 * on stdout is an event and goes to the `onEvent` subscriber. Turn
 * completion is signaled by the `agent_settled` event, not by a command
 * response — `sendNoWait` exists for commands (like `prompt`) whose
 * response timing is unbounded.
 */
export class PiRpcClient {
  private readonly opts: PiRpcClientOptions;
  private child: ChildProcess | null = null;
  private stdoutBuf = "";
  private seq = 0;
  private readonly pending = new Map<string, PendingCommand>();
  private eventListener: ((ev: PiEvent) => void) | null = null;
  private exitListener:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | null = null;
  /** Bounded ring of stderr lines + unparseable stdout, for error reporting. */
  readonly diagnostics: string[] = [];
  private exited = false;

  constructor(opts: PiRpcClientOptions) {
    this.opts = opts;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Spawns the subprocess. Rejects with PiNotInstalledError on ENOENT. */
  spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.command, this.opts.args, {
        cwd: this.opts.cwd,
        env: this.opts.env ?? process.env,
        detached: process.platform !== "win32", // for process-group kill
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      let settled = false;
      child.once("spawn", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      child.once("error", (err: NodeJS.ErrnoException) => {
        this.addDiagnostic(`[spawn error] ${err.message}`);
        if (!settled) {
          settled = true;
          reject(
            err.code === "ENOENT"
              ? new PiNotInstalledError(this.opts.command)
              : err,
          );
        }
      });

      child.stdout?.on("data", (b: Buffer) =>
        this.onStdout(b.toString("utf-8")),
      );
      child.stderr?.on("data", (b: Buffer) => {
        for (const line of b.toString("utf-8").split("\n")) {
          if (line.trim() !== "") this.addDiagnostic(`[stderr] ${line}`);
        }
      });
      child.on("exit", (code, signal) => {
        this.exited = true;
        const err = new Error(
          `pi exited (code=${code ?? "null"}, signal=${signal ?? "null"}) before responding`,
        );
        for (const p of this.pending.values()) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        this.exitListener?.(code, signal);
      });
    });
  }

  onEvent(cb: (ev: PiEvent) => void): void {
    this.eventListener = cb;
  }

  onExit(
    cb: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    this.exitListener = cb;
  }

  /** Send a command and await the id-correlated response. */
  send(
    command: Record<string, unknown>,
    timeoutMs = ACK_TIMEOUT_MS,
  ): Promise<PiEvent> {
    return new Promise((resolve, reject) => {
      if (!this.isRunning || !this.child?.stdin || this.child.stdin.destroyed) {
        reject(new Error("pi process is not running"));
        return;
      }
      const id = `c${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `pi did not acknowledge \`${String(command.type)}\` within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }

  /** Fire-and-forget write — for commands whose response timing is unbounded. */
  sendNoWait(command: Record<string, unknown>): void {
    if (!this.isRunning || !this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error("pi process is not running");
    }
    this.child.stdin.write(JSON.stringify(command) + "\n");
  }

  /** SIGTERM the process group, escalate to SIGKILL after 2s. */
  kill(): void {
    const child = this.child;
    if (!child || this.exited) return;
    const pid = child.pid;
    try {
      if (pid && process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* already dead */
    }
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (pid && process.platform !== "win32") {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          /* already dead */
        }
      }
    }, 2000);
    escalate.unref();
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, nl).replace(/\r$/, "");
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.addDiagnostic(`[unparseable] ${line.slice(0, 500)}`);
        continue;
      }
      if (!isPiEvent(parsed)) {
        this.addDiagnostic(`[non-event] ${line.slice(0, 500)}`);
        continue;
      }
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === "string" && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        const errField = (parsed as { error?: unknown }).error;
        const success = (parsed as { success?: unknown }).success;
        if (errField !== undefined && errField !== null) {
          p.reject(
            new Error(
              typeof errField === "string"
                ? errField
                : JSON.stringify(errField),
            ),
          );
        } else if (success === false) {
          p.reject(new Error(`pi rejected command: ${line.slice(0, 500)}`));
        } else {
          p.resolve(parsed);
        }
        continue;
      }
      this.eventListener?.(parsed);
    }
  }

  private addDiagnostic(line: string): void {
    this.diagnostics.push(line);
    if (this.diagnostics.length > MAX_DIAGNOSTIC_LINES) {
      this.diagnostics.splice(
        0,
        this.diagnostics.length - MAX_DIAGNOSTIC_LINES,
      );
    }
  }
}
