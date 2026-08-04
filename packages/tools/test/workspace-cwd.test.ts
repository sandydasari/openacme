import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { registry } from "../src/registry.js";
import { toolCallContext } from "../src/session-context.js";
import { closeAllShellSessions } from "../src/internal/shell-session.js";
import { _resetProcessRegistry } from "../src/builtins/process.js";
// Side-effect imports — each tool self-registers at module load.
import "../src/builtins/shell.js";
import "../src/builtins/file.js";
import "../src/builtins/edit.js";
import "../src/builtins/apply-patch.js";

afterEach(() => {
  // Reap any per-(agent, session) bash subprocesses spawned during the test.
  closeAllShellSessions();
  _resetProcessRegistry();
});

// `<dataDir>/agents/<id>/workspace/` is the default cwd for the agent's
// filesystem and shell tools. These tests pin that contract: each tool
// honors `workspaceDir` from the ALS context for relative paths, and
// falls back to `process.cwd()` when no context is set.

let workspaceDir: string;
let otherDir: string;

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openacme-ws-"));
  otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "openacme-other-"));
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
  await fs.rm(otherDir, { recursive: true, force: true });
});

function withWorkspace<T>(ws: string, fn: () => Promise<T>): Promise<T> {
  return toolCallContext.run(
    { sessionId: "s", agentId: "a", workspaceDir: ws },
    fn
  );
}

async function runTool<R = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>
): Promise<R> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`${name} not registered`);
  const out = await tool.handler(args);
  return JSON.parse(out) as R;
}

describe("shell — persistent session: `cd` survives across calls", () => {
  it("cd in one call carries into the next within the same session context", async () => {
    await fs.mkdir(path.join(workspaceDir, "nested"));
    const ctx = { sessionId: "sess-persist", agentId: "agent-persist", workspaceDir };
    const cd = await toolCallContext.run(ctx, () =>
      runTool<{ success: boolean }>("shell", { command: "cd nested", timeout: 5000 })
    );
    expect(cd.success).toBe(true);
    const pwd = await toolCallContext.run(ctx, () =>
      runTool<{ success: boolean; output: string; cwd: string }>("shell", {
        command: "pwd",
        timeout: 5000,
      })
    );
    expect(pwd.success).toBe(true);
    expect(pwd.cwd.endsWith("/nested")).toBe(true);
  });

  it("env vars exported in one call are visible in the next", async () => {
    const ctx = { sessionId: "sess-env", agentId: "agent-env", workspaceDir };
    await toolCallContext.run(ctx, () =>
      runTool("shell", { command: "export OAC_ENVTEST=xyz", timeout: 5000 })
    );
    const r = await toolCallContext.run(ctx, () =>
      runTool<{ output: string }>("shell", { command: "echo $OAC_ENVTEST", timeout: 5000 })
    );
    expect(r.output.trim()).toBe("xyz");
  });

  it("different sessions get independent shell state", async () => {
    const ctxA = { sessionId: "sess-A", agentId: "agent-X", workspaceDir };
    const ctxB = { sessionId: "sess-B", agentId: "agent-X", workspaceDir };
    await toolCallContext.run(ctxA, () =>
      runTool("shell", { command: "export ISLAND=alpha", timeout: 5000 })
    );
    const r = await toolCallContext.run(ctxB, () =>
      runTool<{ output: string }>("shell", { command: "echo \"${ISLAND:-empty}\"", timeout: 5000 })
    );
    expect(r.output.trim()).toBe("empty");
  });
});

