import type {
  EmailAccount,
  EmailCredentials,
  EmailMessage,
  EmailSummary,
  ListParams,
  MarkParams,
  MarkResult,
  OAuthAppConfig,
  ReplyParams,
  SearchParams,
  SendParams,
  SendResult,
} from "../types.js";

/**
 * Everything a provider needs to execute one operation for one agent. The
 * provider is stateless across agents; per-agent identity lives entirely in
 * `account` + `creds`. `persistCreds` is how a provider writes back rotated
 * OAuth tokens after a refresh.
 */
export interface ProviderContext {
  account: EmailAccount;
  creds: EmailCredentials;
  oauthApp?: OAuthAppConfig;
  persistCreds: (creds: EmailCredentials) => Promise<void>;
}

/**
 * Email provider abstraction. The contract is "read/search/send/mark a
 * mailbox" — IMAP/SMTP, Gmail API, or Microsoft Graph all slot in. Unlike
 * the browser provider there is no long-lived session: each call opens and
 * closes its own connection (IMAP) or makes a stateless HTTPS request.
 */
export interface EmailProvider {
  readonly name: EmailAccount["provider"];
  list(ctx: ProviderContext, params: ListParams): Promise<EmailSummary[]>;
  search(ctx: ProviderContext, params: SearchParams): Promise<EmailSummary[]>;
  read(
    ctx: ProviderContext,
    messageId: string,
    mailbox?: string
  ): Promise<EmailMessage>;
  send(ctx: ProviderContext, params: SendParams): Promise<SendResult>;
  reply(ctx: ProviderContext, params: ReplyParams): Promise<SendResult>;
  mark(ctx: ProviderContext, params: MarkParams): Promise<MarkResult>;
}
