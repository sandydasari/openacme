import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startE2EServer, type E2EServer } from "./support/harness.js";
import { makeClient, assistantText, waitUntil } from "./support/client.js";

/** Raw GET with a forged Host header. undici's fetch forbids overriding Host
 *  (it pins it to the connection address), so the non-loopback / DNS-rebind
 *  case has to go through node:http to set Host independently of the socket. */
function rawGet(
  baseUrl: string,
  path: string,
  hostHeader: string
): Promise<{ status: number; setCookie?: string }> {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path, method: "GET", headers: { Host: hostHeader } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, setCookie: res.headers["set-cookie"]?.[0] });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Both deployment modes, end to end over real HTTP against a real daemon:
 *  - local_trusted (loopback bind): zero credentials, the daemon auto-sessions
 *    every loopback request — a full chat turn runs with no auth header.
 *  - authenticated (non-loopback bind): the same credential-less client is
 *    locked out until it claims an operator account and logs in.
 *
 * No member is seeded — each scenario exercises the gate from a clean install.
 */

function getCookie(res: Response): string | null {
  const sc = res.headers.get("set-cookie");
  const m = sc?.match(/openacme_session=([^;]+)/);
  return m ? m[1]! : null;
}

describe("local_trusted mode (loopback) — no credentials", () => {
  let srv: E2EServer;
  beforeAll(async () => {
    srv = await startE2EServer({ serverHost: "127.0.0.1", seedMember: false });
  });
  afterAll(async () => {
    await srv.close();
  });

  it("auto-sessions a credential-less loopback request and sets a cookie", async () => {
    const res = await fetch(`${srv.baseUrl}/api/agents`, {
      headers: { host: "localhost" },
    });
    expect(res.status).toBe(200);
    const cookie = getCookie(res);
    expect(cookie).toBeTruthy();

    const status = await fetch(`${srv.baseUrl}/api/auth/status`, {
      headers: { host: "127.0.0.1", cookie: `openacme_session=${cookie}` },
    }).then((r) => r.json());
    expect(status.authRequired).toBe(false);
    expect(status.member?.email).toBe("local@localhost");
  });

  it("refuses a non-loopback Host with no credentials (DNS-rebind defense)", async () => {
    const res = await rawGet(srv.baseUrl, "/api/agents", "evil.example.com");
    expect(res.status).toBe(401);
    expect(res.setCookie).toBeUndefined();
  });

  it("runs a full chat turn with no auth header at all", async () => {
    // The default client carries an EMPTY bearer — on a loopback Host the
    // daemon auto-sessions it, so the whole chat path works credential-free.
    const client = makeClient(srv.baseUrl, "");
    await client.createAgent("local-helper");
    const { sessionId } = await client.chat("local-helper", "ping");
    await waitUntil(async () => {
      const msgs = await client.messages(sessionId);
      return msgs.some(
        (m) => m.role === "assistant" && assistantText(m.parts).length > 0
      );
    });
  });
});

describe("authenticated mode (non-loopback) — credentials required", () => {
  let srv: E2EServer;
  beforeAll(async () => {
    srv = await startE2EServer({ serverHost: "0.0.0.0", seedMember: false });
  });
  afterAll(async () => {
    await srv.close();
  });

  it("locks out a credential-less request even from a loopback Host", async () => {
    const res = await fetch(`${srv.baseUrl}/api/agents`, {
      headers: { host: "127.0.0.1" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("needs_setup");
    expect(getCookie(res)).toBeNull();
  });

  it("admits an operator after claim + login, and runs a chat turn", async () => {
    // Claim: mint an enroll token (as the boot log does) and redeem it.
    const { token: enrollToken } = srv.manager.authStore.createEnrollToken();
    const enroll = await fetch(`${srv.baseUrl}/api/auth/enroll`, {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({
        token: enrollToken,
        email: "founder@example.com",
        password: "supersecret1",
      }),
    });
    expect(enroll.status).toBe(201);
    const session = (await enroll.json()).token as string;
    expect(session).toBeTruthy();

    const client = makeClient(srv.baseUrl, session);
    await client.createAgent("authed-helper");
    const { sessionId } = await client.chat("authed-helper", "ping");
    await waitUntil(async () => {
      const msgs = await client.messages(sessionId);
      return msgs.some(
        (m) => m.role === "assistant" && assistantText(m.parts).length > 0
      );
    });

    // A fresh login with the same credentials also works.
    const login = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({
        email: "founder@example.com",
        password: "supersecret1",
      }),
    });
    expect(login.status).toBe(200);
    expect((await login.json()).member?.email).toBe("founder@example.com");
  });
});
