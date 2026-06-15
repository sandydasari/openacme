import type { Hono } from "hono";
import { reachableBaseUrl, type Config } from "@openacme/config";
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  buildMicrosoftAuthorizeUrl,
  exchangeMicrosoftCode,
  generateVerifier,
  generateChallenge,
  generateState,
} from "@openacme/auth";
import {
  writeEmailCredentials,
  readEmailCredentials,
  clearEmailCredentials,
  GMAIL_OAUTH_SCOPES,
  GRAPH_OAUTH_SCOPES,
  type EmailAccount,
} from "@openacme/email";
import { EMAIL_TOOL_NAMES } from "@openacme/tools";
import type { AgentManager } from "../agent-manager.js";

interface PendingOAuth {
  agentId: string;
  provider: "gmail" | "microsoft";
  verifier: string;
  expires: number;
}

function resultPage(ok: boolean, message: string): string {
  const status = ok ? "CONNECTED" : "FAILED";
  return `<!doctype html><html><head><meta charset="utf-8">
<title>OpenAcme — Email</title>
<style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
font:14px/1.55 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
background:oklch(98.5% 0.004 75);color:oklch(22% 0.008 280)}
@media(prefers-color-scheme:dark){body{background:oklch(16% 0.006 280);color:oklch(94% 0.004 75)}}
.card{border:1px solid oklch(86% 0.004 75);padding:24px 28px;max-width:420px}
.label{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.08em;
text-transform:uppercase;color:${ok ? "oklch(60% 0.13 150)" : "oklch(58% 0.18 28)"}}
.msg{margin-top:10px;font-size:15px}
.hint{margin-top:8px;font-size:12px;color:oklch(54% 0.006 280)}
</style></head><body>
<div class="card">
<div class="label">Email · ${status}</div>
<div class="msg">${message.replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[ch]!)}</div>
<div class="hint">You can close this tab and return to OpenAcme.</div>
</div>
<script>try{window.opener&&window.opener.postMessage({type:"openacme-email-oauth",ok:${ok}},"*")}catch(e){}setTimeout(function(){try{window.close()}catch(e){}},1200)</script>
</body></html>`;
}

