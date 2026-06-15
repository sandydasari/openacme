export { EmailManager } from "./manager.js";
export type { EmailManagerOptions } from "./manager.js";
export {
  createEmailProvider,
  PROVIDER_NAMES,
  ImapProvider,
  GmailProvider,
  MicrosoftProvider,
  GMAIL_OAUTH_SCOPES,
  GRAPH_OAUTH_SCOPES,
} from "./providers/index.js";
export type { EmailProvider, ProviderContext } from "./providers/base.js";
export {
  readEmailCredentials,
  writeEmailCredentials,
  clearEmailCredentials,
} from "./credentials.js";
export type {
  EmailProviderName,
  EmailAccount,
  EmailCredentials,
  OAuthAppConfig,
  EmailAttachment,
  EmailSummary,
  EmailMessage,
  ListParams,
  SearchParams,
  SendParams,
  ReplyParams,
  SendResult,
  MarkAction,
  MarkParams,
  MarkResult,
} from "./types.js";
