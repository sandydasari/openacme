import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiManager } from "../src/manager.js";
import type { PiRuntimeConfig } from "../src/types.js";

const FAKE_PI = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

// fake-pi.mjs is executable (shebang), so it stands in for the real `pi`
// binary — the manager invokes it as `fake-pi --mode rpc ...`, which the
// fake ignores (it reads commands from stdin regardless).
function baseConfig(over: Partial<PiRuntimeConfig> = {}): PiRuntimeConfig {
  return {
    enabled: true,
    executablePath: FAKE_PI,
    extraArgs: [],
    maxConcurrentPerAgent: 2,
    taskTimeoutMs: 60_000,
    ...over,
  };
}

function makeManager(
  config: PiRuntimeConfig,
  over: Record<string, { provider?: string; model?: string }> = {},
): PiManager {
  return new PiManager({
    resolveConfig: () => config,
    resolveOverrides: (agentId) => over[agentId],
    env: process.env,
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let managers: PiManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.close();
  managers = [];
});

describe("PiManager", () => {
  it("starts a delegation and reaches settled with a result", async () => {
    const m = makeManager(baseConfig());
    managers.push(m);
    const s = await m.start("agent-a", {
      prompt: "make hello.py",
      cwd: process.cwd(),
    });
    expect(s.status).toBe("running");
    expect(s.id).toMatch(/^pi_/);
    await waitFor(() => m.status("agent-a", s.id).status === "settled");
    const poll = m.poll("agent-a", s.id);
    expect(poll.progress).toContain("-> bash");
    expect(poll.status).toBe("settled");
    expect(poll.result).toContain("Done:");
  });

  it("isolates delegations by agent", async () => {
    const m = makeManager(baseConfig());
    managers.push(m);
    const s = await m.start("agent-a", { prompt: "x", cwd: process.cwd() });
    expect(() => m.status("agent-b", s.id)).toThrow(/unknown pi delegation/);
    expect(m.list("agent-b")).toHaveLength(0);
    expect(m.list("agent-a")).toHaveLength(1);
  });

  it("enforces per-agent concurrency cap", async () => {
    // Hanging fake keeps the first delegation running so the cap trips.
    const hangCfg = baseConfig({ maxConcurrentPerAgent: 1 });
    const hangM = new PiManager({
      resolveConfig: () => hangCfg,
      env: { ...process.env, FAKE_PI_HANG: "1" },
    });
    managers.push(hangM);
    await hangM.start("agent-a", { prompt: "one", cwd: process.cwd() });
    await expect(
      hangM.start("agent-a", { prompt: "two", cwd: process.cwd() }),
    ).rejects.toThrow(/running pi delegations/);
  });

  it("refuses to start when disabled", async () => {
    const m = makeManager(baseConfig({ enabled: false }));
    managers.push(m);
    await expect(
      m.start("agent-a", { prompt: "x", cwd: process.cwd() }),
    ).rejects.toThrow(/disabled/);
  });

  it("rejects a non-existent cwd", async () => {
    const m = makeManager(baseConfig());
    managers.push(m);
    await expect(
      m.start("agent-a", { prompt: "x", cwd: "/no/such/dir/openacme-pi" }),
    ).rejects.toThrow(/cwd does not exist/);
  });

  it("resolves provider/model with call > override > config precedence", async () => {
    const m = makeManager(
      baseConfig({ provider: "cfg-prov", model: "cfg-model" }),
      {
        "agent-a": { provider: "ovr-prov" },
      },
    );
    managers.push(m);
    const s = await m.start("agent-a", {
      prompt: "x",
      cwd: process.cwd(),
      model: "call-model",
    });
    expect(s.provider).toBe("ovr-prov"); // override beats config
    expect(s.model).toBe("call-model"); // call beats override + config
  });

  it("stop kills a running delegation", async () => {
    const hangCfg = baseConfig();
    const m = new PiManager({
      resolveConfig: () => hangCfg,
      env: { ...process.env, FAKE_PI_HANG: "1" },
    });
    managers.push(m);
    const s = await m.start("agent-a", { prompt: "x", cwd: process.cwd() });
    const stopped = m.stop("agent-a", s.id);
    expect(stopped.status).toBe("stopped");
  });

  it("closeAgent removes only that agent's delegations", async () => {
    const hangCfg = baseConfig();
    const m = new PiManager({
      resolveConfig: () => hangCfg,
      env: { ...process.env, FAKE_PI_HANG: "1" },
    });
    managers.push(m);
    const a = await m.start("agent-a", { prompt: "x", cwd: process.cwd() });
    const b = await m.start("agent-b", { prompt: "y", cwd: process.cwd() });
    await m.closeAgent("agent-a");
    expect(() => m.status("agent-a", a.id)).toThrow(/unknown/);
    expect(m.status("agent-b", b.id).id).toBe(b.id);
  });
});
