import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registry } from "../src/registry.js";
import { toolCallContext } from "../src/session-context.js";
import {
  bindProcessEvents,
  _resetProcessRegistry,
  type ProcessCompletionEvent,
} from "../src/builtins/process.js";

async function runProcess(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const tool = registry.get("process");
  if (!tool) throw new Error("process not registered");
  return JSON.parse(await tool.handler(args)) as Record<string, unknown>;
}

async function waitUntil(
  fn: () => boolean,
  timeoutMs = 3000
): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  bindProcessEvents(null);
  _resetProcessRegistry();
});

describe("process run", () => {
  it("waits for completion and returns merged stdout/stderr", async () => {
    const result = await runProcess({
      action: "run",
      command: "printf 'out\\n'; printf 'err\\n' >&2",
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  it("surfaces non-zero exits with the final transcript", async () => {
    const result = await runProcess({
      action: "run",
      command: "printf 'before fail\\n'; exit 7",
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Process exited with code 7");
    expect(result.exitCode).toBe(7);
    expect(result.output).toContain("before fail");
  });

  it("runs from the agent workspace by default", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openacme-process-run-"));
    try {
      const result = await toolCallContext.run(
        { sessionId: "s", agentId: "a", workspaceDir },
        () => runProcess({ action: "run", command: "pwd", timeoutMs: 5000 })
      );

      const output = String(result.output).trim();
      expect(result.success).toBe(true);
      expect(
        output === workspaceDir || output === path.join("/private", workspaceDir)
      ).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("exposes WORKSPACE_HOME and AGENT_HOME", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openacme-process-run-"));
    try {
      const result = await toolCallContext.run(
        { sessionId: "s", agentId: "a", workspaceDir },
        () =>
          runProcess({
            action: "run",
            command:
              'printf \'workspace=%s\\nagent=%s\\n\' "$WORKSPACE_HOME" "$AGENT_HOME"',
            timeoutMs: 5000,
          })
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain(`workspace=${workspaceDir}`);
      expect(result.output).toContain(`agent=${path.dirname(workspaceDir)}`);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("times out and returns captured output", async () => {
    const result = await runProcess({
      action: "run",
      command: "printf 'started\\n'; sleep 3",
      timeoutMs: 1000,
      silenceTimeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("timed_out");
    expect(result.error).toBe("Process timed out");
    expect(result.output).toContain("started");
  });

  it("detaches after waitMs and emits completion to the active session", async () => {
    const completions: ProcessCompletionEvent[] = [];
    bindProcessEvents({ emitCompletion: (event) => completions.push(event) });

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openacme-process-run-"));
    try {
      const result = await toolCallContext.run(
        { sessionId: "s", agentId: "a", workspaceDir },
        () =>
          runProcess({
            action: "run",
            command: "sleep 0.1; printf 'finished\\n'",
            waitMs: 0,
            timeoutMs: 5000,
          })
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe("running");
      expect(result.detached).toBe(true);
      expect(result.willNotify).toBe(true);

      await waitUntil(() => completions.length === 1);
      expect(completions[0]?.sessionId).toBe("s");
      expect(completions[0]?.agentId).toBe("a");
      expect(completions[0]?.result.success).toBe(true);
      expect(completions[0]?.result.status).toBe("exited");
      expect(completions[0]?.result.output).toContain("finished");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
