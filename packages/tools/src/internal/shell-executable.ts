import { existsSync } from "node:fs";
import * as path from "node:path";

export type ResolvedShellKind = "bash" | "sh";

export interface ResolvedShell {
  command: string;
  args: string[];
  kind: ResolvedShellKind;
}

type Exists = (candidate: string) => boolean;

function isAbsoluteExecutable(candidate: string | undefined, exists: Exists): string | null {
  if (!candidate || !path.isAbsolute(candidate)) return null;
  return exists(candidate) ? candidate : null;
}

function findOnPath(command: string, env: NodeJS.ProcessEnv, exists: Exists): string | null {
  const pathValue = env.PATH;
  if (!pathValue) return null;
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  exists: Exists = existsSync
): ResolvedShell {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: [], kind: "sh" };
  }

  const bash =
    isAbsoluteExecutable(env.BASH, exists) ??
    isAbsoluteExecutable("/bin/bash", exists) ??
    findOnPath("bash", env, exists);
  if (bash) {
    return { command: bash, args: ["--norc", "--noprofile"], kind: "bash" };
  }

  const sh =
    isAbsoluteExecutable("/bin/sh", exists) ??
    findOnPath("sh", env, exists) ??
    "sh";
  return { command: sh, args: [], kind: "sh" };
}

export function resolveShellForSpawn(
  env: NodeJS.ProcessEnv = process.env,
  exists: Exists = existsSync
): string | boolean {
  if (process.platform === "win32") return true;
  return resolveShell(env, exists).command;
}

export function resolveShellForExec(
  env: NodeJS.ProcessEnv = process.env,
  exists: Exists = existsSync
): string | undefined {
  if (process.platform === "win32") return undefined;
  return resolveShell(env, exists).command;
}