export function registerEmailRoutes(
  app: Hono,
  manager: AgentManager,
  config: Config
): void {
  const pending = new Map<string, PendingOAuth>();
  const redirectUri = () =>
    `${reachableBaseUrl(config.server).url}/api/email/oauth/callback`;

  const bindTools = (tools: string[]): string[] =>
    Array.from(new Set([...tools, ...EMAIL_TOOL_NAMES]));

  // Current binding + credential state for an agent (no secrets).
  app.get("/api/agents/:id/email", (c) => {
    const id = c.req.param("id");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    const creds = readEmailCredentials(manager.agentsDir, id);
    return c.json({
      email: def.email ?? null,
      redirectUri: redirectUri(),
      imapDefaults: config.email.imap ?? null,
      oauthApps: {
        google: !!config.email.google,
        microsoft: !!config.email.microsoft,
      },
      status: creds
        ? {
            bound: true,
            kind: creds.oauth ? "oauth" : "imap",
            expiresAt: creds.oauth?.expires_at ?? null,
            account: creds.oauth?.account_id ?? def.email?.address ?? null,
          }
        : { bound: false },
    });
  });

  // Bind a generic IMAP/SMTP mailbox.
  app.post("/api/agents/:id/email/imap", async (c) => {
    const id = c.req.param("id");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const address = String(body.address ?? "").trim();
    const password = String(body.password ?? "");
    const host = String(body.host ?? "").trim();
    if (!address || !password) {
      return c.json({ error: "address and password are required" }, 400);
    }
    if (!host && !config.email.imap?.host) {
      return c.json(
        { error: "host is required (no global config.email.imap.host default set)" },
        400
      );
    }
    // Write only the connection fields the caller supplied — omitted ones
    // inherit the global config.email.imap default at resolution time.
    const email: EmailAccount = { provider: "imap", address };
    if (host) email.host = host;
    const user = String(body.user ?? "").trim();
    if (user) email.user = user;
    const smtpHost = String(body.smtpHost ?? "").trim();
    if (smtpHost) email.smtpHost = smtpHost;
    if (body.port !== undefined && body.port !== null && body.port !== "") {
      email.port = Number(body.port);
    }
    if (body.smtpPort !== undefined && body.smtpPort !== null && body.smtpPort !== "") {
      email.smtpPort = Number(body.smtpPort);
    }
    if (typeof body.tls === "boolean") email.tls = body.tls;
    writeEmailCredentials(manager.agentsDir, id, {
      version: 1,
      provider: "imap",
      imap: { password },
    });
    await manager.updateAgent(id, { email, tools: bindTools(def.tools) });
    return c.json({ ok: true, email });
  });

  // Unbind — drop credentials and the email block.
  app.delete("/api/agents/:id/email", async (c) => {
    const id = c.req.param("id");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    clearEmailCredentials(manager.agentsDir, id);
    await manager.updateAgent(id, { email: undefined });
    return c.json({ ok: true });
  });

  // Start an OAuth flow — returns the authorize URL for the web to open.
  app.post("/api/agents/:id/email/oauth/:provider/start", (c) => {
    const id = c.req.param("id");
    const provider = c.req.param("provider");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    if (provider !== "gmail" && provider !== "microsoft") {
      return c.json({ error: "Unknown provider" }, 400);
    }
    const appCreds =
      provider === "gmail" ? config.email.google : config.email.microsoft;
    if (!appCreds) {
      return c.json(
        {
          error: `config.email.${provider} { clientId, clientSecret } is not set — add your BYO OAuth app first.`,
        },
        400
      );
    }
    const verifier = generateVerifier();
    const challenge = generateChallenge(verifier);
    const state = generateState();
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    pending.set(state, { agentId: id, provider, verifier, expires: now + 10 * 60_000 });
    const authUrl =
      provider === "gmail"
        ? buildGoogleAuthorizeUrl({
            clientId: appCreds.clientId,
            redirectUri: redirectUri(),
            scopes: GMAIL_OAUTH_SCOPES,
            challenge,
            state,
          })
        : buildMicrosoftAuthorizeUrl({
            clientId: appCreds.clientId,
            redirectUri: redirectUri(),
            scopes: GRAPH_OAUTH_SCOPES,
            challenge,
            state,
            tenant: config.email.microsoft?.tenant,
          });
    return c.json({ authUrl });
  });

  // OAuth redirect target — exchanges the code, persists tokens, binds.
  app.get("/api/email/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    if (error) return c.html(resultPage(false, `Authorization failed: ${error}`));
    if (!code || !state) return c.html(resultPage(false, "Missing code or state."));
    const pend = pending.get(state);
    if (!pend) {
      return c.html(resultPage(false, "Expired or unknown sign-in attempt. Try again."));
    }
    pending.delete(state);
    try {
      const appCreds =
        pend.provider === "gmail" ? config.email.google : config.email.microsoft;
      if (!appCreds) {
        return c.html(resultPage(false, `config.email.${pend.provider} is no longer set.`));
      }
      const tokens =
        pend.provider === "gmail"
          ? await exchangeGoogleCode({
              clientId: appCreds.clientId,
              clientSecret: appCreds.clientSecret,
              code,
              verifier: pend.verifier,
              redirectUri: redirectUri(),
            })
          : await exchangeMicrosoftCode({
              clientId: appCreds.clientId,
              clientSecret: appCreds.clientSecret,
              code,
              verifier: pend.verifier,
              redirectUri: redirectUri(),
              scopes: GRAPH_OAUTH_SCOPES,
              tenant: config.email.microsoft?.tenant,
            });
      const def = manager.agentStore.get(pend.agentId);
      if (!def) return c.html(resultPage(false, "Agent no longer exists."));
      const address = tokens.account_id ?? def.email?.address ?? "";
      writeEmailCredentials(manager.agentsDir, pend.agentId, {
        version: 1,
        provider: pend.provider,
        oauth: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_at,
          account_id: address,
        },
      });
      await manager.updateAgent(pend.agentId, {
        email: { provider: pend.provider, address },
        tools: bindTools(def.tools),
      });
      return c.html(
        resultPage(true, `Connected ${address || pend.provider} to "${pend.agentId}".`)
      );
    } catch (e) {
      return c.html(resultPage(false, e instanceof Error ? e.message : String(e)));
    }
  });
}
