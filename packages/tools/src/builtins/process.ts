import { z } from 'zod';
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registry } from "../registry.js";
import { getCurrentWorkspaceDir } from "../session-context.js";

/**
 * Background process management. One tool with an action enum, mirroring
 * Hermes's `process` tool and OpenClaw's `process` shape.
 *
 * In-memory only — no checkpoint, no restart recovery. Output is captured
 * into two buffers per process:
 *   - `pending`  : drained by `poll`, returned and cleared each call.
 *                  Lets the agent stream a long-running command's output
 *                  without re-reading what it already saw.
 *   - `aggregate`: full transcript (capped + tail-preserved on overflow),
 *                  returned by `log` for later inspection.
 *
 * Two timers per process:
 *   - overall hard timeout (`timeoutMs`)
 *   - silence timeout (`silenceTimeoutMs`) — resets on every chunk;
 *     catches commands that hang without exiting
 *
 * Skipped vs Hermes/OpenClaw (kept the registry under ~250 lines):
 *   - PTY mode (needs node-pty native dep)
 *   - watch patterns + circuit breakers
 *   - on-disk checkpointing for crash recovery
 *   - bracketed paste / send-keys / hex stdin encoding
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;        // 5 min
const MAX_TIMEOUT_MS = 60 * 60 * 1000;           // 1 hour
const DEFAULT_SILENCE_MS = 2 * 60 * 1000;        // 2 min of no output
const MAX_AGGREGATE_CHARS = 200_000;
const AGGREGATE_TAIL_CHARS = 2_000;
const MAX_PENDING_CHARS = 30_000;
const MAX_PROCESSES = 64;
const FINISHED_TTL_MS = 30 * 60 * 1000;          // 30 min after exit

type ProcStatus = "running" | "exited" | "killed" | "timed_out";

interface ProcEntry {
  id: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  child: ChildProcess;
  status: ProcStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt: number | null;
  pending: string;
  aggregate: string;
  truncated: boolean;
  totalBytes: number;
  overallTimer: NodeJS.Timeout | null;
  silenceTimer: NodeJS.Timeout | null;
  silenceMs: number;
}

const procs = new Map<string, ProcEntry>();

function evictExpired(): void {
  const now = Date.now();
  for (const [id, e] of procs) {
    if (e.status === "running") continue;
    if (e.endedAt && now - e.endedAt > FINISHED_TTL_MS) procs.delete(id);
  }
  // Hard cap: if still over MAX_PROCESSES, drop oldest finished.
  if (procs.size <= MAX_PROCESSES) return;
  const finished = [...procs.values()]
    .filter((e) => e.status !== "running")
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  while (procs.size > MAX_PROCESSES && finished.length > 0) {
    const drop = finished.shift()!;
    procs.delete(drop.id);
  }
}

function appendOutput(e: ProcEntry, chunk: string): void {
  e.totalBytes += chunk.length;

  // Pending buffer: most recent chunk wins on overflow (the model wants
  // the latest tail to react to, not stale output from minutes ago).
  e.pending += chunk;
  if (e.pending.length > MAX_PENDING_CHARS) {
    e.pending = e.pending.slice(-MAX_PENDING_CHARS);
  }

  // Aggregate buffer: keep head + recent tail when over cap.
  e.aggregate += chunk;
  if (e.aggregate.length > MAX_AGGREGATE_CHARS) {
    const head = e.aggregate.slice(0, MAX_AGGREGATE_CHARS - AGGREGATE_TAIL_CHARS - 50);
    const tail = e.aggregate.slice(-AGGREGATE_TAIL_CHARS);
    e.aggregate = `${head}\n...[output truncated]...\n${tail}`;
    e.truncated = true;
  }

  // Reset silence timer on activity.
  if (e.silenceTimer) clearTimeout(e.silenceTimer);
  e.silenceTimer = setTimeout(() => {
    if (e.status === "running") killProc(e, "timed_out", "silence");
  }, e.silenceMs);
}

function killProc(e: ProcEntry, status: ProcStatus, _why: string): void {
  if (e.status !== "running") return;
  e.status = status;
  if (e.overallTimer) clearTimeout(e.overallTimer);
  if (e.silenceTimer) clearTimeout(e.silenceTimer);
  e.overallTimer = null;
  e.silenceTimer = null;
  try {
    // Kill the process group when possible — covers shells that spawned
    // children (e.g. `sh -c "long_running &"`).
    if (e.pid && process.platform !== "win32") {
      try { process.kill(-e.pid, "SIGTERM"); } catch { e.child.kill("SIGTERM"); }
    } else {
      e.child.kill("SIGTERM");
    }
  } catch { /* already dead */ }
  // Escalate to SIGKILL if the process doesn't exit promptly.
  setTimeout(() => {
    if (e.child.exitCode === null && e.child.signalCode === null) {
      try {
        if (e.pid && process.platform !== "win32") {
          try { process.kill(-e.pid, "SIGKILL"); } catch { e.child.kill("SIGKILL"); }
        } else {
          e.child.kill("SIGKILL");
        }
      } catch { /* already dead */ }
    }
  }, 2000);
}

