import { awaitLoopbackCallback } from "./loopback.js";
import { generateChallenge, generateState, generateVerifier } from "./pkce.js";
import { looksHeadless, openBrowser } from "./browser.js";
import { extractEmailOrUpn } from "./jwt.js";
import type { OAuthFlowResult } from "./oauth-google.js";

const DEFAULT_PORT = 4570;
const DEFAULT_SCOPES = [
  "Mail.ReadWrite",
  "Mail.Send",
  "offline_access",
  "openid",
  "email",
];

export interface MicrosoftAuthorizeOptions {
  /** BYO Microsoft Entra app credentials. */
  clientId: string;
  clientSecret: string;
  /** Entra tenant; "common" supports personal + work/school accounts. */
  tenant?: string;
  /** Loopback port; the redirect URI is derived from it. Default 4570. */
  port?: number;
  scopes?: string[];
  onAuthUrl?: (url: string) => void;
  timeoutMs?: number;
}

/** The loopback redirect URI for the CLI flow. */
export function microsoftRedirectUri(port: number = DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}/auth/callback`;
}

function authBase(tenant?: string): string {
  return `https://login.microsoftonline.com/${tenant ?? "common"}/oauth2/v2.0`;
}

export function buildMicrosoftAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  challenge: string;
  state: string;
  tenant?: string;
}): string {
  const u = new URL(`${authBase(opts.tenant)}/authorize`);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", opts.scopes.join(" "));
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("response_mode", "query");
  return u.toString();
}

export async function exchangeMicrosoftCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  redirectUri: string;
  scopes: string[];
  tenant?: string;
}): Promise<OAuthFlowResult> {
  const res = await fetch(`${authBase(opts.tenant)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      code_verifier: opts.verifier,
      grant_type: "authorization_code",
      redirect_uri: opts.redirectUri,
      scope: opts.scopes.join(" "),
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Microsoft token exchange failed: ${res.status} ${await res.text()}`
    );
  }
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: tok.expires_in
      ? Math.floor(Date.now() / 1000) + tok.expires_in
      : undefined,
    account_id: extractEmailOrUpn(tok.id_token),
  };
}

export async function oauthAuthorizeMicrosoft(
  opts: MicrosoftAuthorizeOptions
): Promise<OAuthFlowResult> {
  const port = opts.port ?? DEFAULT_PORT;
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  const redirectUri = microsoftRedirectUri(port);
  const verifier = generateVerifier();
  const challenge = generateChallenge(verifier);
  const state = generateState();

  const url = buildMicrosoftAuthorizeUrl({
    clientId: opts.clientId,
    redirectUri,
    scopes,
    challenge,
    state,
    tenant: opts.tenant,
  });
  opts.onAuthUrl?.(url);
  const callback = awaitLoopbackCallback({
    port,
    expectedState: state,
    timeoutMs: opts.timeoutMs,
  });
  if (!looksHeadless()) openBrowser(url);
  const { code } = await callback;

  return exchangeMicrosoftCode({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    code,
    verifier,
    redirectUri,
    scopes,
    tenant: opts.tenant,
  });
}
