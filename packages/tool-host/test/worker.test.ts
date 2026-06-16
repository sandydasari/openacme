import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolHostManager } from "../src/manager.js";
import type { ToolCallContext } from "@openacme/tools";
import type { PathPolicy } from "@openacme/config";

function policyFor(dir: string) {
  // Mirrors compilePolicy's posture: writes open by default ("/"), a
  // protected deny-write subtree, and a deny-read subtree.
  return (agentId: string): PathPolicy => ({
    agentId,
    readWrite: ["/"],
    denyWrite: [path.join(dir, "protected")],
    denyRead: [path.join(dir, "secrets")],
    readAllow: [],
    notes: {
      workspaceDir: path.join(dir, "agents", agentId, "workspace"),
      teamWorkspaces: [],
      extraGrants: [],
    },
  });
}

describe("tool-host worker round-trips (real child process)", () => {
  let dir: string;
  let manager: ToolHostManager;
  let ctx: ToolCallContext;

  beforeEach(() => {
    // realpath: sandbox rules match real paths, and macOS tmp lives
    // behind /var → /private/var.
    dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openacme-tool-host-"))
    );
    const workspaceDir = path.join(dir, "agents", "zoe", "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    // Exist before any worker spawns so the deny rules are compiled
    // against resolvable paths.
    fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "secrets", "token.txt"), "topsecret");
    fs.mkdirSync(path.join(dir, "protected"), { recursive: true });
    fs.writeFileSync(path.join(dir, "protected", "system.txt"), "do not touch");
    manager = new ToolHostManager({
      dataDir: dir,
      compilePolicyFor: policyFor(dir),
    });
    ctx = { sessionId: "sess-1", agentId: "zoe", workspaceDir };
  });

  afterEach(async () => {
    await manager.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("executes write_file + read_file in the worker", async () => {
    const write = JSON.parse(
      await manager.dispatch(
        "write_file",
        { path: "hello.txt", content: "from the worker" },
        ctx
      )
    );
    expect(write.success).toBe(true);
    expect(fs.readFileSync(path.join(ctx.workspaceDir, "hello.txt"), "utf-8")).toBe(
      "from the worker"
    );

    const read = JSON.parse(
      await manager.dispatch("read_file", { path: "hello.txt" }, ctx)
    );
    expect(read.success).toBe(true);
    expect(read.content).toBe("from the worker");
  });

  it("keeps shell state (cd) across calls in the same session", async () => {
    const target = path.join(dir, "elsewhere");
    fs.mkdirSync(target, { recursive: true });
    const first = JSON.parse(
      await manager.dispatch("shell", { command: `cd ${target}` }, ctx)
    );
    expect(first.success).toBe(true);
    const second = JSON.parse(
      await manager.dispatch("shell", { command: "pwd" }, ctx)
    );
    expect(second.success).toBe(true);
    expect(fs.realpathSync(second.output)).toBe(fs.realpathSync(target));
  });

  it("session_closed resets that session's shell, others untouched", async () => {
    const target = path.join(dir, "elsewhere2");
    fs.mkdirSync(target, { recursive: true });
    await manager.dispatch("shell", { command: `cd ${target}` }, ctx);
    manager.notifySessionClosed("zoe", "sess-1");
    // Fresh shell starts back in the workspace.
    const after = JSON.parse(
      await manager.dispatch("shell", { command: "pwd" }, ctx)
    );
    expect(fs.realpathSync(after.output)).toBe(fs.realpathSync(ctx.workspaceDir));
  });

  it("returns unknown-tool error JSON instead of throwing", async () => {
    const res = JSON.parse(
      await manager.dispatch("definitely_not_a_tool", {}, ctx)
    );
    expect(res.error).toMatch(/Unknown tool/);
  });

  it("respawns after stopWorker; in-flight state resets", async () => {
    await manager.dispatch("shell", { command: "export MARKER=1" }, ctx);
    await manager.stopWorker("zoe");
    // A dispatch immediately after a respawn can transiently return the
    // worker's "exited — retry the call" error (the documented contract), so
    // retry until the fresh worker answers. The MARKER assertion still proves
    // the state actually reset — a real leak would survive the retries.
    let res: { success?: boolean; output?: string } = {};
    for (let i = 0; i < 5; i++) {
      res = JSON.parse(
        await manager.dispatch("shell", { command: "echo val=$MARKER" }, ctx)
      );
      if (res.success) break;
    }
    expect(res.success).toBe(true);
    expect(res.output).toBe("val=");
  });

  it.skipIf(
    new ToolHostManager({ dataDir: os.tmpdir(), compilePolicyFor: policyFor(os.tmpdir()) })
      .degradeReason !== null
  )("kernel: writes open by default, denyWrite + denyRead enforced", async () => {
    // Open-by-default posture: a write OUTSIDE any grant list succeeds
    // (the machine is fair game; only protected paths are denied).
    const anywhere = path.join(dir, "fair-game", "note.txt");
    const open = JSON.parse(
      await manager.dispatch(
        "write_file",
        { path: anywhere, content: "ok" },
        ctx
      )
    );
    expect(open.success).toBe(true);

    // Write into the protected subtree — must fail.
    const protectedFile = path.join(dir, "protected", "system.txt");
    const write = JSON.parse(
      await manager.dispatch(
        "write_file",
        { path: protectedFile, content: "overwritten" },
        ctx
      )
    );
    expect(write.success).toBeUndefined();
    expect(write.error).toMatch(/EPERM|not permitted|denied/i);
    expect(fs.readFileSync(protectedFile, "utf-8")).toBe("do not touch");

    // Read of a deny-read path — must fail even though reads are
    // open-by-default elsewhere.
    const secret = path.join(dir, "secrets", "token.txt");
    const read = JSON.parse(
      await manager.dispatch("read_file", { path: secret }, ctx)
    );
    expect(read.content).toBeUndefined();
    expect(read.error).toBeTruthy();

    // Shell obeys the same policy — it's the same kernel boundary.
    const shellWrite = JSON.parse(
      await manager.dispatch(
        "shell",
        { command: `echo x > ${protectedFile} && echo WROTE` },
        ctx
      )
    );
    expect(shellWrite.success).toBe(false);
    expect(fs.readFileSync(protectedFile, "utf-8")).toBe("do not touch");
  });

  it("parallel dispatches multiplex on one worker", async () => {
    const [a, b, c] = await Promise.all([
      manager.dispatch("shell", { command: "echo A" }, ctx),
      manager.dispatch("read_file", { path: "does-not-exist.txt" }, ctx),
      manager.dispatch("shell", { command: "echo C" }, { ...ctx, sessionId: "sess-2" }),
    ]);
    expect(JSON.parse(a).output).toBe("A");
    expect(JSON.parse(b).error).toBeTruthy();
    expect(JSON.parse(c).output).toBe("C");
  });
});
