import { readEmailCredentials, writeEmailCredentials } from "./credentials.js";
import type { EmailProvider, ProviderContext } from "./providers/base.js";
import { createEmailProvider } from "./providers/index.js";
import type {
  EmailAccount,
  EmailMessage,
  EmailProviderName,
  EmailSummary,
  ListParams,
  MarkParams,
  MarkResult,
  OAuthAppConfig,
  ReplyParams,
  SearchParams,
  SendParams,
  SendResult,
} from "./types.js";

export interface EmailManagerOptions {
  /** `<dataDir>/agents` — where per-agent `email.json` credentials live. */
  agentsDir: string;
  /** BYO OAuth app credentials (Gmail / Microsoft), workforce-wide. */
  oauthApp?: OAuthAppConfig;
  /** Workforce-wide default IMAP/SMTP connection settings. Per-agent `imap`
   *  bindings inherit any field they omit. Never includes credentials. */
  imapDefaults?: Pick<
    EmailAccount,
    "host" | "port" | "smtpHost" | "smtpPort" | "tls"
  >;
  /** Resolve an agent's non-secret email binding (from the agent store). */
  resolveAccount: (agentId: string) => EmailAccount | undefined;
}

/**
 * Per-agent email orchestrator. Mirrors `BrowserManager`: every public method
 * takes `agentId` first and operates only on that agent's mailbox — there is
 * no path to address another agent's email. Providers are stateless; each call
 * opens and closes its own connection (IMAP) or makes a stateless HTTPS
 * request (Gmail / Graph), so nothing is held between calls.
 */
export class EmailManager {
  private readonly agentsDir: string;
  private readonly oauthApp?: OAuthAppConfig;
  private readonly imapDefaults?: EmailManagerOptions["imapDefaults"];
  private readonly resolveAccount: (agentId: string) => EmailAccount | undefined;
  private readonly providers = new Map<EmailProviderName, EmailProvider>();

  constructor(opts: EmailManagerOptions) {
    this.agentsDir = opts.agentsDir;
    this.oauthApp = opts.oauthApp;
    this.imapDefaults = opts.imapDefaults;
    this.resolveAccount = opts.resolveAccount;
  }

  private provider(name: EmailProviderName): EmailProvider {
    let p = this.providers.get(name);
    if (!p) {
      p = createEmailProvider(name);
      this.providers.set(name, p);
    }
    return p;
  }

  private context(agentId: string): ProviderContext {
    if (!agentId) throw new Error("EmailManager calls require an agentId");
    let account = this.resolveAccount(agentId);
    if (!account) {
      throw new Error(`agent ${agentId} has no email account configured`);
    }
    // IMAP accounts inherit any connection field they omit from the global
    // default; per-agent values win. Credentials are never inherited.
    if (account.provider === "imap" && this.imapDefaults) {
      account = { ...this.imapDefaults, ...account };
    }
    const creds = readEmailCredentials(this.agentsDir, agentId);
    if (!creds) {
      throw new Error(
        `agent ${agentId} has no email credentials — run \`openacme email login ${agentId}\``
      );
    }
    return {
      account,
      creds,
      oauthApp: this.oauthApp,
      persistCreds: async (next) =>
        writeEmailCredentials(this.agentsDir, agentId, next),
    };
  }

  async list(agentId: string, params: ListParams): Promise<EmailSummary[]> {
    const ctx = this.context(agentId);
    return this.provider(ctx.account.provider).list(ctx, params);
  }

  async search(agentId: string, params: SearchParams): Promise<EmailSummary[]> {
    const ctx = this.context(agentId);
    return this.provider(ctx.account.provider).search(ctx, params);
  }

  async read(
    agentId: string,
    messageId: string,
    mailbox?: string
  ): Promise<EmailMessage> {
    const ctx = this.context(agentId);
    return this.provider(ctx.account.provider).read(ctx, messageId, mailbox);
  }

  async send(agentId: string, params: SendParams): Promise<SendResult> {
    const ctx = this.context(agentId);
    return this.provider(ctx.account.provider).send(ctx, params);
  }

  async reply(agentId: string, params: ReplyParams): Promise<SendResult> {
    const ctx = this.context(agentId);
    return this.provider(ctx.account.provider).reply(ctx, params);
  }

  async mark(agentId: string, params: MarkParams): Promise<MarkResult> {
    const ctx = this.context(agentId);
    return this.provider(ctx.account.provider).mark(ctx, params);
  }

  // Lifecycle hooks for AgentManager symmetry with BrowserManager. Connect-
  // per-op holds no per-agent state, so these are no-ops today; kept so the
  // call sites (deleteAgent / shutdown) don't need to change if pooling lands.
  async closeAgent(_agentId: string): Promise<void> {}
  async close(): Promise<void> {}
}
