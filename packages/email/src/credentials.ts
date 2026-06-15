import * as fs from "node:fs";
import * as path from "node:path";
import type { EmailCredentials } from "./types.js";

const FILE_NAME = "email.json";

function credPath(agentsDir: string, agentId: string): string {
  return path.join(agentsDir, agentId, FILE_NAME);
}

export function readEmailCredentials(
  agentsDir: string,
  agentId: string
): EmailCredentials | null {
  const p = credPath(agentsDir, agentId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as EmailCredentials;
  } catch {
    return null;
  }
}

/**
 * Atomic 0600 write: tempfile in the same dir → chmod → rename. Mirrors
 * `@openacme/auth`'s `writeAuthFile` so per-agent secrets get the same
 * partial-write and permission guarantees.
 */
export function writeEmailCredentials(
  agentsDir: string,
  agentId: string,
  creds: EmailCredentials
): void {
  const dir = path.join(agentsDir, agentId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = credPath(agentsDir, agentId);
  const tmp = target + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* best-effort */
    }
  }
  fs.renameSync(tmp, target);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* best-effort */
    }
  }
}

export function clearEmailCredentials(agentsDir: string, agentId: string): void {
  fs.rmSync(credPath(agentsDir, agentId), { force: true });
}