function startProc(args: {
  command: string;
  cwd?: string;
  timeoutMs: number;
  silenceTimeoutMs: number;
}): ProcEntry {
  evictExpired();
  if (procs.size >= MAX_PROCESSES) {
    throw new Error(
      `process registry full (${MAX_PROCESSES} active); kill or wait for existing processes first`
    );
  }
  const id = `proc_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const baseCwd = getCurrentWorkspaceDir() ?? process.cwd();
  const effectiveCwd = args.cwd ?? baseCwd;
  const child = spawn(args.command, {
    cwd: effectiveCwd,
    shell: process.platform === "win32" ? true : "/bin/bash",
    detached: process.platform !== "win32", // for process-group kill
    stdio: ["pipe", "pipe", "pipe"],
  });

  const e: ProcEntry = {
    id,
    command: args.command,
    cwd: effectiveCwd,
    pid: child.pid,
    child,
    status: "running",
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    endedAt: null,
    pending: "",
    aggregate: "",
    truncated: false,
    totalBytes: 0,
    overallTimer: null,
    silenceTimer: null,
    silenceMs: args.silenceTimeoutMs,
  };
  procs.set(id, e);

  child.stdout?.on("data", (b: Buffer) => appendOutput(e, b.toString("utf-8")));
  child.stderr?.on("data", (b: Buffer) => appendOutput(e, b.toString("utf-8")));
  child.on("exit", (code, signal) => {
    if (e.overallTimer) clearTimeout(e.overallTimer);
    if (e.silenceTimer) clearTimeout(e.silenceTimer);
    e.overallTimer = null;
    e.silenceTimer = null;
    e.exitCode = code;
    e.signal = signal;
    e.endedAt = Date.now();
    if (e.status === "running") {
      e.status = signal ? "killed" : "exited";
    }
  });
  child.on("error", (err) => {
    appendOutput(e, `\n[spawn error: ${err.message}]\n`);
    e.endedAt = Date.now();
    if (e.status === "running") e.status = "killed";
  });

  e.overallTimer = setTimeout(() => killProc(e, "timed_out", "overall"), args.timeoutMs);
  e.silenceTimer = setTimeout(() => killProc(e, "timed_out", "silence"), args.silenceTimeoutMs);

  return e;
}

function summary(e: ProcEntry) {
  return {
    id: e.id,
    command: e.command,
    cwd: e.cwd,
    pid: e.pid,
    status: e.status,
    exitCode: e.exitCode,
    signal: e.signal,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    totalBytes: e.totalBytes,
    truncated: e.truncated,
  };
}

registry.register({
  name: "process",
  toolset: "terminal",
  runtime: "worker",
  description:
    "Manage long-running background processes. Actions: " +
    "`start` (spawn a command, returns id), " +
    "`list` (all active + recently-finished), " +
    "`status` (one process, no output), " +
    "`poll` (status + new output since last poll, then clears pending buffer), " +
    "`log` (full transcript), " +
    "`write` (send to stdin; `data` may end with \\n), " +
    "`kill` (SIGTERM then SIGKILL).",
  parameters: z.object({
    action: z.enum(["start", "list", "status", "poll", "log", "write", "kill"]),
    id: z.string().optional().describe("Process id (required for all actions except start/list)"),
    command: z.string().optional().describe("Shell command (required for start)"),
    cwd: z.string().optional().describe("Working directory (start only; defaults to agent cwd)"),
    data: z.string().optional().describe("Data to write to stdin (write only)"),
    timeoutMs: z
      .number()
      .min(1000)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(`Overall hard timeout in ms (start only; default ${DEFAULT_TIMEOUT_MS})`),
    silenceTimeoutMs: z
      .number()
      .min(1000)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `Kill if no output for this long, ms (start only; default ${DEFAULT_SILENCE_MS})`
      ),
  }),
  emoji: "⚙️",
  parallelSafe: false,
  maxResultSizeChars: MAX_AGGREGATE_CHARS + 1000,

  handler: async (args) => {
    const a = args as {
      action: string;
      id?: string;
      command?: string;
      cwd?: string;
      data?: string;
      timeoutMs?: number;
      silenceTimeoutMs?: number;
    };

    const need = (id: string | undefined): ProcEntry | string => {
      if (!id) return "id is required";
      const e = procs.get(id);
      if (!e) return `unknown process id: ${id}`;
      return e;
    };

    try {
      switch (a.action) {
        case "start": {
          if (!a.command) {
            return JSON.stringify({ error: "command is required for start" });
          }
          const e = startProc({
            command: a.command,
            cwd: a.cwd,
            timeoutMs: a.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            silenceTimeoutMs: a.silenceTimeoutMs ?? DEFAULT_SILENCE_MS,
          });
          return JSON.stringify({ success: true, ...summary(e) });
        }
        case "list": {
          evictExpired();
          return JSON.stringify({
            success: true,
            count: procs.size,
            processes: [...procs.values()].map(summary),
          });
        }
        case "status": {
          const r = need(a.id);
          if (typeof r === "string") return JSON.stringify({ error: r });
          return JSON.stringify({ success: true, ...summary(r) });
        }
        case "poll": {
          const r = need(a.id);
          if (typeof r === "string") return JSON.stringify({ error: r });
          const out = r.pending;
          r.pending = "";
          return JSON.stringify({ success: true, ...summary(r), output: out });
        }
        case "log": {
          const r = need(a.id);
          if (typeof r === "string") return JSON.stringify({ error: r });
          return JSON.stringify({ success: true, ...summary(r), output: r.aggregate });
        }
        case "write": {
          const r = need(a.id);
          if (typeof r === "string") return JSON.stringify({ error: r });
          if (r.status !== "running") {
            return JSON.stringify({ error: `process ${r.id} is ${r.status}; cannot write` });
          }
          if (a.data === undefined) {
            return JSON.stringify({ error: "data is required for write" });
          }
          if (!r.child.stdin || r.child.stdin.destroyed) {
            return JSON.stringify({ error: "stdin is closed" });
          }
          r.child.stdin.write(a.data);
          return JSON.stringify({ success: true, id: r.id, wrote: a.data.length });
        }
        case "kill": {
          const r = need(a.id);
          if (typeof r === "string") return JSON.stringify({ error: r });
          if (r.status !== "running") {
            return JSON.stringify({ success: true, ...summary(r), note: "already exited" });
          }
          killProc(r, "killed", "explicit");
          return JSON.stringify({ success: true, ...summary(r) });
        }
        default:
          return JSON.stringify({ error: `unknown action: ${a.action}` });
      }
    } catch (e) {
      return JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});

// Test / shutdown helpers.
export function _resetProcessRegistry(): void {
  for (const e of procs.values()) {
    if (e.status === "running") killProc(e, "killed", "reset");
  }
  procs.clear();
}
