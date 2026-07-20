/**
 * Per-session persistent bash subprocess. Real shell state — `cd`, env
 * vars, shell functions, history — survives across `shell` tool calls
 * within the same agent session. One ShellSession per
 * `(agentId, sessionId)` pair, lazily spawned, killed at session
 * teardown / daemon shutdown.
 *
 * Sessions are unbounded (nothing closes a chat session), so the
 * registry self-limits: bash processes idle past IDLE_TTL_MS are killed
 * by a sweep timer, and an LRU cap bounds live processes per process
 * (one worker per agent under the tool-host, so effectively per agent).
 * The ShellSession object survives the kill — it remembers the last
 * cwd, so the next call respawns there; only in-shell env state is
 * lost. Tracked-but-dead entries are themselves pruned LRU past a cap.
 *
 * Protocol: each `exec()` writes the user command to a temp `.sh` file,
 * then writes `. <tmpfile>; printf "<SENTINEL>=$?=$(pwd)\n"` to bash's
 * stdin. Output is captured up to the unique sentinel line, which
 * encodes the exit code and post-command cwd. `source` (`.`) is the
 * key — running the script in the current shell preserves state.
 * Subshell (`bash <tmpfile>`) would NOT — env, cwd, vars die with the
 * subshell.
 *
 * On timeout the bash subprocess is SIGKILL'd; the next call respawns
 * a fresh shell at `initialCwd`. Session state is lost. Acceptable for
 * v1; document that timeouts reset the shell.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ShellExecResult {
  output: string;
  exitCode: number;
  cwd: string;
  timedOut: boolean;
}

interface Pending {
  resolve: (r: ShellExecResult) => void;
  uuid: string;
  buf: string;
  timer: NodeJS.Timeout | null;
}

const SENTINEL_PREFIX = "__OAC_END_";
// Regex captures `=<exit>=<cwd>__\n` after the prefix+uuid.
const sentinelRe = (uuid: string) =>
  new RegExp(`\\n${SENTINEL_PREFIX}${uuid}=(-?\\d+)=(.*?)__\\n`);

export class ShellSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending: Pending | null = null;
  private dead = false;
  // Last cwd reported by a completed command; respawns land here so an
  // idle-reaped shell resumes where the agent left off.
  private currentCwd: string;
  lastUsedAt = Date.now();

  constructor(public readonly initialCwd: string, private readonly baseEnv: NodeJS.ProcessEnv = {}) {
    this.currentCwd = initialCwd;
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  /** True while a bash subprocess is attached. */
  get live(): boolean {
    return this.proc !== null;
  }

  private spawnBash(): ChildProcessWithoutNullStreams {
    // --norc / --noprofile keep bash predictable across user environments
    // — no surprise aliases from a developer's ~/.bashrc bleeding in.
    const proc = spawn("/bin/bash", ["--norc", "--noprofile"], {
      cwd: fs.existsSync(this.currentCwd) ? this.currentCwd : this.initialCwd,
      env: { ...process.env, ...this.baseEnv, PS1: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.unref();

    // Merge stderr → stdout so output is one stream and the sentinel
    // detector sees everything in order.
    proc.stdin.write("exec 2>&1\n");

    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => this.onChunk(proc, chunk));
    // stderr is merged via `exec 2>&1`, but a hard error before that
    // line lands here. Append to the pending buffer if present.
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => {
      if (this.proc === proc && this.pending) this.pending.buf += chunk;
    });
    proc.on("exit", () => this.onExit(proc));
    proc.on("error", () => this.onExit(proc));

    return proc;
  }

  private onChunk(which: ChildProcessWithoutNullStreams, chunk: string): void {
    // Stale event from a killed previous bash — ignore.
    if (this.proc !== which) return;
    if (!this.pending) return;
    this.pending.buf += chunk;

    const m = this.pending.buf.match(sentinelRe(this.pending.uuid));
    if (!m) return;

    const exitCode = parseInt(m[1]!, 10);
    const cwd = m[2]!;
    if (cwd) this.currentCwd = cwd;
    const output = this.pending.buf.slice(0, m.index!);

    const pending = this.pending;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve({ output, exitCode, cwd, timedOut: false });
  }

  private onExit(which: ChildProcessWithoutNullStreams): void {
    // A timeout-fired kill or a previous-bash death races against the
    // newly-spawned bash. Only react to the exit of the proc we're
    // currently tracking.
    if (this.proc !== which) return;
    this.dead = true;
    this.proc = null;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({
        output: pending.buf,
        exitCode: -1,
        cwd: this.initialCwd,
        timedOut: false,
      });
    }
  }

  async exec(command: string, timeoutMs: number): Promise<ShellExecResult> {
    if (this.pending) {
      throw new Error(
        "Shell session is busy — concurrent shell calls are not supported per session."
      );
    }
    this.lastUsedAt = Date.now();

    if (!this.proc || this.dead) {
      this.dead = false;
      this.proc = this.spawnBash();
    }

    const uuid = randomUUID().replace(/-/g, "").slice(0, 16);
    // Multi-line / quote-heavy commands as a `.sh` source file dodge the
    // stdin-line-edge problems. `.` (source) preserves shell state.
    const tmpFile = path.join(os.tmpdir(), `openacme-shell-${uuid}.sh`);
    fs.writeFileSync(tmpFile, command, "utf-8");

    const wrapper =
      `. "${tmpFile}"; __oac_rc=$?; rm -f "${tmpFile}"; ` +
      `printf "\\n${SENTINEL_PREFIX}${uuid}=%d=%s__\\n" "$__oac_rc" "$(pwd)"\n`;

    return new Promise<ShellExecResult>((resolve) => {
      this.pending = {
        resolve,
        uuid,
        buf: "",
        timer: setTimeout(() => {
          const pending = this.pending;
          if (!pending) return;
          this.pending = null;
          // Kill bash entirely; next call respawns at initialCwd.
          try {
            if (this.proc?.pid) this.proc.kill("SIGKILL");
          } catch {
            // best-effort
          }
          try {
            fs.unlinkSync(tmpFile);
          } catch {
            // best-effort
          }
          this.dead = true;
          this.proc = null;
          pending.resolve({
            output: pending.buf + "\n[command timed out — shell session reset]",
            exitCode: -1,
            cwd: this.initialCwd,
            timedOut: true,
          });
        }, timeoutMs),
      };

      this.proc!.stdin.write(wrapper);
    });
  }

  close(): void {
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }
    if (this.pending && this.pending.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.dead = true;
    this.proc = null;
  }
}

