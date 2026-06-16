import { ImapFlow, type FetchMessageObject } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser, type AddressObject } from "mailparser";
import type {
  EmailAccount,
  EmailCredentials,
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

function joinAddrs(
  list: ReadonlyArray<{ address?: string | null }> | undefined
): string {
  if (!list) return "";
  return list
    .map((a) => a.address)
    .filter((a): a is string => !!a)
    .join(", ");
}

function addrText(a: AddressObject | AddressObject[] | undefined): string | undefined {
  if (!a) return undefined;
  return Array.isArray(a) ? a.map((x) => x.text).join(", ") : a.text;
}

interface StructNode {
  disposition?: string | null;
  childNodes?: StructNode[];
}

function structHasAttachments(node: StructNode | undefined): boolean {
  if (!node) return false;
  if (node.disposition && node.disposition.toLowerCase() === "attachment") return true;
  return (node.childNodes ?? []).some(structHasAttachments);
}

function summaryFromFetch(msg: FetchMessageObject): EmailSummary {
  const env = msg.envelope;
  return {
    id: String(msg.uid),
    from: joinAddrs(env?.from),
    to: env?.to ? joinAddrs(env.to) : undefined,
    subject: env?.subject ?? "",
    date: env?.date ? new Date(env.date).toISOString() : undefined,
    unread: msg.flags ? !msg.flags.has("\\Seen") : undefined,
    hasAttachments: structHasAttachments(msg.bodyStructure as StructNode | undefined),
  };
}

export class ImapProvider implements EmailProvider {
  readonly name = "imap" as const;

  private clientConfig(account: EmailAccount, creds: EmailCredentials) {
    const password = creds.imap?.password;
    if (!password) throw new Error("IMAP account has no stored password");
    if (!account.host) throw new Error("IMAP account is missing `host`");
    return {
      host: account.host,
      port: account.port ?? 993,
      secure: account.tls ?? true,
      auth: { user: account.user ?? account.address, pass: password },
      logger: false as const,
    };
  }

  private async withClient<T>(
    account: EmailAccount,
    creds: EmailCredentials,
    fn: (client: ImapFlow) => Promise<T>
  ): Promise<T> {
    const client = new ImapFlow(this.clientConfig(account, creds));
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  private transport(ctx: ProviderContext) {
    const password = ctx.creds.imap?.password;
    if (!password) throw new Error("IMAP account has no stored password");
    const a = ctx.account;
    const port = a.smtpPort ?? 587;
    return nodemailer.createTransport({
      host: a.smtpHost ?? a.host,
      port,
      secure: port === 465,
      auth: { user: a.user ?? a.address, pass: password },
    });
  }

  async list(ctx: ProviderContext, params: ListParams): Promise<EmailSummary[]> {
    const mailbox = params.mailbox ?? "INBOX";
    const limit = params.limit ?? 20;
    return this.withClient(ctx.account, ctx.creds, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const found = await client.search(
          params.unreadOnly ? { seen: false } : { all: true },
          { uid: true }
        );
        const uids = (found || []).slice(-limit);
        if (uids.length === 0) return [];
        const out: EmailSummary[] = [];
        for await (const msg of client.fetch(
          uids,
          { envelope: true, flags: true, bodyStructure: true },
          { uid: true }
        )) {
          out.push(summaryFromFetch(msg));
        }
        out.sort((a, b) => Number(b.id) - Number(a.id));
        return out;
      } finally {
        lock.release();
      }
    });
  }

  async search(ctx: ProviderContext, params: SearchParams): Promise<EmailSummary[]> {
    const mailbox = params.mailbox ?? "INBOX";
    const limit = params.limit ?? 20;
    const q = params.query;
    return this.withClient(ctx.account, ctx.creds, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const found = await client.search(
          { or: [{ subject: q }, { from: q }, { to: q }, { body: q }] },
          { uid: true }
        );
        const uids = (found || []).slice(-limit);
        if (uids.length === 0) return [];
        const out: EmailSummary[] = [];
        for await (const msg of client.fetch(
          uids,
          { envelope: true, flags: true, bodyStructure: true },
          { uid: true }
        )) {
          out.push(summaryFromFetch(msg));
        }
        out.sort((a, b) => Number(b.id) - Number(a.id));
        return out;
      } finally {
        lock.release();
      }
    });
  }

  async read(
    ctx: ProviderContext,
    messageId: string,
    mailbox?: string
  ): Promise<EmailMessage> {
    const mb = mailbox ?? "INBOX";
    const uid = Number(messageId);
    return this.withClient(ctx.account, ctx.creds, async (client) => {
      const lock = await client.getMailboxLock(mb);
      try {
        const msg = await client.fetchOne(
          uid,
          { source: true, envelope: true, flags: true },
          { uid: true }
        );
        if (!msg || !msg.source) {
          throw new Error(`message ${messageId} not found in ${mb}`);
        }
        const parsed = await simpleParser(msg.source);
        const attachments = (parsed.attachments ?? []).map((a) => ({
          filename: a.filename ?? "attachment",
          mimeType: a.contentType,
          size: a.size,
        }));
        return {
          id: messageId,
          from: parsed.from?.text ?? "",
          to: addrText(parsed.to),
          cc: addrText(parsed.cc),
          subject: parsed.subject ?? "",
          date: parsed.date ? parsed.date.toISOString() : undefined,
          bodyText: parsed.text ?? undefined,
          bodyHtml: typeof parsed.html === "string" ? parsed.html : undefined,
          attachments,
          unread: msg.flags ? !msg.flags.has("\\Seen") : undefined,
          hasAttachments: attachments.length > 0,
        };
      } finally {
        lock.release();
      }
    });
  }

  async send(ctx: ProviderContext, params: SendParams): Promise<SendResult> {
    // SMTP-only: unlike Gmail/Graph, this does not append a copy to the IMAP
    // Sent folder. Acceptable for v1; revisit with IMAP APPEND if needed.
    const info = await this.transport(ctx).sendMail({
      from: ctx.account.address,
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });
    return { id: info.messageId };
  }

  async reply(ctx: ProviderContext, params: ReplyParams): Promise<SendResult> {
    const uid = Number(params.messageId);
    const mailbox = params.mailbox ?? "INBOX";
    const orig = await this.withClient(ctx.account, ctx.creds, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        return await client.fetchOne(uid, { envelope: true }, { uid: true });
      } finally {
        lock.release();
      }
    });
    if (!orig || !orig.envelope) {
      throw new Error(`cannot reply: message ${params.messageId} not found`);
    }
    const env = orig.envelope;
    const to = (env.replyTo?.length ? env.replyTo : env.from ?? [])
      .map((x) => x.address)
      .filter((a): a is string => !!a);
    const cc = params.replyAll
      ? (env.cc ?? []).map((x) => x.address).filter((a): a is string => !!a)
      : undefined;
    const subject =
      env.subject && /^re:/i.test(env.subject)
        ? env.subject
        : `Re: ${env.subject ?? ""}`;
    const info = await this.transport(ctx).sendMail({
      from: ctx.account.address,
      to,
      cc,
      subject,
      text: params.text,
      html: params.html,
      inReplyTo: env.messageId,
      references: env.messageId,
    });
    return { id: info.messageId };
  }

  async mark(ctx: ProviderContext, params: MarkParams): Promise<MarkResult> {
    const uid = Number(params.messageId);
    const mb = params.mailbox ?? "INBOX";
    const ok = await this.withClient(ctx.account, ctx.creds, async (client) => {
      const lock = await client.getMailboxLock(mb);
      try {
        switch (params.action) {
          case "read":
            return client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          case "unread":
            return client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
          case "flag":
            return client.messageFlagsAdd(uid, ["\\Flagged"], { uid: true });
          case "unflag":
            return client.messageFlagsRemove(uid, ["\\Flagged"], { uid: true });
          case "trash":
            try {
              await client.messageMove(uid, "Trash", { uid: true });
              return true;
            } catch {
              return client.messageDelete(uid, { uid: true });
            }
        }
      } finally {
        lock.release();
      }
    });
    return { messageId: params.messageId, action: params.action, ok: !!ok };
  }
}
