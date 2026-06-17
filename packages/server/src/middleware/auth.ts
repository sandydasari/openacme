import type { Context, MiddlewareHandler } from "hono";
import type { AuthStore, MemberPublic } from "@openacme/db";
import type { DeploymentMode } from "@openacme/config";
import { isLoopbackHostHeader } from "@openacme/config";
import { buildSessionCookie, isSecure } from "./cookie.js";

const SESSION_COOKIE = "openacme_session";

export interface AuthOptions {
  store: AuthStore;
  /** Boot-time mode derived from the bind host. In `local_trusted` a loopback
   *  request gets a transparently-minted session; in `authenticated` every
   *  request needs a real login. */
  deploymentMode: DeploymentMode;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Pull the bearer/cookie token off a request, cookie first. */
export function extractToken(c: Context): string | null {
  const cookie = parseCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (cookie) return cookie;
  const auth = c.req.header("authorization") ?? "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return null;
}

/** Resolve the member behind a request, or null if unauthenticated. */
export function resolveMember(c: Context, store: AuthStore): MemberPublic | null {
  const token = extractToken(c);
  if (!token) return null;
  return store.resolveSession(token);
}

/**
 * Auth middleware. Auth is always on — there is no no-session bypass branch.
 * For a `local_trusted` boot (loopback bind) a loopback request transparently
 * gets a real auto-session, so a local user never sees a login form while the
 * rest of the stack still resolves a normal member. An `authenticated` boot
 * (non-loopback bind) requires a real login for every request.
 *
 * The decision order, after the always-public surface:
 *  (B) an existing valid session wins — keeps operator logins working on
 *      loopback and never clobbers a real login with the auto-session;
 *  (C) `local_trusted` boot AND a loopback `Host` → mint + set the
 *      auto-session. Both conditions required: a non-loopback bind is never
 *      `local_trusted`, and a spoofed `Host` against a wide bind can't reach
 *      here (DNS-rebind defense);
 *  (D) otherwise the existing claim/login path: zero members → claim mode
 *      (HTML → /setup, /api/* → `needs_setup` 401); else login required.
 */
export function authMiddleware(opts: AuthOptions): MiddlewareHandler {
  return async (c: Context, next) => {
    const path = c.req.path;
    // (A) Always-public surface.
    // Health is unauthenticated — `pollHealth` (CLI) and external monitors
    // must reach it without a session, including in claim mode.
    if (path === "/api/health") return next();
    // Version check is non-sensitive (current + npm latest) — same class as
    // health, and the web banner reads it before any session on local installs.
    if (path === "/api/version/check") return next();
    if (
      path === "/login" ||
      path === "/setup" ||
      path === "/enroll" ||
      path.startsWith("/api/auth/")
    ) {
      return next();
    }
    // Static assets referenced by the login/setup pages must bypass auth,
    // otherwise the HTML loads but its CSS/JS get redirected and the page
    // never hydrates. Vite emits hashed assets under /assets/.
    if (
      path.startsWith("/assets/") ||
      path === "/favicon.ico" ||
      path.startsWith("/favicon")
    ) {
      return next();
    }
    // PWA discovery assets must be reachable pre-login — exact filenames
    // only so a prefix match can't be abused.
    if (
      path === "/manifest.webmanifest" ||
      path === "/sw.js" ||
      path === "/apple-touch-icon.png" ||
      path === "/icon-192.png" ||
      path === "/icon-512.png" ||
      path === "/icon-maskable-512.png"
    ) {
      return next();
    }

    // (B) An existing valid session always wins.
    if (resolveMember(c, opts.store)) return next();

    // (C) Local-trusted auto-session: loopback Host on a local_trusted boot.
    if (
      opts.deploymentMode === "local_trusted" &&
      isLoopbackHostHeader(c.req.header("host"))
    ) {
      const token = opts.store.ensureLocalSession();
      c.header("Set-Cookie", buildSessionCookie(token, isSecure(c)));
      return next();
    }

    // (D) Claim mode (no members yet) or login required.
    if (opts.store.countMembers() === 0) {
      if (path.startsWith("/api/")) {
        return c.json({ error: "needs_setup" }, 401);
      }
      return c.redirect("/setup");
    }
    if (path.startsWith("/api/")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const next_ = encodeURIComponent(
      path + (c.req.url.includes("?") ? c.req.url.slice(c.req.url.indexOf("?")) : "")
    );
    return c.redirect(`/login?next=${next_}`);
  };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
