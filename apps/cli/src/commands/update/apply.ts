// Applies an update in place via the owning package manager, then verifies the
// on-disk version actually moved. The CLI's ~28 deps are flattened as siblings
// in the global node_modules, so we let npm/pnpm/bun resolve the full tree and
// only assert the result — a wrong/failed install never reports success.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { InstallContext } from "./detect-pm.js";
import { installCommandFor } from "./detect-pm.js";

export type ApplyResult =
  | { ok: true; installedVersion: string }
  | { ok: false; reason: "pm-not-found" | "install-failed" | "version-mismatch"; detail?: string };

function run(cmd: string, args: string[]): Promise<number | "enoent"> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", (err: NodeJS.ErrnoException) => resolve(err.code === "ENOENT" ? "enoent" : 1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function readInstalledVersion(packageRoot: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export async function applyUpdate(ctx: InstallContext, target: string): Promise<ApplyResult> {
  const [cmd, ...args] = installCommandFor(ctx.pm).split(" ");
  const code = await run(cmd!, args);
  if (code === "enoent") {
    return { ok: false, reason: "pm-not-found", detail: `${ctx.pm} not found on PATH` };
  }
  if (code !== 0) {
    return { ok: false, reason: "install-failed", detail: `${ctx.pm} exited ${code}` };
  }
  // The package manager rewrote the install in place; read it back from disk.
  const installed = readInstalledVersion(ctx.packageRoot);
  if (installed !== target) {
    return {
      ok: false,
      reason: "version-mismatch",
      detail: `on-disk version is ${installed ?? "unknown"}, expected ${target}`,
    };
  }
  return { ok: true, installedVersion: installed };
}
