import {
  SandboxManager,
  getDefaultWritePaths,
} from "@anthropic-ai/sandbox-runtime";
import { createLogger } from "@openacme/config/logger";
import { toSandboxConfig, type PathPolicy } from "@openacme/config";

const log = createLogger("tool-host.sandbox");

/**
 * srt (@anthropic-ai/sandbox-runtime) glue. The SandboxManager is a
 * process-global singleton initialized once with a permissive base;
 * each worker spawn passes its agent's filesystem policy as a per-call
 * override via `wrapWithSandboxArgv`.
 *
 * Sandboxing is ALWAYS ON — there is no config knob. The only way a
 * worker runs unconfined is platform degradation (unsupported OS or
 * missing Linux system deps), which is loud: startup banner, per-turn
 * UI warning, and a line in every agent's Access section.
 *
 * Network is intentionally permissive in v1 (the ask-callback allows
 * every host): the boundary being shipped here is filesystem. Per-agent
 * network rules are a natural later extension on the same seam.
 */

export type SandboxStatus =
  | { supported: true }
  | { supported: false; reason: string };

let status: SandboxStatus | null = null;
let initialized: Promise<void> | null = null;

/** Sync platform/dependency probe — callable at construction time so
 *  degradation is known (and loudly reported) before any tool runs. */
export function checkSandboxSupport(): SandboxStatus {
  if (status) return status;
  if (!SandboxManager.isSupportedPlatform()) {
    status = {
      supported: false,
      reason: `OS sandboxing is not supported on ${process.platform}`,
    };
  } else {
    const deps = SandboxManager.checkDependencies();
    if (deps.errors.length > 0) {
      status = {
        supported: false,
        reason:
          deps.errors.join("; ") +
          (process.platform === "linux"
            ? " (install with: apt install bubblewrap socat ripgrep)"
            : ""),
      };
    } else {
      if (deps.warnings.length > 0) {
        log.warn({ warnings: deps.warnings }, "sandbox dependency warnings");
      }
      status = { supported: true };
    }
  }
  if (!status.supported) {
    const banner =
      `SANDBOX UNAVAILABLE — agent tools will run UNCONFINED: ${status.reason}`;
    log.error(banner);
    console.error(`\n!!! ${banner}\n`);
  }
  return status;
}

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    initialized = SandboxManager.initialize(
      {
        network: {
          allowedDomains: [],
          deniedDomains: [],
          allowLocalBinding: true,
        },
        filesystem: {
          denyRead: [],
          allowRead: [],
          allowWrite: [],
          denyWrite: [],
        },
      },
      // Permissive network v1: hosts that match no rule land here.
      async () => true
    );
  }
  return initialized;
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Wrap a worker spawn under the agent's compiled policy. Returns the
 *  argv to spawn plus env additions (proxy vars etc.) srt requires
 *  inside the sandbox. */
export async function wrapSpawn(
  baseArgv: string[],
  policy: PathPolicy
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  await ensureInitialized();
  const fsConfig = toSandboxConfig(policy);
  const command = baseArgv.map(shellQuote).join(" ");
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    command,
    "/bin/sh",
    {
      filesystem: {
        denyRead: fsConfig.denyRead,
        allowRead: fsConfig.allowRead,
        // srt's recommended baseline: /dev nodes, its TMPDIR, npm logs.
        allowWrite: [...getDefaultWritePaths(), ...fsConfig.allowWrite],
        denyWrite: fsConfig.denyWrite,
      },
    }
  );
  return { argv, env };
}

/** Best-effort teardown of srt's host-side proxy servers on daemon close. */
export async function resetSandbox(): Promise<void> {
  if (!initialized) return;
  try {
    await SandboxManager.reset();
  } catch (e) {
    log.warn({ err: e }, "sandbox reset failed");
  }
  initialized = null;
}