describe("shell — cwd defaults to workspace", () => {
  it("pwd returns the agent's workspaceDir when an agent context is active", async () => {
    const res = await withWorkspace(workspaceDir, () =>
      runTool<{ success: boolean; output: string }>("shell", {
        command: "pwd",
        timeout: 5000,
      })
    );
    expect(res.success).toBe(true);
    // macOS resolves /var/folders symlinks to /private/var/folders.
    expect(res.output).toMatch(
      new RegExp(`(^|/private)${workspaceDir.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}$`)
    );
  });

  it("falls back to process.cwd() when no context is set", async () => {
    const res = await runTool<{ success: boolean; output: string }>("shell", {
      command: "pwd",
      timeout: 5000,
    });
    expect(res.success).toBe(true);
    // Either the process cwd, or its /private/ macOS-resolved form.
    const cwd = process.cwd();
    expect(
      res.output === cwd || res.output === path.join("/private", cwd)
    ).toBe(true);
  });

  it("exposes WORKSPACE_HOME and AGENT_HOME in persistent shell sessions", async () => {
    const ctx = {
      sessionId: "sess-home-env",
      agentId: "agent-home-env",
      workspaceDir,
    };
    const res = await toolCallContext.run(ctx, () =>
      runTool<{ success: boolean; output: string }>("shell", {
        command:
          'printf \'workspace=%s\\nagent=%s\\n\' "$WORKSPACE_HOME" "$AGENT_HOME"',
        timeout: 5000,
      }),
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain(`workspace=${workspaceDir}`);
    expect(res.output).toContain(`agent=${path.dirname(workspaceDir)}`);
  });

  it("exposes WORKSPACE_HOME and AGENT_HOME in non-persistent shell executions", async () => {
    const res = await toolCallContext.run(
      { sessionId: "", agentId: "", workspaceDir },
      () =>
        runTool<{ success: boolean; output: string }>("shell", {
          command:
            'printf \'workspace=%s\\nagent=%s\\n\' "$WORKSPACE_HOME" "$AGENT_HOME"',
          timeout: 5000,
        }),
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain(`workspace=${workspaceDir}`);
    expect(res.output).toContain(`agent=${path.dirname(workspaceDir)}`);
  });
});

describe("process — home environment", () => {
  it("exposes WORKSPACE_HOME and AGENT_HOME to started processes", async () => {
    const started = await withWorkspace(workspaceDir, () =>
      runTool<{ success: boolean; id: string }>("process", {
        action: "start",
        command:
          'printf \'workspace=%s\\nagent=%s\\n\' "$WORKSPACE_HOME" "$AGENT_HOME"',
        timeoutMs: 5000,
        silenceTimeoutMs: 5000,
      }),
    );
    expect(started.success).toBe(true);

    let output = "";
    let status = "running";
    for (let i = 0; i < 20 && status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const polled = await withWorkspace(workspaceDir, () =>
        runTool<{ success: boolean; status: string; output: string }>(
          "process",
          {
            action: "poll",
            id: started.id,
          },
        ),
      );
      expect(polled.success).toBe(true);
      output += polled.output;
      status = polled.status;
    }

    expect(status).not.toBe("running");
    expect(output).toContain(`workspace=${workspaceDir}`);
    expect(output).toContain(`agent=${path.dirname(workspaceDir)}`);
  });
});

describe("write_file + read_file — relative paths resolve to workspaceDir", () => {
  it("writes a relative path under workspaceDir, not process.cwd()", async () => {
    const result = await withWorkspace(workspaceDir, () =>
      runTool<{ success: boolean; path: string }>("write_file", {
        path: "notes.md",
        content: "hello",
      })
    );
    expect(result.success).toBe(true);
    expect(result.path).toBe(path.join(workspaceDir, "notes.md"));
    const onDisk = await fs.readFile(path.join(workspaceDir, "notes.md"), "utf-8");
    expect(onDisk).toBe("hello");
  });

  it("reads a relative path from workspaceDir", async () => {
    await fs.writeFile(path.join(workspaceDir, "x.txt"), "from-workspace");
    const result = await withWorkspace(workspaceDir, () =>
      runTool<{ success: boolean; content: string }>("read_file", {
        path: "x.txt",
      })
    );
    expect(result.success).toBe(true);
    expect(result.content).toBe("from-workspace");
  });

  it("absolute paths bypass workspaceDir resolution", async () => {
    const abs = path.join(otherDir, "abs.txt");
    await fs.writeFile(abs, "elsewhere");
    const result = await withWorkspace(workspaceDir, () =>
      runTool<{ success: boolean; content: string }>("read_file", {
        path: abs,
      })
    );
    expect(result.success).toBe(true);
    expect(result.content).toBe("elsewhere");
  });
});

describe("list_files — default `.` resolves to workspaceDir", () => {
  it("lists workspaceDir when path is omitted and a context is active", async () => {
    await fs.writeFile(path.join(workspaceDir, "a.txt"), "a");
    await fs.writeFile(path.join(workspaceDir, "b.txt"), "b");
    const result = await withWorkspace(workspaceDir, () =>
      runTool<{ success: boolean; path: string; entries: { name: string }[] }>(
        "list_files",
        { path: ".", recursive: false, maxDepth: 1 }
      )
    );
    expect(result.success).toBe(true);
    expect(result.path).toBe(workspaceDir);
    const names = result.entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "b.txt"]);
  });
});

describe("edit — relative path resolves to workspaceDir", () => {
  it("edits a file in workspaceDir via relative path", async () => {
    await fs.writeFile(path.join(workspaceDir, "doc.md"), "hello world");
    const result = await withWorkspace(workspaceDir, () =>
      runTool<{ success: boolean }>("edit", {
        path: "doc.md",
        oldString: "world",
        newString: "everyone",
        replaceAll: false,
      })
    );
    expect(result.success).toBe(true);
    const after = await fs.readFile(path.join(workspaceDir, "doc.md"), "utf-8");
    expect(after).toBe("hello everyone");
  });
});

describe("apply_patch — defaults to workspaceDir; explicit cwd still wins", () => {
  const patch = (filePath: string) =>
    [
      "*** Begin Patch",
      `*** Add File: ${filePath}`,
      "+line one",
      "+line two",
      "*** End Patch",
    ].join("\n");

  it("creates the file under workspaceDir when no explicit cwd is given", async () => {
    const result = await withWorkspace(workspaceDir, () =>
      runTool<{ success: boolean }>("apply_patch", {
        patchText: patch("new.md"),
      })
    );
    expect(result.success).toBe(true);
    const content = await fs.readFile(path.join(workspaceDir, "new.md"), "utf-8");
    expect(content).toContain("line one");
    expect(content).toContain("line two");
  });

  it("honors an explicit cwd arg over the workspace context", async () => {
    const result = await withWorkspace(workspaceDir, () =>
      runTool<{ success: boolean }>("apply_patch", {
        patchText: patch("forced.md"),
        cwd: otherDir,
      })
    );
    expect(result.success).toBe(true);
    const content = await fs.readFile(path.join(otherDir, "forced.md"), "utf-8");
    expect(content).toContain("line one");
    // Should NOT have landed in workspaceDir.
    await expect(
      fs.access(path.join(workspaceDir, "forced.md"))
    ).rejects.toThrow();
  });
});
