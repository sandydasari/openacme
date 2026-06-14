import type { Context } from "hono";
import { SESSION_COOKIE_NAME } from "./auth.js";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days — matches the session TTL

/** True when the request arrived over HTTPS — gates the cookie's Secure flag.
 *  A Secure cookie over plain http is dropped, so we only set it on https. */
export function isSecure(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto") ?? "";
  return proto === "https" || c.req.url.startsWith("https:");
}

/** The one session-cookie definition. Set identically by the login/enroll
 *  routes and the local-trusted auto-session middleware so they never drift. */
export function buildSessionCookie(value: string, secure: boolean): string {
  // HttpOnly: JS can't read it (XSS exfil). SameSite=Lax: top-level
  // navigation back from /login still sets it. Path=/: covers /api + HTML.
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
