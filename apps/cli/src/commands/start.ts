import { spawn } from "node:child_process";
import * as fs from "node:fs";
import {
  loadConfig,
  resolveDataDir,
  readRawConfig,
  writeRawConfig,
  isLoopbackBindHost,
  resolveDeploymentMode,
  reachableBaseUrl,
} from "@openacme/config";
import { createDatabase, createAuthStore } from "@openacme/db";
import {
  getPlatformLifecycle,
  logPath,
  pidPath,
  pollHealth,
  resolveBinaryPath,
  resolveNodePath,
  writeAtomic0600,
  clearPid,
} from "../lifecycle/index.js";

interface StartOpts {
  dataDir?: string;
  noBrowser?: boolean;
  noService?: boolean;
  expose?: boolean;
  local?: boolean;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open";
  const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
  // Headless servers have no xdg-open; a failed spawn must not crash the
  // command — opening the browser is best-effort convenience only.
  child.on("error", () => {});
  child.unref();
}

function userFacingUrl(host: string, port: number): string {
  const display = isLoopbackBindHost(host) ? "localhost" : host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return `http://${display}:${port}`;
}

export async function startCommand(opts: StartOpts): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

  if (opts.expose && opts.local) {
    console.error("✗ --expose and --local are mutually exclusive");
    process.exit(1);
  }

  // --expose binds 0.0.0.0 and requires login — one flag covers every remote
  // path (a tunnel/reverse proxy forwards to localhost, which 0.0.0.0 also
  // serves, plus direct network/IP access). A non-loopback bind auto-flips to
  // authenticated mode, so login is required and nothing is auto-sessioned.
  // --local returns to zero-credential loopback. Raw read/write preserves the
  // user's other keys.
  if (opts.expose || opts.local) {
    const raw = readRawConfig(dataDir);
    const server = (raw.server && typeof raw.server === "object")
      ? { ...(raw.server as Record<string, unknown>) }
      : {};
    const targetHost = opts.expose ? "0.0.0.0" : "127.0.0.1";
    const changed: string[] = [];
    if (server.host !== targetHost) {
      server.host = targetHost;
      changed.push(`server.host = ${targetHost}`);
    }
    // Going local clears an explicit requireAuth override so it's truly no-login.
    if (opts.local && server.requireAuth) {
      delete server.requireAuth;
      changed.push("server.requireAuth = false");
    }
    if (changed.length > 0) {
      raw.server = server;
      writeRawConfig(dataDir, raw);
      for (const c of changed) console.log(`✓ updated config.${c}`);
    } else {
      console.log(opts.expose ? "✓ already exposed (0.0.0.0)" : "✓ already local");
    }
  }

  const config = loadConfig(dataDir);
  const host = config.server.host;
  const port = config.server.port;
  const url = userFacingUrl(host, port);

  // No agent gate here — the daemon's `ensureManagedAgents()` materializes
  // the Acme platform agent on first boot. If provider auth is missing
  // the daemon still boots; chat fails with a self-explanatory auth error
  // which is the right surface for that case.
  //
  // Auth is always on (per-member email+password), loopback or not — no
  // secret to generate here anymore. First access goes through the web
  // claim flow; the daemon prints a setup link to its log on first boot.

  const lp = logPath(dataDir);
  if (!fs.existsSync(lp)) writeAtomic0600(lp, "");

  const lifecycle = getPlatformLifecycle({ dataDir, forceNoService: opts.noService });

  const initialStatus = await lifecycle.status();
  if (initialStatus.running) {
    if (!opts.expose && !opts.local) {
      // Idempotent: already running, nothing to do.
      console.log(`✓ openacme is already running${initialStatus.pid ? ` (pid ${initialStatus.pid})` : ""} at ${url}`);
      if (process.stdout.isTTY && !opts.noBrowser) openBrowser(url);
      return;
    }
    // --expose / --local with a running daemon: restart to pick up the bind.
    console.log("⠋ restarting daemon to apply new bind...");
    await lifecycle.stopService();
    clearPid(dataDir);
    await new Promise((r) => setTimeout(r, 300));
  }

  const binPath = resolveBinaryPath();
  const nodePath = resolveNodePath();

  const install = await lifecycle.installUnit({ binPath, nodePath, dataDir, logPath: lp, host, port });
  if (install.wrote) {
    if (lifecycle.kind === "no-service") {
      console.log("✓ no-service mode (PID file only; no auto-restart)");
    } else {
      console.log(`✓ wrote ${lifecycle.kind} unit (${install.path})`);
    }
  }

  await lifecycle.startService();
  if (lifecycle.kind !== "no-service") {
    console.log(`✓ service started via ${lifecycle.kind}`);
  }

  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  process.stdout.write("⠋ waiting for daemon to come up...");
  const healthy = await pollHealth(healthUrl, 10_000);
  process.stdout.write("\r");
  if (!healthy) {
    console.error("✗ daemon did not respond on /api/health within 10s");
    console.error(`  check the log: openacme logs (file: ${lp})`);
    process.exit(1);
  }

  const finalStatus = await lifecycle.status();
  const pidLine = finalStatus.pid ? ` (pid ${finalStatus.pid})` : "";
  console.log(`✓ daemon listening on ${url}${pidLine}`);

  // In authenticated mode (exposed, or requireAuth) there's an operator
  // account to claim. Surface the setup link and open the browser straight to
  // it (token prefilled) so it needs no extra CLI step. Local-trusted installs
  // auto-session the user — nothing to claim, so this is skipped entirely.
  let openUrl = url;
  if (resolveDeploymentMode(config.server) === "authenticated") {
    try {
      const db = createDatabase(config);
      const store = createAuthStore(db);
      if (store.countMembers() === 0) {
        const { token } = store.createEnrollToken();
        const { url: claimUrl, exposed } = reachableBaseUrl(config.server);
        openUrl = `${claimUrl}/setup?token=${token}`;
        console.log("");
        console.log(
          opts.expose
            ? "  Exposing this instance — open to create your operator account:"
            : "  First run — open this to create your account:"
        );
        console.log("");
        console.log(`      ${openUrl}`);
        console.log("");
        if (exposed) {
          console.log(
            "  Open it from your own machine — use your domain/public IP if you"
          );
          console.log("  reach this server by another name.");
          console.log("");
        }
        console.log("  Add someone later:  openacme invite");
      } else {
        console.log("");
        console.log("  Add someone:  openacme invite   (one-time link, hand off out-of-band)");
      }
      db.close();
    } catch {
      console.log("");
      console.log("  Create your account:  openacme claim   (prints the setup link)");
    }
  }

  console.log("");
  console.log(`  status:  openacme status`);
  console.log(`  logs:    openacme logs -f`);
  console.log(`  stop:    openacme stop`);
  console.log(`  open:    ${url}`);

  if (finalStatus.pid) {
    writeAtomic0600(pidPath(dataDir), String(finalStatus.pid));
  }

  if (process.stdout.isTTY && !opts.noBrowser) {
    setTimeout(() => openBrowser(openUrl), 500);
  }
}
