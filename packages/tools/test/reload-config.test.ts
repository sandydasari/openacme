import { describe, it, expect, beforeEach } from "vitest";
import { registry } from "../src/registry.js";
import { bindReloadConfig } from "../src/builtins/reload-config.js";

describe("reload_config tool", () => {
  beforeEach(() => {
    // reset to unbound between tests
    bindReloadConfig(undefined as never);
  });

  it("errors clearly when AgentManager hasn't bound it", async () => {
    const tool = registry.get("reload_config");
    const out = JSON.parse(await tool.handler({}));
    expect(out.error).toMatch(/not initialized/);
  });

  it("is a daemon-runtime tool (must not dispatch to the sandbox worker)", () => {
    expect(registry.get("reload_config").runtime).toBe("daemon");
  });

  it("calls reloadAll and reports nothing-needs-restart", async () => {
    let called = 0;
    bindReloadConfig(async () => {
      called++;
      return { restartRequired: [] };
    });
    const out = JSON.parse(await registry.get("reload_config").handler({}));
    expect(called).toBe(1);
    expect(out.success).toBe(true);
    expect(out.restartRequired).toEqual([]);
    expect(out.note).toMatch(/no restart/i);
  });

  it("surfaces restartRequired (host/port) in the note", async () => {
    bindReloadConfig(async () => ({ restartRequired: ["server"] }));
    const out = JSON.parse(await registry.get("reload_config").handler({}));
    expect(out.restartRequired).toEqual(["server"]);
    expect(out.note).toMatch(/server/);
    expect(out.note).toMatch(/restart/i);
  });
});
