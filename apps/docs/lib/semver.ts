/* Loose semver compare — sorts "1.2.10" above "1.2.9". Non-numeric tails
   (pre-release) sort below their release. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split("-")[0]!.split(".").map(Number);
  const pb = b.replace(/^v/, "").split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  // equal release core: a plain version outranks a pre-release of the same core
  const prA = a.includes("-");
  const prB = b.includes("-");
  if (prA !== prB) return prA ? -1 : 1;
  return a.localeCompare(b);
}
