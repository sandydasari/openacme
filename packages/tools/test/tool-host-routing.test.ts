import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/registry.js";
import { toolCallContext, type ToolCallContext } from "../src/session-context.js";
import { bindToolHost } from "../src/tool-host-binding.js";

const CTX: ToolCallContext = {
  sessionId: "sess-1",
  agentId: "zoe",
  workspaceDir: "/data/agents/zoe/workspace",
};

function makeRegistry(runtime?: "daemon" | "worker") {
  const reg = new ToolRegistry();
  reg.register({
    name: "echo",
    toolset: "test",
    description: "echo",
    parameters: z.object({ msg: z.string() }),
    runtime,
    handler: async (args) =>
      JSON.stringify({ local: true, msg: (args as { msg: string }).msg }),
  });
  return reg;
}

type Execute = (
  args: Record<string, unknown>,
  opts?: { toolCallId?: string }
) => Promise<string>;

function executeOf(reg: ToolRegistry): Execute {
  const tools = reg.getVercelTools();
  return (tools["echo"] as { execute: Execute }).execute;
}

afterEach(() => {
  // Unbind so other test files never see a stale dispatcher.
  bindToolHost(null as never);
});

describe("worker-runtime routing", () => {
  it("routes worker-tagged tools through the bound dispatcher with the ALS context", async () => {
    const calls: Array<{ name: string; args: unknown; ctx: ToolCallContext }> = [];
    bindToolHost({
      dispatch: async (name, args, ctx) => {
        calls.push({ name, args, ctx });
        return JSON.stringify({ viaWorker: true });
      },
    });
    const execute = executeOf(makeRegistry("worker"));
    const result = await toolCallContext.run({ ...CTX }, () =>
      execute({ msg: "hi" }, { toolCallId: "call-7" })
    );
    expect(JSON.parse(result)).toEqual({ viaWorker: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("echo");
    expect(calls[0]!.args).toEqual({ msg: "hi" });
    expect(calls[0]!.ctx.sessionId).toBe("sess-1");
    expect(calls[0]!.ctx.agentId).toBe("zoe");
    expect(calls[0]!.ctx.workspaceDir).toBe(CTX.workspaceDir);
    expect(calls[0]!.ctx.toolCallId).toBe("call-7");
  });

  it("falls back to the local handler when no dispatcher is bound", async () => {
    const execute = executeOf(makeRegistry("worker"));
    const result = await toolCallContext.run({ ...CTX }, () =>
      execute({ msg: "hi" })
    );
    expect(JSON.parse(result)).toEqual({ local: true, msg: "hi" });
  });

  it("daemon (untagged) tools never touch the dispatcher", async () => {
    let dispatched = 0;
    bindToolHost({
      dispatch: async () => {
        dispatched++;
        return "{}";
      },
    });
    const execute = executeOf(makeRegistry());
    const result = await toolCallContext.run({ ...CTX }, () =>
      execute({ msg: "ok" })
    );
    expect(JSON.parse(result)).toEqual({ local: true, msg: "ok" });
    expect(dispatched).toBe(0);
  });

  it("runs locally when there is no ALS context even if a dispatcher is bound", async () => {
    bindToolHost({
      dispatch: async () => JSON.stringify({ viaWorker: true }),
    });
    const execute = executeOf(makeRegistry("worker"));
    const result = await execute({ msg: "bare" });
    expect(JSON.parse(result)).toEqual({ local: true, msg: "bare" });
  });
});
