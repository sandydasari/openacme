/**
 * Decode a JWT payload without verifying the signature.
 * Used to extract `chatgpt_account_id` / `email` for header injection and UX.
 *
 * Do NOT use this to make trust decisions. We trust the token because we
 * received it directly from the OAuth token endpoint over TLS.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract chatgpt_account_id from an OpenAI OAuth access_token / id_token. */
export function extractChatGptAccountId(accessToken: string, idToken?: string): string | undefined {
  for (const tok of [accessToken, idToken].filter(Boolean) as string[]) {
    const payload = decodeJwtPayload(tok);
    if (!payload) continue;
    // ChatGPT puts the id under different shapes in different tokens.
    const direct = payload["chatgpt_account_id"];
    if (typeof direct === "string" && direct) return direct;
    const auth = payload["https://api.openai.com/auth"];
    if (auth && typeof auth === "object") {
      const id = (auth as Record<string, unknown>)["chatgpt_account_id"];
      if (typeof id === "string" && id) return id;
    }
  }
  return undefined;
}

/** Best-effort email extraction for friendly login messages. */
export function extractEmail(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const payload = decodeJwtPayload(idToken);
  const email = payload?.["email"];
  return typeof email === "string" ? email : undefined;
}

/** Email, falling back to `preferred_username` (Microsoft id_tokens may carry
 *  only the UPN). Used to label an OAuth-connected mailbox. */
export function extractEmailOrUpn(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const payload = decodeJwtPayload(idToken);
  if (!payload) return undefined;
  if (typeof payload["email"] === "string") return payload["email"];
  if (typeof payload["preferred_username"] === "string") {
    return payload["preferred_username"];
  }
  return undefined;
}
