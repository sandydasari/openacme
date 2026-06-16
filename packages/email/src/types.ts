export type EmailProviderName = "imap" | "gmail" | "microsoft";

/**
 * Non-secret per-agent binding — mirrors the `email` block in AGENT.md
 * frontmatter. Secrets (password / OAuth tokens) never live here; see
 * `EmailCredentials`.
 */
export interface EmailAccount {
  provider: EmailProviderName;
  /** The agent's email address (also the OAuth account identity). */
  address: string;
  /** IMAP/SMTP only. */
  host?: string;
  port?: number;
  user?: string;
  smtpHost?: string;
  smtpPort?: number;
  tls?: boolean;
}

/**
 * Secret material persisted per-agent at `<dataDir>/agents/<id>/email.json`
 * (mode 0600). Either an IMAP password or OAuth tokens, per provider.
 */
export interface EmailCredentials {
  version: 1;
  provider: EmailProviderName;
  imap?: { password: string };
  oauth?: {
    access_token: string;
    refresh_token?: string;
    /** Unix seconds. */
    expires_at?: number;
    account_id?: string;
  };
}

/** BYO OAuth app credentials, workforce-wide, from `config.email`. */
export interface OAuthAppConfig {
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string; clientSecret: string; tenant?: string };
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
}

export interface EmailSummary {
  /** Provider message id (IMAP uid, Gmail/Graph id). */
  id: string;
  threadId?: string;
  from: string;
  to?: string;
  subject: string;
  /** ISO 8601. */
  date?: string;
  snippet?: string;
  unread?: boolean;
  hasAttachments?: boolean;
}

export interface EmailMessage extends EmailSummary {
  cc?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments: EmailAttachment[];
}

export interface ListParams {
  /** Folder (IMAP) or label (Gmail). Default INBOX. */
  mailbox?: string;
  limit?: number;
  unreadOnly?: boolean;
}

export interface SearchParams {
  query: string;
  mailbox?: string;
  limit?: number;
}

export interface SendParams {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
}

export interface ReplyParams {
  /** Id of the message being replied to. */
  messageId: string;
  text?: string;
  html?: string;
  replyAll?: boolean;
  /** Folder the original lives in (IMAP only). Default INBOX. */
  mailbox?: string;
}

export interface SendResult {
  /** Provider message id. Absent for Microsoft Graph, whose sendMail/reply
   *  return 202 with no id. */
  id?: string;
  threadId?: string;
}

export type MarkAction = "read" | "unread" | "flag" | "unflag" | "trash";

export interface MarkParams {
  messageId: string;
  action: MarkAction;
  mailbox?: string;
}

export interface MarkResult {
  messageId: string;
  action: MarkAction;
  ok: boolean;
}
