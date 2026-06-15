import { google, type gmail_v1 } from "googleapis";
import type {
  EmailMessage,
  EmailSummary,
  ListParams,
  MarkParams,
  MarkResult,
  ReplyParams,
  SearchParams,
  SendParams,
  SendResult,
} from "../types.js";
import type { EmailProvider, ProviderContext } from "./base.js";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
];

export const GMAIL_OAUTH_SCOPES = GMAIL_SCOPES;

function decodeBody(data?: string | null): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf-8");
}

function header(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  const h = (headers ?? []).find(
    (x) => (x.name ?? "").toLowerCase() === name.toLowerCase()
  );
  return h?.value ?? "";
}

interface BodyAcc {
  text?: string;
  html?: string;
  attachments: EmailMessage["attachments"];
}

function walkParts(part: gmail_v1.Schema$MessagePart | undefined, acc: BodyAcc): void {
  if (!part) return;
  const mime = part.mimeType ?? "";
  if (part.filename && part.body?.attachmentId) {
    acc.attachments.push({
      filename: part.filename,
      mimeType: mime,
      size: part.body.size ?? 0,
      attachmentId: part.body.attachmentId,
    });
  } else if (mime === "text/plain" && part.body?.data) {
    acc.text = (acc.text ?? "") + decodeBody(part.body.data);
  } else if (mime === "text/html" && part.body?.data) {
    acc.html = (acc.html ?? "") + decodeBody(part.body.data);
  }
  (part.parts ?? []).forEach((p) => walkParts(p, acc));
}

function summaryFromMeta(msg: gmail_v1.Schema$Message): EmailSummary {
  const headers = msg.payload?.headers;
  const labels = msg.labelIds ?? [];
  const dateStr = header(headers, "Date");
  let iso: string | undefined;
  if (dateStr) {
    const d = new Date(dateStr);
    if (!Number.isNaN(d.getTime())) iso = d.toISOString();
  }
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? undefined,
    from: header(headers, "From"),
    to: header(headers, "To") || undefined,
    subject: header(headers, "Subject"),
    date: iso,
    snippet: msg.snippet ?? undefined,
    unread: labels.includes("UNREAD"),
    hasAttachments: undefined,
  };
}

function encodeRaw(from: string, params: SendParams, extraHeaders: string[] = []): string {
  const lines = [
    `From: ${from}`,
    `To: ${params.to.join(", ")}`,
    ...(params.cc?.length ? [`Cc: ${params.cc.join(", ")}`] : []),
    ...(params.bcc?.length ? [`Bcc: ${params.bcc.join(", ")}`] : []),
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
    ...extraHeaders,
  ];
  if (params.html) {
    lines.push('Content-Type: text/html; charset="UTF-8"');
    return base64UrlMime(lines, params.html);
  }
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  return base64UrlMime(lines, params.text ?? "");
}

function base64UrlMime(headerLines: string[], body: string): string {
  const msg = headerLines.join("\r\n") + "\r\n\r\n" + body;
  return Buffer.from(msg, "utf-8").toString("base64url");
}

export class GmailProvider implements EmailProvider {
  readonly name = "gmail" as const;

  private async client(ctx: ProviderContext): Promise<gmail_v1.Gmail> {
    const app = ctx.oauthApp?.google;
    if (!app) {
      throw new Error(
        "Gmail provider requires config.email.google { clientId, clientSecret }"
      );
    }
    const o = ctx.creds.oauth;
    if (!o || (!o.refresh_token && !o.access_token)) {
      throw new Error("Gmail account not authorized — run `openacme email login`");
    }
    const auth = new google.auth.OAuth2(app.clientId, app.clientSecret);
    auth.setCredentials({
      access_token: o.access_token,
      refresh_token: o.refresh_token,
      expiry_date: o.expires_at ? o.expires_at * 1000 : undefined,
    });
    // Refresh up-front and persist synchronously — don't rely on the async
    // `tokens` event, which fires mid-request and would lose a rotated token
    // if the process exits before the fire-and-forget write lands.
    const now = Date.now();
    const expiringSoon = !o.expires_at || o.expires_at * 1000 < now + 60_000;
    if (o.refresh_token && expiringSoon) {
      await auth.getAccessToken();
      const c = auth.credentials;
      await ctx.persistCreds({
        ...ctx.creds,
        oauth: {
          access_token: c.access_token ?? o.access_token,
          refresh_token: c.refresh_token ?? o.refresh_token,
          expires_at: c.expiry_date ? Math.floor(c.expiry_date / 1000) : o.expires_at,
          account_id: o.account_id ?? ctx.account.address,
        },
      });
    }
    return google.gmail({ version: "v1", auth });
  }

