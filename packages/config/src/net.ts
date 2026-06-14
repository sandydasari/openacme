/**
 * Loopback detection + deployment-mode derivation.
 *
 * One source of truth for "is this address local?", consumed at two layers:
 *  - the bind host (config.server.host) decides the boot-time deployment mode;
 *  - the per-request Host header decides whether a single request is trusted.
 * The Host header is the real per-request signal — tunnels and reverse proxies
 * preserve the user-facing hostname, the connection IP does not.
 */

import { networkInterfaces } from "node:os";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Is a bind host loopback-only? Drives the boot-time deployment mode. */
export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Is a request's `Host` header loopback? Strips the `:port` (and `[..]` IPv6
 * brackets) before testing. An absent Host counts as untrusted — HTTP/1.1
 * requires it, so only a crafted client omits it.
 */
export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    h = end > 0 ? h.slice(1, end) : h;
  } else {
    const colon = h.indexOf(":");
    if (colon >= 0) h = h.slice(0, colon);
  }
  return LOOPBACK_HOSTS.has(h);
}

export type DeploymentMode = "local_trusted" | "authenticated";

/**
 * Derive the deployment mode from the server config. A non-loopback bind is
 * always `authenticated` (you can't opt out of auth when exposed); a loopback
 * bind is `local_trusted` unless `requireAuth` forces credentials locally.
 */
export function resolveDeploymentMode(server: {
  host: string;
  requireAuth?: boolean;
}): DeploymentMode {
  if (server.requireAuth) return "authenticated";
  return isLoopbackBindHost(server.host) ? "local_trusted" : "authenticated";
}

/** First non-internal IPv4 address of this machine, or null. */
export function firstNonInternalIPv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}

/**
 * A browser-openable base URL for the daemon, plus whether login is required
 * (`exposed` = authenticated mode). The URL: a loopback bind → localhost; a
 * wildcard bind (0.0.0.0/::) → a detected LAN IPv4 (best effort) or a
 * `<your-server-host>` placeholder; a specific bind address verbatim. When
 * shared (authenticated) the real entry point is a tunnel/proxy URL we can't
 * know, so the caller hints to substitute a domain/public IP.
 */
export function reachableBaseUrl(server: {
  host: string;
  port: number;
  requireAuth?: boolean;
}): { url: string; exposed: boolean } {
  const { host, port } = server;
  const exposed = resolveDeploymentMode(server) === "authenticated";
  let url: string;
  if (isLoopbackBindHost(host)) {
    url = `http://localhost:${port}`;
  } else if (host === "0.0.0.0" || host === "::") {
    url = `http://${firstNonInternalIPv4() ?? "<your-server-host>"}:${port}`;
  } else {
    url = `http://${host}:${port}`;
  }
  return { url, exposed };
}
