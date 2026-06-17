// Layout-proof detection of which package manager owns the global
// @openacme/cli install. Mirrors OpenClaw's detect-package-manager.ts:
// trust install-layout proof (pnpm's .modules.yaml, bun's global path) over
// path-substring guesses, and return null when we genuinely can't tell so the
// caller falls back to advisory ("here's the command, run it yourself").

import { existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type PackageManager = "npm" | "pnpm" | "bun";

export interface InstallContext {
  pm: PackageManager;
  /** Absolute path to the installed @openacme/cli package dir. */
  packageRoot: string;
  /** Absolute path to the global node_modules that contains @openacme/cli. */
  globalNodeModules: string;
}

const PACKAGE = "@openacme/cli";

function resolveBunGlobalNodeModules(): string {
  return path.join(
    process.env["BUN_INSTALL"] || path.join(os.homedir(), ".bun"),
    "install",
    "global",
    "node_modules",
  );
}

/**
 * Resolve the on-disk package root from the running bin. Published layout is
 * `<globalNodeModules>/@openacme/cli/dist/index.js`, so the package root is two
 * levels up from the bin and the global node_modules two levels up from that
 * (scope dir + node_modules). Returns null for a source checkout (no
 * node_modules segment) — that path is owned by git, not a package manager.
 */
function resolveRoots(): { packageRoot: string; globalNodeModules: string } | null {
  const bin = process.argv[1];
  if (!bin) return null;
  let real: string;
  try {
    real = realpathSync(bin);
  } catch {
    return null;
  }
  if (!real.includes(`${path.sep}node_modules${path.sep}`)) return null;
  const packageRoot = path.resolve(real, "..", "..");
  // sanity: the resolved root is actually @openacme/cli
  if (path.basename(packageRoot) !== "cli" || path.basename(path.dirname(packageRoot)) !== "@openacme") {
    return null;
  }
  const globalNodeModules = path.resolve(packageRoot, "..", "..");
  return { packageRoot, globalNodeModules };
}

export function detectInstallContext(): InstallContext | null {
  const roots = resolveRoots();
  if (!roots) return null;
  const { packageRoot, globalNodeModules } = roots;

  // bun: the global node_modules is bun's well-known global dir.
  if (path.resolve(globalNodeModules) === path.resolve(resolveBunGlobalNodeModules())) {
    return { pm: "bun", packageRoot, globalNodeModules };
  }

  // pnpm: it writes a .modules.yaml marker into every node_modules it manages;
  // plain npm global installs do not.
  if (existsSync(path.join(globalNodeModules, ".modules.yaml"))) {
    return { pm: "pnpm", packageRoot, globalNodeModules };
  }

  // Default: a global node_modules with no pnpm/bun proof is npm-owned.
  return { pm: "npm", packageRoot, globalNodeModules };
}

/** The user-facing manual install command for a package manager (or unknown). */
export function installCommandFor(pm: PackageManager | null): string {
  switch (pm) {
    case "pnpm":
      return `pnpm add -g ${PACKAGE}@latest`;
    case "bun":
      return `bun add -g ${PACKAGE}@latest`;
    case "npm":
      return `npm install -g ${PACKAGE}@latest`;
    default:
      return `npm install -g ${PACKAGE}@latest`;
  }
}
