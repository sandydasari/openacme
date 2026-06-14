import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { execSync } from "node:child_process";

interface Dep {
  bin: string;
  pkg: string;
  /** What it powers — drives the accurate consequence message. */
  purpose: "sandbox" | "search";
  /** bubblewrap/socat back the Linux sandbox; macOS sandboxes natively. */
  linuxOnly?: boolean;
}

const DEPS: Dep[] = [
  { bin: "rg", pkg: "ripgrep", purpose: "search" },
  { bin: "bwrap", pkg: "bubblewrap", purpose: "sandbox", linuxOnly: true },
  { bin: "socat", pkg: "socat", purpose: "sandbox", linuxOnly: true },
];

function onPath(bin: string): boolean {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      // not here — keep looking
    }
  }
  return false;
}

/** Sandbox/system binaries that aren't on PATH. ripgrep powers search
 *  everywhere; bubblewrap + socat are the Linux sandbox and are skipped on
 *  other platforms. */
export function missingSandboxDeps(): Dep[] {
  const isLinux = process.platform === "linux";
  return DEPS.filter((d) => (!d.linuxOnly || isLinux) && !onPath(d.bin));
}

/** The package-manager install command for the detected platform, or null. */
function installCommand(pkgs: string[]): string | null {
  const joined = pkgs.join(" ");
  if (process.platform === "darwin") {
    return onPath("brew") ? `brew install ${joined}` : null;
  }
  if (onPath("apt-get")) return `sudo apt-get install -y ${joined}`;
  if (onPath("dnf")) return `sudo dnf install -y ${joined}`;
  if (onPath("pacman")) return `sudo pacman -S --noconfirm ${joined}`;
  if (onPath("zypper")) return `sudo zypper install -y ${joined}`;
  if (onPath("apk")) return `sudo apk add ${joined}`;
  return null;
}

function ask(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${question} [Y/n] `, (a) => {
      rl.close();
      resolve(!/^\s*n/i.test(a));
    });
  });
}

/**
 * If sandbox dependencies are missing, print a clear note and — when
 * interactive — offer to install them with the detected package manager.
 * Returns true if something was installed (the caller should (re)start so the
 * daemon picks them up).
 */
export async function offerSandboxDeps(opts: {
  interactive: boolean;
}): Promise<boolean> {
  const missing = missingSandboxDeps();
  if (missing.length === 0) return false;

  const bins = missing.map((d) => d.bin).join(", ");
  const cmd = installCommand(missing.map((d) => d.pkg));
  const purposes = new Set(missing.map((d) => d.purpose));
  const consequences: string[] = [];
  if (purposes.has("sandbox")) consequences.push("agent tools run unconfined");
  if (purposes.has("search")) consequences.push("file search falls back to a slower path");
  console.log("");
  console.log(`  ⚠ Missing dependencies (${bins}) — ${consequences.join("; ")}.`);
  if (!cmd) {
    console.log(
      "    Install bubblewrap, socat, and ripgrep with your package manager."
    );
    return false;
  }
  if (!opts.interactive) {
    console.log(`    Install with:  ${cmd}`);
    return false;
  }
  if (!(await ask(`    Install them now?  (${cmd})`))) {
    console.log(`    Skipped. Install later with:  ${cmd}`);
    return false;
  }
  try {
    execSync(cmd, { stdio: "inherit" });
    console.log("  ✓ sandbox dependencies installed");
    return true;
  } catch {
    console.log(`  ✗ install failed — run it yourself:  ${cmd}`);
    return false;
  }
}
