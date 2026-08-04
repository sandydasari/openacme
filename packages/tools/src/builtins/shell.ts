import { z } from 'zod';
import { execSync } from "node:child_process";
import { registry } from "../registry.js";
import {
  getCurrentWorkspaceDir,
  getCurrentAgentId,
  getCurrentSessionId,
} from "../session-context.js";
import { getShellSession } from "../internal/shell-session.js";
import { buildToolHomeEnv } from "../tool-env.js";
import { resolveShellForExec } from "../internal/shell-executable.js";

const DESTRUCTIVE_PATTERNS = /(?:^|\s|&&|\|\||;|`)(?:rm\s|rmdir\s|cp\s|mv\s|sed\s+-i|truncate\s|dd\s|shred\s|git\s+(?:reset|clean|checkout)\s)/;

/**
 * Shell tool — execute terminal commands.
 * Mirrors Hermes tools/terminal_tool.py with safety checks.
 */
registry.register({
  name: "shell",
  toolset: "terminal",
  runtime: "worker",
  description:
    "Execute a shell command and return its output. Use for running scripts, " +
    "installing packages, checking system state, and any terminal operations. " +
    "Runs from your agent's workspace dir by default. State persists across " +
    "calls in this session — `cd`, exported env vars, shell functions, and " +
    "history are preserved. Commands receive `WORKSPACE_HOME` and `AGENT_HOME` " +
    "environment variables for stable absolute path references.",
  parameters: z.object({
    command: z.string().describe("The shell command to execute"),
    timeout: z
      .number()
      .optional()
      .default(30000)
      .describe("Timeout in milliseconds (default: 30000)"),
  }),
  emoji: "🖥️",
  parallelSafe: false,
  maxResultSizeChars: 50_000,

  handler: async (args) => {
    const { command, timeout } = args as { command: string; timeout: number };

    if (!command.trim()) {
      return JSON.stringify({ error: "Empty command" });
    }

    // Flag destructive commands (user can still run them)
    const isDestructive = DESTRUCTIVE_PATTERNS.test(command);

    const workspaceDir = getCurrentWorkspaceDir();
    const agentId = getCurrentAgentId();
    const sessionId = getCurrentSessionId();
    const toolHomeEnv = buildToolHomeEnv(workspaceDir);

    // Persistent path: a real bash subprocess per (agentId, sessionId)
    // so `cd`, env vars, and shell functions survive across calls.
    if (workspaceDir && agentId && sessionId) {
      const session = getShellSession(agentId, sessionId, workspaceDir, toolHomeEnv);
      try {
        const res = await session.exec(command, timeout);
        const trimmed = res.output.trimEnd();
        const truncated =
          trimmed.length > 49_000
            ? trimmed.slice(0, 49_000) + "\n... [output truncated]"
            : trimmed;
        if (res.exitCode === 0 && !res.timedOut) {
          return JSON.stringify({
            success: true,
            output: truncated,
            cwd: res.cwd,
            command,
            ...(isDestructive && { warning: "This was a destructive command" }),
          });
        }
        return JSON.stringify({
          success: false,
          error: res.timedOut
            ? "Command timed out — shell session was reset"
            : `Command exited with code ${res.exitCode}`,
          exitCode: res.exitCode,
          stdout: truncated,
          cwd: res.cwd,
          command,
        });
      } catch (e) {
        return JSON.stringify({
          success: false,
          error: (e as Error).message,
          command,
        });
      }
    }

    // Fallback path (no session context — e.g. ad-hoc test callers).
    // Stateless, no persistence.
    const baseCwd = workspaceDir ?? process.cwd();
    try {
      const output = execSync(command, {
        timeout,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024 * 10, // 10MB
        shell: resolveShellForExec(),
        cwd: baseCwd,
        env: { ...process.env, ...toolHomeEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const result = {
        success: true,
        output: output.trim(),
        command,
        ...(isDestructive && { warning: "This was a destructive command" }),
      };

      // Truncate if too long
      const json = JSON.stringify(result);
      if (json.length > 50_000) {
        result.output =
          result.output.slice(0, 49_000) +
          "\n... [output truncated]";
        return JSON.stringify(result);
      }
      return json;
    } catch (error: unknown) {
      const err = error as {
        status?: number;
        stderr?: string;
        stdout?: string;
        message?: string;
      };
      return JSON.stringify({
        success: false,
        error: err.stderr?.trim() || err.message || "Command failed",
        exitCode: err.status ?? 1,
        stdout: err.stdout?.trim() || "",
        command,
      });
    }
  },
});
