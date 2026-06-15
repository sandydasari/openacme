import type { EmailProviderName } from "../types.js";
import type { EmailProvider } from "./base.js";
import { ImapProvider } from "./imap.js";
import { GmailProvider, GMAIL_OAUTH_SCOPES } from "./gmail.js";
import { MicrosoftProvider, GRAPH_OAUTH_SCOPES } from "./microsoft.js";

export type { EmailProvider, ProviderContext } from "./base.js";
export { ImapProvider, GmailProvider, MicrosoftProvider };
export { GMAIL_OAUTH_SCOPES, GRAPH_OAUTH_SCOPES };

export const PROVIDER_NAMES = ["imap", "gmail", "microsoft"] as const;

export function createEmailProvider(name: EmailProviderName): EmailProvider {
  switch (name) {
    case "imap":
      return new ImapProvider();
    case "gmail":
      return new GmailProvider();
    case "microsoft":
      return new MicrosoftProvider();
  }
}
