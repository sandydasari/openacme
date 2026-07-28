import { execFileSync } from "node:child_process";

// Build-time only. Returns undefined when git history is unavailable (e.g.
// shallow CI clones) so the sitemap omits lastModified rather than lying.
const cache = new Map<string, string | undefined>();

export function gitLastModified(absPath?: string): string | undefined {
  if (!absPath) return undefined;
  if (cache.has(absPath)) return cache.get(absPath);
  let iso: string | undefined;
  try {
    iso =
      execFileSync("git", ["log", "-1", "--format=%cI", "--", absPath], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined;
  } catch {
    iso = undefined;
  }
  cache.set(absPath, iso);
  return iso;
}
