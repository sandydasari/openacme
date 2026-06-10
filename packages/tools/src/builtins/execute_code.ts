import { z } from 'zod';
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { registry } from "../registry.js";
import { getCurrentWorkspaceDir } from "../session-context.js";

/**
 * Persistent Python REPL tool. One sidecar process per agent process —
 * variables, imports, and function defs persist across calls. Communicates
 * over stdin/stdout via newline-delimited JSON; the protocol is defined in
 * `python_repl/sidecar.py`.
 *
 * Why not a fresh subprocess per call: the whole point of a REPL tool is
 * iterative work (load a CSV, then ask questions about it). Stateless
 * runs would just duplicate `shell` + `python3 -c`.
 *
 * Why not Jupyter / ipykernel: a 30-line sidecar covers the same
 * functional surface (stateful exec, last-expression value, stdout/stderr
 * capture) without ZMQ, kernel discovery, or `jupyter_client` as a hard
 * dep. We can swap to ipykernel later if rich-display becomes a
 * requirement.
 */

const SIDECAR_PATH = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Works in both dev (src/) and build (dist/) — the sidecar lives next to
  // this file in src/ and is copied during package build.
  const candidate = path.join(here, "python_repl", "sidecar.py");
  if (existsSync(candidate)) return candidate;
  // Build output sits one level up from the source layout in some setups.
  return path.join(here, "..", "..", "src", "builtins", "python_repl", "sidecar.py");
})();

const PYTHON_BIN =
  process.env["OPENACME_PYTHON"] ||
  process.env["PYTHON"] ||
  "python3";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

interface SidecarResponse {
  stdout: string;
  stderr: string;
  value: string;
  ok: boolean;
}

class PythonRepl {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  /** Single in-flight call; serialized to avoid interleaved JSON lines. */
  private pending: Promise<SidecarResponse> | null = null;

  private start(): void {
    if (this.proc && this.proc.exitCode === null) return;
    if (!existsSync(SIDECAR_PATH)) {
      throw new Error(`execute_code sidecar not found at ${SIDECAR_PATH}`);
    }
    // Spawn the sidecar in the agent's workspace dir so relative paths in
    // Python code (open("notes.txt"), pd.read_csv("data.csv")) land in the
    // same place as `write_file`. The agent can `os.chdir()` to navigate.
    const cwd = getCurrentWorkspaceDir() ?? process.cwd();
    const proc = spawn(PYTHON_BIN, ["-u", SIDECAR_PATH], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Don't pin the Node event loop on the sidecar — the host CLI must be
    // able to exit cleanly while a long-lived REPL exists. The stdio
    // streams are also socket-backed and pin the loop; their `unref` isn't
    // in the type defs but exists at runtime.
    proc.unref();
    const refable = (s: unknown): { unref?: () => void } | null =>
      s && typeof s === "object" && "unref" in s
        ? (s as { unref: () => void })
        : null;
    refable(proc.stdin)?.unref?.();
    refable(proc.stdout)?.unref?.();
    refable(proc.stderr)?.unref?.();
    proc.on("exit", () => {
      this.proc = null;
      this.buf = "";
    });
    // Drop stderr — the sidecar redirects user-code stderr into the JSON
    // response, so anything that lands here is interpreter-level (import
    // failures, etc.) and not relevant to the agent.
    proc.stderr.on("data", () => {});
    this.proc = proc;
  }

  async exec(code: string, timeoutMs: number): Promise<SidecarResponse> {
    // Serialize concurrent calls — the sidecar reads one JSON line at a time.
    while (this.pending) await this.pending;
    this.pending = this.execOne(code, timeoutMs);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private execOne(code: string, timeoutMs: number): Promise<SidecarResponse> {
    this.start();
    const proc = this.proc!;

    return new Promise<SidecarResponse>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.buf += chunk.toString("utf-8");
        const nl = this.buf.indexOf("\n");
        if (nl === -1) return;
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        cleanup();
        try {
          resolve(JSON.parse(line) as SidecarResponse);
        } catch (e) {
          reject(new Error(`sidecar returned invalid JSON: ${(e as Error).message}`));
        }
      };

      const onExit = (codeOrSignal: number | null) => {
        cleanup();
        reject(new Error(`python sidecar exited (code=${codeOrSignal ?? "?"}); state was reset`));
      };

      const timer = setTimeout(() => {
        cleanup();
        // Hard kill — the sidecar is mid-exec and not responding. Reset
        // our reference synchronously so the next call respawns; otherwise
        // `start()` short-circuits on `proc.exitCode === null` until the
        // async `exit` event fires, and we'd write to a dying stdin.
        proc.kill("SIGKILL");
        if (this.proc === proc) {
          this.proc = null;
          this.buf = "";
        }
        reject(new Error(`execute_code timed out after ${timeoutMs}ms (REPL state reset)`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout.off("data", onData);
        proc.off("exit", onExit);
      };

      proc.stdout.on("data", onData);
      proc.on("exit", onExit);

      proc.stdin.write(JSON.stringify({ code }) + "\n");
    });
  }

  reset(): void {
    if (this.proc) this.proc.kill("SIGKILL");
    this.proc = null;
    this.buf = "";
  }
}

const repl = new PythonRepl();

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS) + "\n...[truncated]";
}

registry.register({
  name: "execute_code",
  toolset: "code",
  runtime: "worker",
  description:
    "Execute Python code in a persistent REPL. Variables, imports, and " +
    "function definitions persist across calls within the same agent " +
    "process. The trailing expression's value is returned (Jupyter-style). " +
    "Use for data analysis, math, and any task where state across calls " +
    "matters; for one-shot commands prefer `shell python3 -c`.",
  parameters: z.object({
    code: z.string().min(1).describe("Python source to execute"),
    reset: z
      .boolean()
      .optional()
      .describe("If true, restart the REPL before running (clears all state)"),
    timeoutMs: z
      .number()
      .min(100)
      .max(300_000)
      .optional()
      .describe(`Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max 300000)`),
  }),
  emoji: "🐍",
  parallelSafe: false,
  maxResultSizeChars: MAX_OUTPUT_CHARS + 200,
  handler: async (args) => {
    const { code, reset, timeoutMs } = args as {
      code: string;
      reset?: boolean;
      timeoutMs?: number;
    };
    if (reset) repl.reset();
    try {
      const r = await repl.exec(code, timeoutMs ?? DEFAULT_TIMEOUT_MS);
      return JSON.stringify({
        success: r.ok,
        stdout: clip(r.stdout),
        stderr: clip(r.stderr),
        value: r.value,
      });
    } catch (e) {
      return JSON.stringify({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});

// Exported for tests and for the agent shutdown path.
export { repl as pythonRepl };
