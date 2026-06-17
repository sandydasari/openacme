// npm registry queries for @openacme/cli + semver helpers.

const REGISTRY_BASE = "https://registry.npmjs.org/@openacme/cli";
const FETCH_TIMEOUT_MS = 5_000;

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchLatestVersion(): Promise<string> {
  const body = (await fetchJson(`${REGISTRY_BASE}/latest`)) as { version?: string };
  if (!body.version) throw new Error("registry response missing 'version'");
  return body.version;
}

/** Simple semver `>` for `X.Y.Z` strings (no prerelease handling). */
export function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map((n) => parseInt(n, 10));
  const b = current.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return false;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}
