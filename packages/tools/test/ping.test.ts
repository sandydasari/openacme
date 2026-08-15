import { describe, it, expect, beforeEach } from "vitest";
import { registry } from "../src/registry.js";
import { bindWithdrawPing } from "../src/builtins/ping.js";
import { toolCallContext } from "../src/session-context.js";

function runWithdraw(
  args: { reason: string },
  ctx?: { sessionId?: string; agentId?: string }
): Promise<string> {
  if (!ctx) return registry.get("withdraw_ping").handler(args);
  return toolCallContext.run(
    {
      sessionId: ctx.sessionId ?? "s1",
      agentId: ctx.agentId ?? "eng",
    } as never,
    () => registry.get("withdraw_ping").handler(args)
  );
}

describe("withdraw_ping tool", () => {
  beforeEach(() => {
    bindWithdrawPing(undefined as never);
  });

  it("is an all-agents system tool, not a platform tool", () => {
    expect(registry.get("withdraw_ping").toolset).toBe("system");
  });

  it("errors clearly when AgentManager hasn't bound it", async () => {
    const out = JSON.parse(
      await runWithdraw({ reason: "x" }, { sessionId: "s1", agentId: "eng" })
    );
    expect(out.error).toMatch(/not initialized/);
  });

  it("errors when there's no active session/agent context", async () => {
    bindWithdrawPing({ withdraw: () => ({ message: "q" }) });
    const out = JSON.parse(await runWithdraw({ reason: "x" }));
    expect(out.error).toMatch(/active session/);
  });

  it("passes the current session + agent to the binding and reports the cleared question", async () => {
    const calls: Array<{ sessionId: string; agentId: string; reason: string }> =
      [];
    bindWithdrawPing({
      withdraw: (sessionId, agentId, reason) => {
        calls.push({ sessionId, agentId, reason });
        return { message: "deploy now?" };
      },
    });
    const out = JSON.parse(
      await runWithdraw(
        { reason: "deploy window passed" },
        { sessionId: "s9", agentId: "eng" }
      )
    );
    expect(out.withdrawn).toBe(true);
    expect(out.closedQuestion).toBe("deploy now?");
    expect(calls[0]).toEqual({
      sessionId: "s9",
      agentId: "eng",
      reason: "deploy window passed",
    });
  });

  it("reports a no-op when the agent has no open ping on this session", async () => {
    bindWithdrawPing({ withdraw: () => null });
    const out = JSON.parse(
      await runWithdraw({ reason: "whatever" }, { sessionId: "s1", agentId: "eng" })
    );
    expect(out.withdrawn).toBe(false);
    expect(out.note).toMatch(/nothing to withdraw/i);
  });
});
