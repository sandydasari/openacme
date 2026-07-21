import { describe, expect, it } from "vitest";
import {
  resolveShell,
  resolveShellForExec,
  resolveShellForSpawn,
} from "../src/internal/shell-executable.js";

function exists(paths: string[]) {
  const set = new Set(paths);
  return (candidate: string) => set.has(candidate);
}

describe("shell executable resolution", () => {
  it("prefers a valid BASH env path", () => {
    const shell = resolveShell(
      { BASH: "/opt/homebrew/bin/bash", PATH: "/bin" },
      exists(["/opt/homebrew/bin/bash", "/bin/bash", "/bin/sh"])
    );
    expect(shell).toEqual({
      command: "/opt/homebrew/bin/bash",
      args: ["--norc", "--noprofile"],
      kind: "bash",
    });
  });

  it("ignores a missing /bin/bash and falls back to bash on PATH", () => {
    const shell = resolveShell(
      { PATH: "/nix/store/bin:/bin" },
      exists(["/nix/store/bin/bash", "/bin/sh"])
    );
    expect(shell.command).toBe("/nix/store/bin/bash");
    expect(shell.kind).toBe("bash");
  });

  it("falls back to sh when bash is unavailable", () => {
    const shell = resolveShell(
      { BASH: "/bin/bash", PATH: "/usr/bin" },
      exists(["/bin/sh"])
    );
    expect(shell).toEqual({ command: "/bin/sh", args: [], kind: "sh" });
    expect(resolveShellForSpawn({ PATH: "/usr/bin" }, exists(["/bin/sh"]))).toBe(
      "/bin/sh"
    );
    expect(resolveShellForExec({ PATH: "/usr/bin" }, exists(["/bin/sh"]))).toBe(
      "/bin/sh"
    );
  });
});
