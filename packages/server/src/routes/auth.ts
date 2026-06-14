import type { Hono } from "hono";
import type { AuthStore } from "@openacme/db";
import type { DeploymentMode } from "@openacme/config";
import { SESSION_COOKIE_NAME, resolveMember } from "../middleware/auth.js";
import {
  buildSessionCookie,
  clearSessionCookie,
  isSecure,
} from "../middleware/cookie.js";

export interface AuthRoutesOptions {
  store: AuthStore;
  deploymentMode: DeploymentMode;
}

export interface MemberRoutesOptions {
  store: AuthStore;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Unauthenticated auth surface — mounted BEFORE the gate. login + logout +
 * status + enroll (the one-time-token member creation behind both first-run
 * claim and invites).
 */
export function registerAuthRoutes(app: Hono, opts: AuthRoutesOptions): void {
  const { store, deploymentMode } = opts;

  app.post("/api/auth/login", async (c) => {
    let body: { email?: string; password?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const email = (body.email ?? "").trim();
    const password = body.password ?? "";
    if (!email || !password) {
      return c.json({ error: "email and password are required" }, 400);
    }
    const member = store.verifyPassword(email, password);
    if (!member) return c.json({ error: "Invalid email or password" }, 401);
    const { token } = store.createSession(member.id);
    c.header("Set-Cookie", buildSessionCookie(token, isSecure(c)));
    return c.json({ ok: true, token, member });
  });

  // First-run claim AND invites land here — both redeem a one-time enroll
  // token to create a member. Same primitive, different token source.
  app.post("/api/auth/enroll", async (c) => {
    let body: { token?: string; email?: string; password?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const token = (body.token ?? "").trim();
    const email = (body.email ?? "").trim();
    const password = body.password ?? "";
    if (!token) return c.json({ error: "token is required" }, 400);
    if (!isValidEmail(email)) return c.json({ error: "A valid email is required" }, 400);
    if (password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }
    if (store.getMemberByEmail(email)) {
      return c.json({ error: "That email is already registered" }, 409);
    }
    if (!store.consumeEnrollToken(token)) {
      return c.json({ error: "This link is invalid, used, or expired" }, 401);
    }
    const member = store.createMember({ email, password });
    const { token: sessionToken } = store.createSession(member.id);
    c.header("Set-Cookie", buildSessionCookie(sessionToken, isSecure(c)));
    return c.json({ ok: true, token: sessionToken, member }, 201);
  });

  app.post("/api/auth/logout", (c) => {
    const cookie = c.req.header("cookie") ?? "";
    const auth = c.req.header("authorization") ?? "";
    // Drop whichever token the caller presented.
    const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : null;
    const m = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    const cookieTok = m ? decodeURIComponent(m[1]!.trim()) : null;
    if (cookieTok) store.deleteSession(cookieTok);
    if (bearer) store.deleteSession(bearer);
    c.header("Set-Cookie", clearSessionCookie(isSecure(c)));
    return c.json({ ok: true });
  });

  // Drives the login/setup pages: needsSetup → render the claim form;
  // member present → already authed, skip the form.
  app.get("/api/auth/status", (c) => {
    const member = resolveMember(c, store);
    return c.json({
      // local_trusted has no claim step — the daemon auto-sessions the user.
      needsSetup:
        deploymentMode === "authenticated" && store.countMembers() === 0,
      authRequired: deploymentMode === "authenticated",
      member: member ?? null,
    });
  });
}

/**
 * Authenticated member-management surface — mounted AFTER the gate so every
 * route here already has a valid session. Flat-role: any member can invite
 * or revoke any other.
 */
export function registerMemberRoutes(app: Hono, opts: MemberRoutesOptions): void {
  const { store } = opts;

  app.get("/api/members", (c) => {
    // The synthetic loopback operator is an implementation detail of
    // local-trusted mode — keep it out of the human roster.
    const members = store
      .listMembers()
      .filter((m) => !store.isLocalOperatorEmail(m.email));
    return c.json({ members });
  });

  // Mint a one-time enrollment link to hand off out-of-band (no email is
  // sent — the founder shares the URL however they like).
  app.post("/api/members/invite", (c) => {
    const { token } = store.createEnrollToken();
    const proto = c.req.header("x-forwarded-proto") ?? (c.req.url.startsWith("https:") ? "https" : "http");
    const host = c.req.header("host") ?? "localhost";
    const url = `${proto}://${host}/enroll?token=${encodeURIComponent(token)}`;
    return c.json({ token, url }, 201);
  });

  app.delete("/api/members/:id", (c) => {
    const id = c.req.param("id");
    const all = store.listMembers();
    const target = all.find((m) => m.id === id);
    if (!target) {
      return c.json({ error: "Member not found" }, 404);
    }
    // The synthetic loopback operator isn't a human member; it'd just be
    // re-created on the next loopback request. Don't let the roster delete it.
    if (store.isLocalOperatorEmail(target.email)) {
      return c.json({ error: "Member not found" }, 404);
    }
    // Refuse to delete the last human member — that would drop the whole app
    // back into claim mode and lock everyone out until someone reads the log.
    const humans = all.filter((m) => !store.isLocalOperatorEmail(m.email));
    if (humans.length === 1) {
      return c.json({ error: "Cannot remove the only member" }, 400);
    }
    store.deleteMember(id);
    return c.json({ ok: true });
  });
}
