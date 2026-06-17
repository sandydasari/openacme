import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as clack from "@clack/prompts";
import { loadConfig } from "@openacme/config";
import { restartCommand } from "./restart.js";
import { fetchLatestVersion, isNewer } from "./update/registry.js";
import { detectInstallContext, installCommandFor } from "./update/detect-pm.js";
import { applyUpdate } from "./update/apply.js";

interface UpdateOpts {
  json?: boolean;
  /** Advisory only — never apply (the historical behavior). */
  check?: boolean;
  /** Apply without an interactive confirm. */
  yes?: boolean;
  /** Apply the install but skip the daemon restart. */
  noRestart?: boolean;
  /** Print what would happen without installing. */
  dryRun?: boolean;
  dataDir?: string;
}

function readCurrentVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/commands/update.js → ../../package.json
  const pkgPath = resolve(here, "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

/**
 * After the daemon restarts, confirm the live process reports the new version.
 * restartCommand already polled /api/health until it came up, so a single read
 * suffices; a stale version means a wrapper relaunched the old code.
 */
async function restartedVersion(dataDir: string | undefined): Promise<string | null> {
  try {
    const { server } = loadConfig(dataDir);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

export async function updateCommand(opts: UpdateOpts): Promise<void> {
  const current = readCurrentVersion();
  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) console.log(JSON.stringify({ error: msg, current }));
    else console.error(`Could not check for updates: ${msg}`);
    process.exit(1);
  }

  const ctx = detectInstallContext();
  const command = installCommandFor(ctx?.pm ?? null);

  if (!isNewer(latest, current)) {
    if (opts.json) console.log(JSON.stringify({ current, latest, upToDate: true, pm: ctx?.pm ?? null, command }));
    else console.log(`OpenAcme is up to date (v${current}).`);
    return;
  }

  // A newer version exists. Decide whether to apply.
  // - explicit --check, or a non-interactive shell without --yes → advisory.
  // - --yes → apply without prompting.
  // - interactive TTY → prompt, then apply.
  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;
  const advisory = opts.check === true || (!opts.yes && !interactive);

  if (opts.json && advisory) {
    console.log(JSON.stringify({ current, latest, upToDate: false, pm: ctx?.pm ?? null, command }));
    return;
  }

  if (advisory) {
    console.log("");
    console.log(`OpenAcme v${latest} is available (you have v${current}).`);
    console.log("");
    console.log("To update, run:");
    console.log(`  ${command}`);
    console.log("");
    console.log("Or apply it now:  openacme update --yes");
    return;
  }

  // Apply path. Needs a real global install we can hand to a package manager.
  if (!ctx) {
    const note = "openacme is running from a source checkout — self-update doesn't apply. Use `git pull` + `pnpm build`.";
    if (opts.json) console.log(JSON.stringify({ current, latest, applied: false, reason: "source-checkout" }));
    else console.log(note);
    return;
  }

  if (opts.dryRun) {
    console.log(`Would update v${current} → v${latest} via:  ${command}`);
    if (!opts.noRestart) console.log("Would then restart the daemon.");
    return;
  }

  if (interactive && !opts.yes) {
    const ok = await clack.confirm({ message: `Update OpenAcme v${current} → v${latest} now?` });
    if (clack.isCancel(ok) || !ok) {
      console.log(`Skipped. Run it later with:  ${command}`);
      return;
    }
  }

  console.log(`Updating OpenAcme v${current} → v${latest} ...`);
  const result = await applyUpdate(ctx, latest);
  if (!result.ok) {
    console.error(`✗ update did not complete (${result.reason}${result.detail ? `: ${result.detail}` : ""}).`);
    console.error(`  Run manually:  ${command}`);
    process.exit(1);
  }
  console.log(`✓ installed v${latest}.`);

  if (opts.noRestart) {
    console.log("Skipped daemon restart (--no-restart). Run `openacme restart` to apply.");
    return;
  }

  console.log("Restarting daemon ...");
  await restartCommand({ dataDir: opts.dataDir, noBrowser: true });

  const running = await restartedVersion(opts.dataDir);
  if (running === latest) {
    console.log(`✓ updated to v${latest} — daemon restarted.`);
  } else if (running) {
    console.log(`⚠ installed v${latest}, but the daemon reports v${running}. Run \`openacme restart\` if this persists.`);
  } else {
    console.log(`✓ installed v${latest}. Could not confirm the daemon version — check \`openacme status\`.`);
  }
}
