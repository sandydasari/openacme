import { describe, it, expect, beforeEach } from "vitest";
import { registry } from "../src/registry.js";
import {
  bindPingAdmin,
  type UnresolvedPing,
} from "../src/builtins/ping-admin.js";

describe("ping_list / resolve_ping tools", () => {
  beforeEach(() => {
    bindPingAdmin(undefined as never);
  });

  it("both error clearly when AgentManager hasn't bound them", async () => {
    const list = JSON.parse(await registry.get("ping_list").handler({}));
    const resolve = JSON.parse(
      await registry.get("resolve_ping").handler({ sessionId: "s1", reason: "x" })
    );
    expect(list.error).toMatch(/not initialized/);
    expect(resolve.error).toMatch(/not initialized/);
  });

  it("both are platform tools (gated to Acme, not the all-agents set)", () => {
    expect(registry.get("ping_list").toolset).toBe("platform");
    expect(registry.get("resolve_ping").toolset).toBe("platform");
  });

  it("ping_list renders age labels and surfaces the waiting requests", async () => {
    const fixtures: UnresolvedPing[] = [
      {
        sessionId: "s1",
        agentId: "eng",
        agentName: "Engineer",
        sessionTitle: "Deploy v2",
        message: "deploy now?",
        ageSeconds: 7200,
      },
    ];
    bindPingAdmin({ list: () => fixtures, resolve: () => null });
    const out = JSON.parse(await registry.get("ping_list").handler({}));
    expect(out.count).toBe(1);
    expect(out.waiting[0].agent).toBe("Engineer");
    expect(out.waiting[0].age).toBe("2h");
    expect(out.waiting[0].message).toBe("deploy now?");
  });

  it("resolve_ping reports the cleared question on success", async () => {
    const calls: Array<{ sessionId: string; reason: string; by: string }> = [];
    bindPingAdmin({
      list: () => [],
      resolve: (sessionId, reason, resolvedBy) => {
        calls.push({ sessionId, reason, by: resolvedBy });
        return { agentId: "eng", message: "deploy now?" };
      },
    });
    const out = JSON.parse(
      await registry
        .get("resolve_ping")
        .handler({ sessionId: "s1", reason: "deploy window passed" })
    );
    expect(out.resolved).toBe(true);
    expect(out.agentId).toBe("eng");
    expect(out.closedQuestion).toBe("deploy now?");
    expect(calls[0]!.sessionId).toBe("s1");
    expect(calls[0]!.reason).toBe("deploy window passed");
  });

  it("resolve_ping reports a no-op when the session has no open ping", async () => {
    bindPingAdmin({ list: () => [], resolve: () => null });
    const out = JSON.parse(
      await registry
        .get("resolve_ping")
        .handler({ sessionId: "gone", reason: "whatever" })
    );
    expect(out.resolved).toBe(false);
    expect(out.note).toMatch(/no unresolved ping/i);
  });
});
