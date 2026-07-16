import { getEntry, clearEntry } from "./store.js";
import { refreshOpenAI } from "./oauth-openai.js";
import {
  isClaudeCodeEntryExpiring,
  refreshAnthropic,
  sameClaudeCodeAuthMaterial,
  tryReimportClaudeCode,
} from "./oauth-anthropic.js";
import { OAuthRelogin, type OAuthEntry, type OAuthProvider } from "./types.js";

const REFRESH_SKEW_SECONDS = 120;

/**
 * Per-provider in-flight refresh promise. Concurrent callers all await the
 * same promise so we never fire two refresh requests with the same
 * (rotating) refresh_token — that triggers `refresh_token_reused`.
 */
const inFlight: Partial<Record<OAuthProvider, Promise<OAuthEntry>>> = {};

function isExpiringSoon(entry: OAuthEntry): boolean {
  if (!entry.expires_at) return false;
  return entry.expires_at - Math.floor(Date.now() / 1000) < REFRESH_SKEW_SECONDS;
}

async function refreshOne(provider: OAuthProvider, dataDir: string): Promise<OAuthEntry> {
  if (provider === "openai") return refreshOpenAI(dataDir);
  return refreshAnthropic(dataDir);
}

export interface GetTokenOpts {
  /**
   * Force a refresh even if `expires_at` says the token is fresh. Used
   * when the provider rejected the previous token with 401 — the
   * expiry claim was wrong (token revoked, account swapped, rotated
   * elsewhere) and we want a fresh one before retrying.
   */
  force?: boolean;
}

/**
 * Returns a fresh access token for the given provider, refreshing if needed.
 * Throws OAuthRelogin if the session is unrecoverable.
 */
export async function getOAuthToken(
  provider: OAuthProvider,
  dataDir: string,
  opts: GetTokenOpts = {},
): Promise<{ token: string; accountId?: string }> {
  let entry = getEntry(dataDir, provider);

  // Anthropic auto-recovery: if no entry yet, the user may have logged in
  // via Claude Code without ever running `openacme login`. Try a silent
  // re-import before throwing the relogin error.
  if (!entry && provider === "anthropic") {
    if (tryReimportClaudeCode(dataDir)) {
      entry = getEntry(dataDir, provider);
    }
  }
  if (!entry) {
    throw new OAuthRelogin(provider, `Not signed in. Run \`openacme login --provider ${provider}\`.`);
  }

  if (opts.force || isExpiringSoon(entry)) {
    const beforeToken = entry.access_token;
    const beforeEntry = entry;
    let pending = inFlight[provider];
    if (!pending) {
      pending = refreshOne(provider, dataDir).finally(() => { delete inFlight[provider]; });
      inFlight[provider] = pending;
    }
    try {
      entry = await pending;
    } catch (e) {
      // Anthropic auto-recovery: refresh failed (e.g. user switched
      // Claude accounts in Claude Code, so the stored refresh_token
      // is invalid). Re-import CC creds — if they now point at a
      // different bearer than the one we just tried to refresh, use
      // them and skip clearEntry. All concurrent callers awaiting the
      // same failed pending promise hit this branch independently;
      // `tryReimportClaudeCode` is idempotent so the second+ caller
      // just sees the active token and decides based on the same
      // before/after comparison. The access token may stay the same while
      // Claude Code has rotated the refresh token or expiry metadata, so
      // compare the whole auth material, not only the bearer string.
      if (e instanceof OAuthRelogin && provider === "anthropic") {
        const active = tryReimportClaudeCode(dataDir);
        const fresh = active ? getEntry(dataDir, "anthropic") : undefined;
        if (fresh && fresh.access_token !== beforeToken) {
          return { token: fresh.access_token, accountId: fresh.account_id };
        }
        if (fresh && !sameClaudeCodeAuthMaterial(beforeEntry, fresh)) {
          if (!opts.force && !isClaudeCodeEntryExpiring(fresh)) {
            return { token: fresh.access_token, accountId: fresh.account_id };
          }
          try {
            const refreshed = await refreshOne(provider, dataDir);
            return { token: refreshed.access_token, accountId: refreshed.account_id };
          } catch (retryError) {
            if (retryError instanceof OAuthRelogin) {
              clearEntry(dataDir, provider);
            }
            throw retryError;
          }
        }
      }
      if (e instanceof OAuthRelogin) {
        clearEntry(dataDir, provider);
      }
      throw e;
    }
  }

  return { token: entry.access_token, accountId: entry.account_id };
}
