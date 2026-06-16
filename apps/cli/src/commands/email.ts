import * as path from "node:path";
import * as p from "@clack/prompts";
import {
  createAgentStore,
  loadConfig,
  type AgentDefinition,
  type AgentEmail,
} from "@openacme/config";
import {
  oauthAuthorizeGoogle,
  oauthAuthorizeMicrosoft,
  googleRedirectUri,
  microsoftRedirectUri,
} from "@openacme/auth";
import {
  writeEmailCredentials,
  readEmailCredentials,
  GMAIL_OAUTH_SCOPES,
  GRAPH_OAUTH_SCOPES,
} from "@openacme/email";
import { EMAIL_TOOL_NAMES } from "@openacme/tools";

export interface EmailOptions {
  provider?: "imap" | "gmail" | "microsoft";
  dataDir?: string;
}

/** Bind the mailbox AND make sure the agent's tool list includes the email
 *  tools — otherwise an existing agent with an explicit `tools:` list would
 *  get a mailbox it has no tools to use. */
function boundDef(def: AgentDefinition, email: AgentEmail): AgentDefinition {
  return {
    ...def,
    email,
    tools: Array.from(new Set([...def.tools, ...EMAIL_TOOL_NAMES])),
  };
}

interface Ctx {
  config: ReturnType<typeof loadConfig>;
  agentsDir: string;
  agents: ReturnType<typeof createAgentStore>;
}

function ctx(opts: EmailOptions): Ctx {
  const config = loadConfig(opts.dataDir);
  const agentsDir = path.join(config.dataDir, "agents");
  return { config, agentsDir, agents: createAgentStore(agentsDir) };
}

async function ask(
  message: string,
  o?: { placeholder?: string; defaultValue?: string }
): Promise<string | null> {
  const v = await p.text({ message, ...o });
  if (p.isCancel(v)) {
    p.cancel("Cancelled.");
    return null;
  }
  const s = (v as string).trim();
  return s || (o?.defaultValue ?? "");
}

export async function emailLoginCommand(
  agentId: string,
  opts: EmailOptions
): Promise<void> {
  const c = ctx(opts);
  const def = c.agents.get(agentId);
  if (!def) {
    p.cancel(`Agent not found: ${agentId}`);
    process.exitCode = 1;
    return;
  }

  let provider = opts.provider;
  if (!provider) {
    const choice = await p.select({
      message: `Email provider for "${agentId}"?`,
      options: [
        {
          value: "imap",
          label: "IMAP / SMTP",
          hint: "any mailbox — Zoho, Migadu, Fastmail, self-hosted",
        },
        { value: "gmail", label: "Gmail", hint: "OAuth (needs config.email.google)" },
        {
          value: "microsoft",
          label: "Outlook / Microsoft 365",
          hint: "OAuth (needs config.email.microsoft)",
        },
      ],
    });
    if (p.isCancel(choice)) {
      p.cancel("Cancelled.");
      return;
    }
    provider = choice as EmailOptions["provider"];
  }

  if (provider === "imap") return loginImap(c, agentId, def);
  if (provider === "gmail") return loginGmail(c, agentId, def);
  return loginMicrosoft(c, agentId, def);
}

async function loginImap(
  c: Ctx,
  agentId: string,
  def: AgentDefinition
): Promise<void> {
  // Global defaults (config.email.imap) — blank prompts inherit these.
  const d = c.config.email.imap;
  const address = await ask("Email address", { placeholder: "agent@example.com" });
  if (address === null || !address) return;
  const host = await ask("IMAP host", {
    placeholder: d?.host ? `inherits ${d.host}` : "imap.example.com",
  });
  if (host === null) return;
  if (!host && !d?.host) {
    p.cancel("IMAP host is required (no global config.email.imap.host default).");
    process.exitCode = 1;
    return;
  }
  const port = await ask("IMAP port", {
    placeholder: d?.port ? `inherits ${d.port}` : "993",
  });
  if (port === null) return;
  const user = await ask("Login user (optional)", { placeholder: address });
  if (user === null) return;
  const smtpHost = await ask("SMTP host (optional)", {
    placeholder: d?.smtpHost ? `inherits ${d.smtpHost}` : "defaults to IMAP host",
  });
  if (smtpHost === null) return;
  const smtpPort = await ask("SMTP port", {
    placeholder: d?.smtpPort ? `inherits ${d.smtpPort}` : "587",
  });
  if (smtpPort === null) return;
  const password = await p.password({ message: "App password" });
  if (p.isCancel(password)) {
    p.cancel("Cancelled.");
    return;
  }

  // Write only what was entered — omitted fields inherit config.email.imap.
  const email: AgentEmail = { provider: "imap", address };
  if (host) email.host = host;
  if (user) email.user = user;
  if (smtpHost) email.smtpHost = smtpHost;
  if (port) email.port = Number(port);
  if (smtpPort) email.smtpPort = Number(smtpPort);
  c.agents.upsert(boundDef(def, email));
  writeEmailCredentials(c.agentsDir, agentId, {
    version: 1,
    provider: "imap",
    imap: { password: password as string },
  });
  p.outro(`IMAP mailbox bound to "${agentId}": ${address}`);
}

