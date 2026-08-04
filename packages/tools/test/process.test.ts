import { afterEach, describe, expect, it } from "vitest";
import { registry } from "../src/registry.js";
import { _resetProcessRegistry } from "../src/builtins/process.js";
import "../src/builtins/process.js";

afterEach(() => {
  _resetProcessRegistry();
});

async function runProcessTool<R = Record<string, unknown>>(
  args: Record<string, unknown>
): Promise<R> {
  const tool = registry.get("process");
  if (!tool) throw new Error("process tool not registered");
  return JSON.parse(await tool.handler(args)) as R;
}

async function pollUntilExited(id: string): Promise<{ output: string; status: string }> {
  let output = "";
  let status = "running";
  for (let i = 0; i < 20; i++) {
    const result = await runProcessTool<{ output: string; status: string }>({
      action: "poll",
      id,
    });
    output += result.output ?? "";
    status = result.status;
    if (status !== "running") return { output, status };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { output, status };
}

describe("process tool", () => {
  it("starts commands through the resolved shell", async () => {
    const started = await runProcessTool<{ success: boolean; id: string; status: string }>({
      action: "start",
      command: "printf process-ok",
      timeoutMs: 5000,
      silenceTimeoutMs: 5000,
    });
    expect(started.success).toBe(true);
    expect(started.status).toBe("running");

    const result = await pollUntilExited(started.id);
    expect(result.status).toBe("exited");
    expect(result.output).toContain("process-ok");
  });
});
