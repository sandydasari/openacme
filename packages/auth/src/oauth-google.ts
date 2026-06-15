import { awaitLoopbackCallback } from "./loopback.js";
import { generateChallenge, generateState, generateVerifier } from "./pkce.js";
import { looksHeadless, openBrowser } from "./browser.js";
import { extractEmailOrUpn } from "./jwt.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_PORT = 4569;
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
];

/** Tokens produced by an OAuth authorization-code flow. The caller persists
 *  them (for email, into the agent's `email.json`). */
export interface OAuthFlowResult {
  access_token: string;
  refresh_token?: string;
  /** Unix seconds. */
  expires_at?: number;
  /** Resolved account email (from the id_token), when present. */
  account_id?: string;
}

export interface GoogleAuthorizeOptions {
  /** BYO Google OAuth app credentials (Desktop or Web client). */
  clientId: string;
  clientSecret: string;
  /** Loopback port; the redirect URI is derived from it. Default 4569. */
  port?: number;
  scopes?: string[];
  onAuthUrl?: (url: string) => void;
  timeoutMs?: number;
}

/** The loopback redirect URI for the CLI flow. */
export function googleRedirectUri(port: number = DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}/auth/callback`;
}

/** Build the Google authorize URL. Shared by the CLI loopback flow and the
 *  web redirect flow (which supplies its own server-hosted redirectUri). */
export function buildGoogleAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  challenge: string;
  state: string;
}): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", opts.scopes.join(" "));
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  // offline + consent are what make Google return a refresh_token.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

/** Exchange an authorization code for tokens. `redirectUri` must match the
 *  one used in the authorize request. */
export async function exchangeGoogleCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<OAuthFlowResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      code_verifier: opts.verifier,
      grant_type: "authorization_code",
      redirect_uri: opts.redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
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

/** CLI flow: open a browser, capture the code on a loopback server, exchange. */
export async function oauthAuthorizeGoogle(
  opts: GoogleAuthorizeOptions
): Promise<OAuthFlowResult> {
  const port = opts.port ?? DEFAULT_PORT;
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  const redirectUri = googleRedirectUri(port);
  const verifier = generateVerifier();
  const challenge = generateChallenge(verifier);
  const state = generateState();

  const url = buildGoogleAuthorizeUrl({
    clientId: opts.clientId,
    redirectUri,
    scopes,
    challenge,
    state,
  });
  opts.onAuthUrl?.(url);
  const callback = awaitLoopbackCallback({
    port,
    expectedState: state,
    timeoutMs: opts.timeoutMs,
  });
  if (!looksHeadless()) openBrowser(url);
  const { code } = await callback;

  return exchangeGoogleCode({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    code,
    verifier,
    redirectUri,
  });
}
