import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcClient } from "../src/rpc-client.js";
import { PiNotInstalledError, type PiEvent } from "../src/types.js";

const FAKE_PI = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

function makeClient(env: NodeJS.ProcessEnv = {}): PiRpcClient {
  return new PiRpcClient({
    command: process.execPath,
    args: [FAKE_PI],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let clients: PiRpcClient[] = [];
afterEach(() => {
  for (const c of clients) c.kill();
  clients = [];
});

describe("PiRpcClient", () => {
  it("rejects spawn with PiNotInstalledError on ENOENT", async () => {
    const c = new PiRpcClient({
      command: "definitely-not-a-real-binary-openacme-pi",
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
    });
    await expect(c.spawn()).rejects.toBeInstanceOf(PiNotInstalledError);
  });

  it("correlates command responses by id and streams events", async () => {
    const c = makeClient();
    clients.push(c);
    const events: PiEvent[] = [];
    c.onEvent((ev) => events.push(ev));
    await c.spawn();

    const res = await c.send({ type: "prompt", message: "do the thing" });
    expect(res.type).toBe("response");

    await waitFor(() => events.some((e) => e.type === "agent_settled"));
    const types = events.map((e) => e.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("turn_end");
    expect(types).not.toContain("response");
  });

  it("reassembles lines split across stdout chunks", async () => {
    const c = makeClient({ FAKE_PI_SPLIT: "1" });
    clients.push(c);
    const events: PiEvent[] = [];
    c.onEvent((ev) => events.push(ev));
    await c.spawn();
    c.sendNoWait({ type: "prompt", message: "split me" });
    await waitFor(() => events.some((e) => e.type === "agent_settled"));
    expect(
      c.diagnostics.filter((l) => l.startsWith("[unparseable]")),
    ).toHaveLength(0);
  });

  it("rejects a command pi answers with success:false", async () => {
    const c = makeClient();
    clients.push(c);
    await c.spawn();
    await expect(c.send({ type: "bad_command" })).rejects.toThrow(
      /nope|rejected/,
    );
  });

  it("reports not-running after the process is killed", async () => {
    const c = makeClient();
    clients.push(c);
    await c.spawn();
    expect(c.isRunning).toBe(true);
    c.kill();
    await waitFor(() => !c.isRunning);
    await expect(
      c.send({ type: "prompt", message: "too late" }),
    ).rejects.toThrow(/not running/);
  });
});
