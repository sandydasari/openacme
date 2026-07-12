import { describe, expect, it } from "vitest";
import { registry } from "../src/index.js";
import { toolCallContext } from "../src/session-context.js";

describe("pi tool", () => {
  it("registers under the pi toolset and is not a system tool", () => {
    const entry = registry.get("pi");
    expect(entry).toBeDefined();
    expect(entry?.toolset).toBe("pi");
    expect(entry?.parallelSafe).toBe(false);
    // Opt-in per agent, so it must not be forced on as a system tool.
    const def = registry.getDefinitions().find((d) => d.name === "pi") as
      | { system?: boolean }
      | undefined;
    expect(def?.system).toBeUndefined();
  });

  it("returns the not-bound error before AgentManager binds a manager", async () => {
    const entry = registry.get("pi")!;
    const out = await toolCallContext.run(
      { agentId: "a1", sessionId: "s1", workspaceDir: process.cwd() },
      () => entry.handler({ action: "list" }),
    );
    expect(JSON.parse(out)).toMatchObject({
      error: expect.stringContaining("bindPi"),
    });
  });
});
