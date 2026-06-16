import { ConfidentialClientApplication } from "@azure/msal-node";
import { Client } from "@microsoft/microsoft-graph-client";
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

export const GRAPH_OAUTH_SCOPES = [
  "Mail.ReadWrite",
  "Mail.Send",
  "offline_access",
  "openid",
  "email",
];

const TOKEN_SCOPES = ["Mail.ReadWrite", "Mail.Send"];
// Graph access tokens last ~60-90 min; used only when the refresh response
// omits expiresOn (rare). Conservative 50 min so we re-refresh in good time.
const FALLBACK_TOKEN_TTL_SECONDS = 3000;

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}

interface GraphMessage {
  id?: string;
  conversationId?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  attachments?: Array<{ name?: string; contentType?: string; size?: number; id?: string }>;
}

function recip(list: GraphRecipient[] | undefined): string {
  return (list ?? [])
    .map((r) => r.emailAddress?.address)
    .filter((a): a is string => !!a)
    .join(", ");
}

function toRecipients(addrs: string[] | undefined): GraphRecipient[] {
  return (addrs ?? []).map((a) => ({ emailAddress: { address: a } }));
}

function summaryFromGraph(m: GraphMessage): EmailSummary {
  return {
    id: m.id ?? "",
    threadId: m.conversationId,
    from: m.from?.emailAddress?.address ?? "",
    to: recip(m.toRecipients) || undefined,
    subject: m.subject ?? "",
    date: m.receivedDateTime
      ? new Date(m.receivedDateTime).toISOString()
      : undefined,
    snippet: m.bodyPreview,
    unread: m.isRead === undefined ? undefined : !m.isRead,
    hasAttachments: m.hasAttachments,
  };
}

const SELECT =
  "id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview";

export class MicrosoftProvider implements EmailProvider {
  readonly name = "microsoft" as const;

  private async accessToken(ctx: ProviderContext): Promise<string> {
    const app = ctx.oauthApp?.microsoft;
    if (!app) {
      throw new Error(
        "Microsoft provider requires config.email.microsoft { clientId, clientSecret }"
      );
    }
    const o = ctx.creds.oauth;
    if (!o) {
      throw new Error(
        "Microsoft account not authorized — run `openacme email login`"
      );
    }
    const now = Math.floor(Date.now() / 1000);
    if (o.access_token && o.expires_at && o.expires_at > now + 60) {
      return o.access_token;
    }
    if (!o.refresh_token) {
      if (o.access_token) return o.access_token;
      throw new Error(
        "Microsoft token expired and no refresh token — re-run `openacme email login`"
      );
    }
    const cca = new ConfidentialClientApplication({
      auth: {
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        authority: `https://login.microsoftonline.com/${app.tenant ?? "common"}`,
      },
    });
    const res = await cca.acquireTokenByRefreshToken({
      refreshToken: o.refresh_token,
      scopes: TOKEN_SCOPES,
    });
    if (!res?.accessToken) throw new Error("Microsoft token refresh failed");
    const expires_at = res.expiresOn
      ? Math.floor(res.expiresOn.getTime() / 1000)
      : now + FALLBACK_TOKEN_TTL_SECONDS;
    await ctx.persistCreds({
      ...ctx.creds,
      oauth: {
        ...o,
        access_token: res.accessToken,
        expires_at,
        account_id: o.account_id ?? ctx.account.address,
      },
    });
    return res.accessToken;
  }

  private async graph(ctx: ProviderContext): Promise<Client> {
    const token = await this.accessToken(ctx);
    return Client.init({ authProvider: (done) => done(null, token) });
  }

  async list(ctx: ProviderContext, params: ListParams): Promise<EmailSummary[]> {
    const client = await this.graph(ctx);
    const folder = params.mailbox ?? "inbox";
    let req = client
      .api(`/me/mailFolders/${folder}/messages`)
      .select(SELECT)
      .top(params.limit ?? 20)
      .orderby("receivedDateTime desc");
    if (params.unreadOnly) req = req.filter("isRead eq false");
    const res = (await req.get()) as { value?: GraphMessage[] };
    return (res.value ?? []).map(summaryFromGraph);
  }

  async search(ctx: ProviderContext, params: SearchParams): Promise<EmailSummary[]> {
    const client = await this.graph(ctx);
    const res = (await client
      .api("/me/messages")
      .search(`"${params.query}"`)
      .select(SELECT)
      .top(params.limit ?? 20)
      .get()) as { value?: GraphMessage[] };
    return (res.value ?? []).map(summaryFromGraph);
  }

  async read(ctx: ProviderContext, messageId: string): Promise<EmailMessage> {
    const client = await this.graph(ctx);
    const m = (await client
      .api(`/me/messages/${messageId}`)
      .expand("attachments($select=name,contentType,size)")
      .get()) as GraphMessage;
    const summary = summaryFromGraph(m);
    const isHtml = (m.body?.contentType ?? "").toLowerCase() === "html";
    const attachments = (m.attachments ?? []).map((a) => ({
      filename: a.name ?? "attachment",
      mimeType: a.contentType ?? "application/octet-stream",
      size: a.size ?? 0,
      attachmentId: a.id,
    }));
    return {
      ...summary,
      cc: recip(m.ccRecipients) || undefined,
      bodyText: isHtml ? undefined : m.body?.content,
      bodyHtml: isHtml ? m.body?.content : undefined,
      attachments,
      hasAttachments: attachments.length > 0,
    };
  }

  async send(ctx: ProviderContext, params: SendParams): Promise<SendResult> {
    const client = await this.graph(ctx);
    await client.api("/me/sendMail").post({
      message: {
        subject: params.subject,
        body: {
          contentType: params.html ? "HTML" : "Text",
          content: params.html ?? params.text ?? "",
        },
        toRecipients: toRecipients(params.to),
        ccRecipients: toRecipients(params.cc),
        bccRecipients: toRecipients(params.bcc),
      },
      saveToSentItems: true,
    });
    // Graph sendMail returns 202 with no body — no message id available.
    return {};
  }

  async reply(ctx: ProviderContext, params: ReplyParams): Promise<SendResult> {
    const client = await this.graph(ctx);
    const endpoint = params.replyAll
      ? `/me/messages/${params.messageId}/replyAll`
      : `/me/messages/${params.messageId}/reply`;
    await client.api(endpoint).post({
      comment: params.text ?? params.html ?? "",
    });
    return {};
  }

  async mark(ctx: ProviderContext, params: MarkParams): Promise<MarkResult> {
    const client = await this.graph(ctx);
    if (params.action === "trash") {
      await client
        .api(`/me/messages/${params.messageId}/move`)
        .post({ destinationId: "deleteditems" });
      return { messageId: params.messageId, action: params.action, ok: true };
    }
    const patch =
      params.action === "read"
        ? { isRead: true }
        : params.action === "unread"
          ? { isRead: false }
          : params.action === "flag"
            ? { flag: { flagStatus: "flagged" } }
            : { flag: { flagStatus: "notFlagged" } };
    await client.api(`/me/messages/${params.messageId}`).patch(patch);
    return { messageId: params.messageId, action: params.action, ok: true };
  }
}