async function loginGmail(
  c: Ctx,
  agentId: string,
  def: AgentDefinition
): Promise<void> {
  const app = c.config.email.google;
  if (!app) {
    p.cancel(
      "Gmail needs a BYO OAuth app. Set config.email.google { clientId, clientSecret } " +
        "in config.yaml first (Google Cloud → APIs & Services → Credentials)."
    );
    process.exitCode = 1;
    return;
  }
  p.note(
    `Register this redirect URI in your Google OAuth client:\n  ${googleRedirectUri()}`,
    "Gmail"
  );
  const spin = p.spinner();
  spin.start("Waiting for Google sign-in");
  try {
    const tok = await oauthAuthorizeGoogle({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      scopes: GMAIL_OAUTH_SCOPES,
      onAuthUrl: (url) => spin.message(`If your browser didn't open, visit:\n  ${url}`),
    });
    spin.stop(`Authorized${tok.account_id ? ` as ${tok.account_id}` : ""}.`);
    let address = tok.account_id;
    if (!address) {
      const entered = await ask("Gmail address", { placeholder: "agent@gmail.com" });
      if (!entered) return;
      address = entered;
    }
    const email: AgentEmail = { provider: "gmail", address };
    c.agents.upsert(boundDef(def, email));
    writeEmailCredentials(c.agentsDir, agentId, {
      version: 1,
      provider: "gmail",
      oauth: {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: tok.expires_at,
        account_id: address,
      },
    });
    p.outro(`Gmail bound to "${agentId}": ${address}`);
  } catch (e) {
    spin.stop("Sign-in failed");
    p.cancel(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

async function loginMicrosoft(
  c: Ctx,
  agentId: string,
  def: AgentDefinition
): Promise<void> {
  const app = c.config.email.microsoft;
  if (!app) {
    p.cancel(
      "Microsoft needs a BYO Entra app. Set config.email.microsoft { clientId, clientSecret } " +
        "in config.yaml first (Entra ID → App registrations)."
    );
    process.exitCode = 1;
    return;
  }
  p.note(
    `Register this redirect URI in your Entra app (Web platform):\n  ${microsoftRedirectUri()}`,
    "Microsoft"
  );
  const spin = p.spinner();
  spin.start("Waiting for Microsoft sign-in");
  try {
    const tok = await oauthAuthorizeMicrosoft({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      tenant: app.tenant,
      scopes: GRAPH_OAUTH_SCOPES,
      onAuthUrl: (url) => spin.message(`If your browser didn't open, visit:\n  ${url}`),
    });
    spin.stop(`Authorized${tok.account_id ? ` as ${tok.account_id}` : ""}.`);
    let address = tok.account_id;
    if (!address) {
      const entered = await ask("Outlook address", { placeholder: "agent@outlook.com" });
      if (!entered) return;
      address = entered;
    }
    const email: AgentEmail = { provider: "microsoft", address };
    c.agents.upsert(boundDef(def, email));
    writeEmailCredentials(c.agentsDir, agentId, {
      version: 1,
      provider: "microsoft",
      oauth: {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: tok.expires_at,
        account_id: address,
      },
    });
    p.outro(`Microsoft mailbox bound to "${agentId}": ${address}`);
  } catch (e) {
    spin.stop("Sign-in failed");
    p.cancel(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

export async function emailStatusCommand(
  agentId: string | undefined,
  opts: EmailOptions
): Promise<void> {
  const c = ctx(opts);
  const defs = agentId
    ? [c.agents.get(agentId)].filter((d): d is AgentDefinition => !!d)
    : c.agents.list();
  if (agentId && defs.length === 0) {
    p.cancel(`Agent not found: ${agentId}`);
    process.exitCode = 1;
    return;
  }
  p.intro("Email status");
  let any = false;
  for (const def of defs) {
    if (!def.email) continue;
    any = true;
    const creds = readEmailCredentials(c.agentsDir, def.id);
    let status: string;
    if (!creds) {
      status = "NO CREDENTIALS — run `openacme email login`";
    } else if (creds.oauth?.expires_at) {
      const exp = new Date(creds.oauth.expires_at * 1000).toISOString();
      status = `oauth (access token expires ${exp})`;
    } else if (creds.oauth) {
      status = "oauth";
    } else if (creds.imap) {
      status = "password set";
    } else {
      status = "credentials present";
    }
    p.log.message(`${def.id}  ·  ${def.email.provider}  ·  ${def.email.address}\n  ${status}`);
  }
  p.outro(any ? "Done." : "No agents have email configured.");
}