  private async fetchMetas(
    gmail: gmail_v1.Gmail,
    ids: string[]
  ): Promise<EmailSummary[]> {
    const out: EmailSummary[] = [];
    for (const id of ids) {
      const { data } = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      out.push(summaryFromMeta(data));
    }
    return out;
  }

  async list(ctx: ProviderContext, params: ListParams): Promise<EmailSummary[]> {
    const gmail = await this.client(ctx);
    const { data } = await gmail.users.messages.list({
      userId: "me",
      maxResults: params.limit ?? 20,
      labelIds: [params.mailbox ?? "INBOX"],
      q: params.unreadOnly ? "is:unread" : undefined,
    });
    return this.fetchMetas(gmail, (data.messages ?? []).map((m) => m.id!).filter(Boolean));
  }

  async search(ctx: ProviderContext, params: SearchParams): Promise<EmailSummary[]> {
    const gmail = await this.client(ctx);
    const { data } = await gmail.users.messages.list({
      userId: "me",
      maxResults: params.limit ?? 20,
      q: params.query,
    });
    return this.fetchMetas(gmail, (data.messages ?? []).map((m) => m.id!).filter(Boolean));
  }

  async read(ctx: ProviderContext, messageId: string): Promise<EmailMessage> {
    const gmail = await this.client(ctx);
    const { data } = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    const summary = summaryFromMeta(data);
    const acc: BodyAcc = { attachments: [] };
    walkParts(data.payload ?? undefined, acc);
    return {
      ...summary,
      cc: header(data.payload?.headers, "Cc") || undefined,
      bodyText: acc.text,
      bodyHtml: acc.html,
      attachments: acc.attachments,
      hasAttachments: acc.attachments.length > 0,
    };
  }

  async send(ctx: ProviderContext, params: SendParams): Promise<SendResult> {
    const gmail = await this.client(ctx);
    const { data } = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encodeRaw(ctx.account.address, params) },
    });
    return { id: data.id ?? "", threadId: data.threadId ?? undefined };
  }

  async reply(ctx: ProviderContext, params: ReplyParams): Promise<SendResult> {
    const gmail = await this.client(ctx);
    const { data: orig } = await gmail.users.messages.get({
      userId: "me",
      id: params.messageId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Subject", "Message-ID", "References"],
    });
    const headers = orig.payload?.headers;
    const origSubject = header(headers, "Subject");
    const subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
    const to = [header(headers, "From")].filter(Boolean);
    const cc = params.replyAll
      ? header(headers, "Cc").split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const msgId = header(headers, "Message-ID");
    const refs = header(headers, "References");
    const raw = encodeRaw(
      ctx.account.address,
      { to, cc, subject, text: params.text, html: params.html },
      [
        ...(msgId ? [`In-Reply-To: ${msgId}`] : []),
        ...(msgId || refs ? [`References: ${[refs, msgId].filter(Boolean).join(" ")}`] : []),
      ]
    );
    const { data } = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: orig.threadId ?? undefined },
    });
    return { id: data.id ?? "", threadId: data.threadId ?? undefined };
  }

  async mark(ctx: ProviderContext, params: MarkParams): Promise<MarkResult> {
    const gmail = await this.client(ctx);
    if (params.action === "trash") {
      await gmail.users.messages.trash({ userId: "me", id: params.messageId });
      return { messageId: params.messageId, action: params.action, ok: true };
    }
    const mod: gmail_v1.Schema$ModifyMessageRequest =
      params.action === "read"
        ? { removeLabelIds: ["UNREAD"] }
        : params.action === "unread"
          ? { addLabelIds: ["UNREAD"] }
          : params.action === "flag"
            ? { addLabelIds: ["STARRED"] }
            : { removeLabelIds: ["STARRED"] };
    await gmail.users.messages.modify({
      userId: "me",
      id: params.messageId,
      requestBody: mod,
    });
    return { messageId: params.messageId, action: params.action, ok: true };
  }
}
