import { useEffect } from "react";

const AUTH_STORAGE_KEY = "openacme-auth";

// Public auth pages — a 401 here must NOT trigger the /login redirect, or a
// background API call nests `?next=/login?next=…` into an infinite loop.
const AUTH_REDIRECT_SKIP = new Set(["/login", "/setup", "/enroll"]);

/**
 * Wrap window.fetch once on mount so every API call:
 *   1. sends the session cookie (credentials: "include")
 *   2. injects `Authorization: Bearer <secret>` when localStorage has one
 *      — iOS standalone PWAs run in their own cookie jar separate from
 *      Safari and sometimes evict cookies between launches; localStorage
 *      is the persistence layer that actually sticks. The server accepts
 *      either path (see middleware/auth.ts).
 *   3. on 401 from /api/* (excluding /api/auth/*), redirects the browser
 *      to /login with a `next` param so the user lands back where they
 *      were trying to go.
 */
export function AuthFetch(): null {
  useEffect(() => {
    const original = window.fetch;
    const wrapped: typeof fetch = async (input, init) => {
      let token: string | null = null;
      try {
        token = window.localStorage.getItem(AUTH_STORAGE_KEY);
      } catch {
        // private mode / storage disabled — fall back to cookie-only.
      }
      const headers = new Headers(init?.headers ?? undefined);
      if (token && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${token}`);
      }
      const merged: RequestInit = {
        credentials: "include",
        ...init,
        headers,
      };
      const res = await original(input, merged);
      if (res.status === 401) {
        const urlString = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        const isApi = urlString.includes("/api/");
        const isAuth = urlString.includes("/api/auth/");
        if (isApi && !isAuth && typeof window !== "undefined") {
          // Stale token? Clear it so /login doesn't loop on a bad bearer.
          try {
            window.localStorage.removeItem(AUTH_STORAGE_KEY);
          } catch {
            // ignore
          }
          // Already on a public auth page — never redirect (a background
          // 401 there would nest `?next=/login?next=…` forever). Just clear
          // the token above and let the page handle its own auth state.
          const onAuthPage = AUTH_REDIRECT_SKIP.has(window.location.pathname);
          if (!onAuthPage) {
            const next = encodeURIComponent(
              window.location.pathname + window.location.search
            );
            window.location.href = `/login?next=${next}`;
          }
        }
      }
      return res;
    };
    window.fetch = wrapped;
    return () => {
      window.fetch = original;
    };
  }, []);
  return null;
}

/** Read the stored bearer token. Returns null when none / storage blocked. */
export function readStoredAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist the secret for the bearer fallback. Called after a successful
 *  login. The server also sets an HttpOnly cookie; this is the redundant
 *  layer that survives iOS standalone PWA cookie eviction. */
export function setStoredAuthToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTH_STORAGE_KEY, token);
  } catch {
    // ignore
  }
}

export function clearStoredAuthToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // ignore
  }
}