// Per-(agentId, sessionId) registry, bounded by idle TTL + LRU caps.
const sessions = new Map<string, ShellSession>();

let IDLE_TTL_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
// Ceiling on concurrently-live bash subprocesses in this process.
let MAX_LIVE_SHELLS = 32;
// Ceiling on tracked (possibly dead) entries — each remembers a cwd.
const MAX_TRACKED_SESSIONS = 2048;

let sweepTimer: NodeJS.Timeout | null = null;

function sweep(now: number): void {
  let anyLive = false;
  for (const s of sessions.values()) {
    if (s.live && !s.busy && now - s.lastUsedAt > IDLE_TTL_MS) {
      // Kill the bash but keep the entry — it remembers the cwd and
      // respawns there on the session's next shell call.
      s.close();
    }
    if (s.live) anyLive = true;
  }
  if (!anyLive && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function ensureSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweep(Date.now()), SWEEP_INTERVAL_MS);
  // The sweeper must never hold the process open.
  sweepTimer.unref();
}

/** Kill the oldest non-busy live shells until under the cap. */
function suspendLiveOverCap(): void {
  const live = [...sessions.values()].filter((s) => s.live);
  if (live.length < MAX_LIVE_SHELLS) return;
  const idle = live
    .filter((s) => !s.busy)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  let excess = live.length - MAX_LIVE_SHELLS + 1;
  for (const s of idle) {
    if (excess <= 0) break;
    s.close();
    excess--;
  }
}

/** Forget the oldest dead entries when the tracked map itself is full. */
function pruneTrackedIfFull(): void {
  if (sessions.size < MAX_TRACKED_SESSIONS) return;
  const dead = [...sessions.entries()]
    .filter(([, s]) => !s.live && !s.busy)
    .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt);
  let excess = sessions.size - MAX_TRACKED_SESSIONS + 1;
  for (const [key] of dead) {
    if (excess <= 0) break;
    sessions.delete(key);
    excess--;
  }
}

export function getShellSession(
  agentId: string,
  sessionId: string,
  initialCwd: string,
  baseEnv: NodeJS.ProcessEnv = {}
): ShellSession {
  const key = `${agentId}:${sessionId}`;
  let s = sessions.get(key);
  if (!s) {
    pruneTrackedIfFull();
    s = new ShellSession(initialCwd, baseEnv);
    sessions.set(key, s);
  }
  // The caller is about to exec — make room under the live cap and make
  // sure the sweeper runs while anything is (about to be) live.
  suspendLiveOverCap();
  ensureSweeper();
  return s;
}

export function closeShellSession(agentId: string, sessionId: string): void {
  const key = `${agentId}:${sessionId}`;
  const s = sessions.get(key);
  if (!s) return;
  s.close();
  sessions.delete(key);
}

export function closeAllShellSessions(): void {
  for (const s of sessions.values()) s.close();
  sessions.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// Test seams.
export function sweepShellSessionsForTest(now = Date.now()): void {
  sweep(now);
}
export function setShellLimitsForTest(limits: {
  idleTtlMs?: number;
  maxLiveShells?: number;
}): { idleTtlMs: number; maxLiveShells: number } {
  const prev = { idleTtlMs: IDLE_TTL_MS, maxLiveShells: MAX_LIVE_SHELLS };
  if (limits.idleTtlMs !== undefined) IDLE_TTL_MS = limits.idleTtlMs;
  if (limits.maxLiveShells !== undefined) MAX_LIVE_SHELLS = limits.maxLiveShells;
  return prev;
}
