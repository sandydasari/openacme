import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@openacme/config";
import { createApp } from "../src/app.js";
import type { AgentManager } from "../src/agent-manager.js";
import type { Hono } from "hono";

/**
 * Local-trusted vs authenticated auth modes. No LLM is ever called — these
 * exercise the middleware decision tree (auto-session, DNS-rebind defense,
 * claim mode, member-list filtering) only.
 */

const managers: AgentManager[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function buildApp(
  server: { host: string; requireAuth?: boolean },
  dataDir?: string
): Promise<{ app: Hono; manager: AgentManager; dataDir: string }> {
  const dir = dataDir ?? mkdtempSync(path.join(tmpdir(), "openacme-authmode-"));
  if (!dataDir) dataDirs.push(dir);
  const config = ConfigSchema.parse({
    dataDir: dir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    server,
  });
  const { app, manager } = await createApp(config);
  managers.push(manager);
  return { app, manager, dataDir: dir };
}

/** Close a manager now and drop it from afterEach's sweep (no double-close). */
async function closeManager(manager: AgentManager): Promise<void> {
  const i = managers.indexOf(manager);
  if (i >= 0) managers.splice(i, 1);
  await manager.close();
}

function getCookie(res: Response): string | null {
  const sc = res.headers.get("set-cookie");
  if (!sc) return null;
  const m = sc.match(/openacme_session=([^;]+)/);
  return m ? m[1]! : null;
}

describe("local_trusted mode (loopback bind)", () => {
  it("auto-sessions a loopback request with no credentials", async () => {
    const { app } = await buildApp({ host: "127.0.0.1" });
    const res = await app.request("http://127.0.0.1/api/agents", {
      headers: { host: "localhost:3456" },
    });
    expect(res.status).toBe(200);
    const cookie = getCookie(res);
    expect(cookie).toBeTruthy();

    // The minted cookie authenticates the next request.
    const res2 = await app.request("http://127.0.0.1/api/agents", {
      headers: { host: "localhost:3456", cookie: `openacme_session=${cookie}` },
    });
    expect(res2.status).toBe(200);
  });

  it("/api/auth/status reports a member and authRequired:false", async () => {
    const { app } = await buildApp({ host: "127.0.0.1" });
    // Mirror the browser flow: the HTML doc request establishes the session
    // (cookie) before the SPA polls status.
    const seed = await app.request("http://127.0.0.1/api/agents", {
      headers: { host: "127.0.0.1" },
    });
    const cookie = getCookie(seed);
    const res = await app.request("http://127.0.0.1/api/auth/status", {
      headers: { host: "127.0.0.1", cookie: `openacme_session=${cookie}` },
    });
    const body = (await res.json()) as {
      member: { email: string } | null;
      needsSetup: boolean;
      authRequired: boolean;
    };
    expect(body.authRequired).toBe(false);
    expect(body.needsSetup).toBe(false);
    expect(body.member?.email).toBe("local@localhost");
  });

  it("does NOT auto-session a non-loopback Host (DNS-rebind defense)", async () => {
    const { app } = await buildApp({ host: "127.0.0.1" });
    const res = await app.request("http://127.0.0.1/api/agents", {
      headers: { host: "evil.example.com" },
      redirect: "manual",
    });
    // No members yet → claim mode for the untrusted Host.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("needs_setup");
    expect(getCookie(res)).toBeNull();
  });

  it("hides the local operator from the member roster", async () => {
    const { app } = await buildApp({ host: "127.0.0.1" });
    // Trigger creation of the local operator via an auto-session.
    const seed = await app.request("http://127.0.0.1/api/agents", {
      headers: { host: "127.0.0.1" },
    });
    const cookie = getCookie(seed);
    const res = await app.request("http://127.0.0.1/api/members", {
      headers: { host: "127.0.0.1", cookie: `openacme_session=${cookie}` },
    });
    const body = (await res.json()) as { members: { email: string }[] };
    expect(body.members.some((m) => m.email === "local@localhost")).toBe(false);
  });

  it("requireAuth:true forces claim mode even on loopback", async () => {
    const { app } = await buildApp({ host: "127.0.0.1", requireAuth: true });
    const res = await app.request("http://127.0.0.1/api/agents", {
      headers: { host: "127.0.0.1" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("needs_setup");
    expect(getCookie(res)).toBeNull();
  });
});

describe("authenticated mode (non-loopback bind)", () => {
  it("requires a real login — no auto-session even from loopback Host", async () => {
    const { app } = await buildApp({ host: "0.0.0.0" });
    const res = await app.request("http://127.0.0.1/api/agents", {
      headers: { host: "127.0.0.1" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("needs_setup");
    expect(getCookie(res)).toBeNull();
  });

  it("rotates a stale local operator out at boot so its cookie can't replay", async () => {
    // Boot 1: local_trusted — mint a local auto-session.
    const { app: local, manager: localMgr, dataDir } = await buildApp({
      host: "127.0.0.1",
    });
    const seeded = await local.request("http://127.0.0.1/api/agents", {
      headers: { host: "127.0.0.1" },
    });
    const localCookie = getCookie(seeded);
    expect(localCookie).toBeTruthy();
    await closeManager(localMgr);

    // Boot 2: authenticated on the SAME data dir — reconciliation deletes the
    // local operator, so the old loopback cookie no longer authenticates.
    const { app: exposed } = await buildApp({ host: "0.0.0.0" }, dataDir);
    const replay = await exposed.request("http://127.0.0.1/api/agents", {
      headers: { host: "127.0.0.1", cookie: `openacme_session=${localCookie}` },
    });
    expect(replay.status).toBe(401);
  });
});
