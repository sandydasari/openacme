import {
  wrapLanguageModel,
  defaultSettingsMiddleware,
  type LanguageModel,
} from "ai";
import { lookupModelMetadata } from "@openacme/config";
import type { ModelConfig, Provider } from "@openacme/config";
import { createLogger } from "@openacme/config/logger";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  getOAuthToken,
  OPENAI_INFERENCE_BASE_URL,
  readAuthFile,
  transformAnthropicOAuthBody,
  transformAnthropicOAuthResponse,
  transformCodexOAuthBody,
  tryReimportClaudeCode,
} from "@openacme/auth";
import {
  injectAnthropicCacheControl,
  injectUsageAccounting,
} from "./openrouter-cache.js";
import { anthropicCacheMiddleware } from "./anthropic-cache.js";

const log = createLogger("llm-provider");
const MAX_OAUTH_ERROR_BODY_CHARS = 4_000;

function resolveDataDir(): string {
  const fromEnv = process.env["OPENACME_DATA_DIR"];
  if (fromEnv && fromEnv.trim()) return fromEnv;
  // Fallback only used if neither CLI nor server set the env var.
  return `${process.env["HOME"] ?? ""}/.openacme`;
}

/**
 * Last-seen OAuth account_id per provider. Logged on change so the user
 * can see when a new login (or a different account) takes effect mid-run.
 */
const lastSeenAccount: Partial<Record<"openai" | "anthropic", string>> = {};

function noteAccount(
  provider: "openai" | "anthropic",
  accountId: string | undefined,
): void {
  const prev = lastSeenAccount[provider];
  const next = accountId ?? "(no-account-id)";
  if (prev === next) return;
  lastSeenAccount[provider] = next;
  if (prev) {
    // Body kept verbatim — documented in `.claude/rules/llm-provider.md`
    // as the breadcrumb users grep for.
    log.info(
      { provider, prev: maskAccount(prev), next: maskAccount(next) },
      `auth: ${provider} active account changed: ${maskAccount(prev)} → ${maskAccount(next)}`
    );
  } else {
    log.debug(
      { provider, account: maskAccount(next) },
      `auth: ${provider} active account ${maskAccount(next)}`
    );
  }
}

function maskAccount(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

async function logOpenAIOAuthErrorResponse(
  res: Response,
  url: string | URL
): Promise<void> {
  if (res.ok) return;
  let responseBody: string | undefined;
  try {
    responseBody = truncateDiagnostic(await res.clone().text());
  } catch (err) {
    responseBody = `<<failed to read response body: ${
      err instanceof Error ? err.message : String(err)
    }>>`;
  }
  log.warn(
    {
      provider: "openai",
      auth: "oauth",
      url: String(url),
      status: res.status,
      statusText: res.statusText,
      responseHeaders: pickDiagnosticHeaders(res.headers),
      responseBody,
    },
    "openai oauth error response"
  );
}

function pickDiagnosticHeaders(headers: Headers): Record<string, string> {
  const names = [
    "cf-ray",
    "openai-processing-ms",
    "x-openai-request-id",
    "x-request-id",
    "x-stainless-request-id",
  ];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

function truncateDiagnostic(value: string): string {
  return value.length <= MAX_OAUTH_ERROR_BODY_CHARS
    ? value
    : `${value.slice(0, MAX_OAUTH_ERROR_BODY_CHARS)}... [truncated]`;
}

/** Models that 400 if temperature/top_p/top_k are set. Mirrors Hermes' list. */
function anthropicForbidsSamplingParams(model: string): boolean {
  return ["4-7", "4.7"].some((s) => model.includes(s));
}

/**
 * Models that support 1M context via the `context-1m-2025-08-07` beta.
 * Opus/Sonnet 4.6+. Whether 1M actually activates is an account-level
 * entitlement — sending the beta on an unentitled account returns
 * "extra usage required", which we detect downstream and latch off for
 * the process. Anthropic's docs describe 4.7 as 1M-by-default at
 * standard pricing, but the rollout is tier-gated in practice — without
 * the beta header, accounts on the older tier silently cap at 200K.
 */
function anthropicSupports1mContext(model: string): boolean {
  const m = model.toLowerCase();
  if (!m.includes("opus") && !m.includes("sonnet")) return false;
  const ver = m.match(/(opus|sonnet)-(\d+)-(\d+)/);
  if (!ver) return false;
  const major = parseInt(ver[2]!, 10);
  const minor = parseInt(ver[3]!, 10);
  // Date suffixes like 20250514 are model versions, not minor; treat as 4.0
  const effMinor = minor > 99 ? 0 : minor;
  return major > 4 || (major === 4 && effMinor >= 6);
}

/** Opus 4.7 400s on `fine-grained-tool-streaming-2025-05-14`; mirror the SDK's per-model strip. */
function anthropicSupportsFineGrainedToolStreaming(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes("opus") && (m.includes("4-7") || m.includes("4.7"))) return false;
  return true;
}

/**
 * Per-process latch: set to true the first time an Anthropic request
 * with the 1M-context beta header comes back with "Extra usage required"
 * (the account-level entitlement isn't present). Future requests skip
 * the beta entirely. Resets on daemon restart — re-probe is one
 * transparent retry on the first request.
 */
let anthropic1mDisabled = false;
const ANTHROPIC_NO_1M_ENTITLEMENT_RX =
  /extra usage is required for long context|usage credits are required for long context|context_1m|long.?context.*not.*enabled/i;

/**
 * Public read of the 1M-entitlement latch. Returns true when this process
 * has confirmed (via a failed beta-header request) that the account is
 * actually capped at 200K for the given model. Compression's preflight
 * uses this to recompute its threshold against the real cap instead of
 * the registry's `contextWindow` value — the registry says 1M but the
 * API enforces 200K, so a 50% × 1M threshold (500K) would never fire
 * before the wall.
 */
export function isAnthropicLongContextDisabled(model: string): boolean {
  return anthropic1mDisabled && anthropicSupports1mContext(model);
}

/** Fallback ceiling for accounts without the 1M-context entitlement. */
const ANTHROPIC_LONG_CONTEXT_FALLBACK_TOKENS = 200_000;

/**
 * Effective per-request context window for a model config. Returns the
 * registry value normally; when the Anthropic 1M-latch has fired for
 * this process, Anthropic models that depend on the beta get clipped
 * to 200K (the standard-tier ceiling). `null` when no registry entry
 * exists (custom / ollama / unknown — caller falls through to reactive
 * 413 recovery).
 *
 * Mirrors hermes-agent's `conversation_loop.py:long_context_tier`
 * recovery path: when the API reports the account isn't entitled to
 * 1M, reduce the compressor's effective context to 200K so threshold
 * fires before the wall.
 */
export function getEffectiveContextWindow(config: ModelConfig): number | null {
  const meta = lookupModelMetadata(config);
  const base = meta.contextWindow ?? null;
  if (base == null) return null;
  if (
    config.provider === "anthropic" &&
    typeof config.model === "string" &&
    isAnthropicLongContextDisabled(config.model)
  ) {
    return Math.min(base, ANTHROPIC_LONG_CONTEXT_FALLBACK_TOKENS);
  }
  return base;
}

/**
 * Resolve whether a request should take the OAuth path. Honors the explicit
 * `config.auth === "oauth"` first; otherwise silently falls back to OAuth
 * when no API key is configured AND a token exists in auth.json. This makes
 * `openacme login` "just work" without requiring the agent definition to
 * carry an explicit `auth: oauth` field — which is the common case for
 * agents created via the web UI before it grew an auth-mode picker.
 */
function shouldUseOAuth(
  provider: "openai" | "anthropic",
  config: ModelConfig,
  envVar: string,
  dataDir: string,
): boolean {
  if (config.auth === "oauth") return true;
  if (config.apiKey || process.env[envVar]) return false;
  try {
    return !!readAuthFile(dataDir)[provider]?.access_token;
  } catch {
    return false;
  }
}

/**
 * How a call to this model is billed, for the usage ledger's `auth_mode`
 * column. `local` = no money moves (ollama); `oauth` = subscription-billed
 * (Claude Pro / ChatGPT — no marginal dollar cost); `api_key` = metered.
 * Uses the same resolution as the request path (`shouldUseOAuth`), so the
 * ledger row matches how the call was actually authenticated.
 */
export function resolveAuthMode(
  config: ModelConfig
): "api_key" | "oauth" | "local" {
  switch (config.provider) {
    case "ollama":
      return "local";
    case "openai":
      return shouldUseOAuth("openai", config, "OPENAI_API_KEY", resolveDataDir())
        ? "oauth"
        : "api_key";
    case "anthropic":
      return shouldUseOAuth(
        "anthropic",
        config,
        "ANTHROPIC_API_KEY",
        resolveDataDir()
      )
        ? "oauth"
        : "api_key";
    default:
      return "api_key";
  }
}

/**
 * Whether the active model's adapter accepts media (image / PDF) inside
 * `tool_result.content`. Derived by reading every installed adapter:
 *
 *   - Anthropic (native + OAuth): image ✓ and PDF ✓
 *   - OpenAI Responses API (ChatGPT OAuth / Codex): image ✓ and PDF ✓
 *   - OpenAI Chat Completions (API key path): silently stringifies
 *   - Google: image ✓; explicitly drops non-image file-data (so PDF ✗)
 *   - openai-compatible (OpenRouter, Ollama, custom): silently stringifies
 *
 * The synthetic-user-message injector in agent-core handles the fallback
 * paths — tools' `toModelOutput` checks this and only emits a content
 * array on the supported combos so the injector can do its job for the
 * rest without double-delivering.
 */
export function supportsToolResultMedia(
  config: ModelConfig,
  mediaType: "image" | "pdf"
): boolean {
  const dataDir = resolveDataDir();
  switch (config.provider) {
    case "anthropic":
      return true;
    case "openai":
      // Only the Responses API path (OAuth) accepts list-content in tool
      // results. The API-key path uses Chat Completions which stringifies.
      return shouldUseOAuth("openai", config, "OPENAI_API_KEY", dataDir);
    case "google":
      return mediaType === "image";
    case "openrouter":
    case "ollama":
    case "custom":
    default:
      return false;
  }
}

/** Strip temperature/top_p/top_k from an Anthropic body (Claude 4.7+ contract). */
function stripAnthropicSamplingParams(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    delete obj["temperature"];
    delete obj["top_p"];
    delete obj["top_k"];
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

/**
 * Provider-specific factory functions.
 * Each returns a Vercel AI SDK LanguageModel instance.
 *
 * Mirrors the Hermes pattern of using raw OpenAI SDK + base_url swapping,
 * but with proper provider-specific packages for better type safety.
 */
/**
 * Inside the factories we know `provider` and `model` are populated —
 * `getModel` narrows once at the boundary so factory bodies don't need
 * `config.model!` non-null assertions sprinkled everywhere. The schema
 * leaves both fields optional so first-run users without configured
 * credentials can still load a config without a hardcoded fallback model.
 */
type ResolvedModelConfig = ModelConfig & {
  provider: Provider;
  model: string;
};

const providerFactories: Record<
  Provider,
  (config: ResolvedModelConfig) => LanguageModel
> = {
  openai: (config) => {
    const dataDir = resolveDataDir();
    if (shouldUseOAuth("openai", config, "OPENAI_API_KEY", dataDir)) {
      const provider = createOpenAI({
        apiKey: "oauth-placeholder", // overridden by fetch
        baseURL: OPENAI_INFERENCE_BASE_URL,
        // Per-request token injection + refresh + body shape coercion.
        // The ChatGPT backend (chatgpt.com/backend-api/codex) requires
        // `store: false` and rejects the SDK's default `temperature: 0`.
        // OAuth↔API-key swap mid-run can't be honored here because the
        // base URL and request shape differ — that swap takes effect on
        // the next runStream when getModel re-resolves.
        fetch: async (url, init) => {
          const buildHeaders = async (force: boolean): Promise<Headers> => {
            const { token, accountId } = await getOAuthToken(
              "openai",
              dataDir,
              { force }
            );
            noteAccount("openai", accountId);
            const headers = new Headers(
              init?.headers as Record<string, string> | undefined
            );
            headers.set("Authorization", `Bearer ${token}`);
            if (accountId) headers.set("chatgpt-account-id", accountId);
            headers.set("OpenAI-Beta", "responses=experimental");
            return headers;
          };

          const newBody = transformCodexOAuthBody(init?.body);
          const rewritten = init && newBody !== init.body
            ? { ...init, body: newBody as RequestInit["body"] }
            : init;
          log.debug({ provider: "openai", url, body: rewritten?.body }, "outbound request");

          const send = async (force: boolean) =>
            fetch(url as string | URL, {
              ...rewritten,
              headers: await buildHeaders(force),
            });

          let res = await send(false);
          if (res.status === 401) {
            log.debug({ provider: "openai" }, "openai 401 — forcing token refresh and retrying");
            try {
              res = await send(true);
            } catch (e) {
              log.debug({ provider: "openai", err: e }, "openai refresh-on-401 failed");
              throw e;
            }
          }
          await logOpenAIOAuthErrorResponse(res, url as string | URL);
          return res;
        },
      });
      // ChatGPT backend speaks the Responses API. `store: false` propagates
      // into the SDK's message converter so it inlines function_call items
      // (not item_reference, which needs server-side persistence Codex lacks).
      return wrapLanguageModel({
        model: provider.responses(config.model),
        middleware: defaultSettingsMiddleware({
          settings: {
            providerOptions: { openai: { store: false } },
          },
        }),
      });
    }
    const provider = createOpenAI({
      apiKey: config.apiKey ?? process.env["OPENAI_API_KEY"],
      baseURL: config.baseUrl,
      headers: config.headers,
    });
    return provider(config.model);
  },

  anthropic: (config) => {
    const stripSampling = anthropicForbidsSamplingParams(config.model);
    const dataDir = resolveDataDir();
    // `isOAuth` is re-evaluated per-fetch below so a login/logout that
    // happens mid-run (between two HTTP requests of the same streamText
    // multi-step turn) takes effect on the very next request. The
    // construction-time `apiKey` is just a placeholder — the fetch hook
    // overwrites the auth header from scratch on every call.
    const provider = createAnthropic({
      apiKey: "oauth-placeholder",
      baseURL: config.baseUrl,
      fetch: async (url, init) => {
        // `isOAuth` is recomputed each call (see `shouldUseOAuth`) so a
        // login/logout that happens mid-run picks up on the very next
        // request without restarting streamText.
        const oauthNow = shouldUseOAuth(
          "anthropic",
          config,
          "ANTHROPIC_API_KEY",
          dataDir
        );

        // Captured by `buildHeaders` on each call, read by the 429
        // recovery branch below to compare "what we sent" vs. "what
        // tryReimport now offers." Differs → Claude Code swapped to a
        // new account; retry with the new bearer.
        let lastSentToken: string | undefined;

        const buildHeaders = async (force: boolean): Promise<Headers> => {
          const headers = new Headers(
            init?.headers as Record<string, string> | undefined
          );
          if (oauthNow) {
            const { token, accountId } = await getOAuthToken(
              "anthropic",
              dataDir,
              { force }
            );
            lastSentToken = token;
            noteAccount("anthropic", accountId);
            headers.delete("x-api-key");
            headers.set("Authorization", `Bearer ${token}`);
            headers.set("User-Agent", "claude-cli/2.1.74 (external, cli)");
            headers.set("x-app", "cli");
            const betas = new Set<string>([
              "interleaved-thinking-2025-05-14",
              "claude-code-20250219",
              "oauth-2025-04-20",
            ]);
            if (anthropicSupportsFineGrainedToolStreaming(config.model)) {
              betas.add("fine-grained-tool-streaming-2025-05-14");
            }
            // 1M context: do NOT opt in on OAuth. The 1M context window
            // is an account-level entitlement that ships with API-credit
            // billing tiers, not Claude Pro / Max subscriptions. Sending
            // the beta on a subscription account causes Anthropic to
            // reject every request with "Usage credits are required for
            // long context requests" (or the older "extra usage is
            // required" wording — error strings drift). 200K is plenty
            // for agent workflows; if a request genuinely needs 1M,
            // route it through api_key auth instead.
            const existing = headers.get("anthropic-beta");
            if (existing) for (const b of existing.split(",")) betas.add(b.trim());
            headers.set(
              "anthropic-beta",
              Array.from(betas).filter(Boolean).join(",")
            );
          } else {
            // API-key path. Strip any stale OAuth bearer the SDK may have
            // attached and set x-api-key from the current source so an
            // env-var change between requests is honored.
            headers.delete("Authorization");
            const key = config.apiKey ?? process.env["ANTHROPIC_API_KEY"];
            if (key) headers.set("x-api-key", key);
            else headers.delete("x-api-key");
            if (config.headers) {
              for (const [k, v] of Object.entries(config.headers)) {
                headers.set(k, v);
              }
            }
          }
          return headers;
        };

        let newBody: unknown = init?.body;
        if (oauthNow) {
          newBody = transformAnthropicOAuthBody(newBody);
        }
        if (stripSampling) {
          newBody = stripAnthropicSamplingParams(newBody);
        }
        const rewritten = init && newBody !== init.body
          ? { ...init, body: newBody as RequestInit["body"] }
          : init;
        log.debug({ provider: "anthropic", url, body: rewritten?.body }, "outbound request");

        const send = async (force: boolean) =>
          fetch(url as string | URL, {
            ...rewritten,
            headers: await buildHeaders(force),
          });

        let res = await send(false);
        // 401 on an OAuth call usually means the token was revoked
        // server-side (account swapped, rotated elsewhere, suspended)
        // before our `expires_at` claim caught up. Force-refresh once
        // and retry — if still 401, propagate so the user sees the
        // login prompt. `getOAuthToken` itself attempts a silent
        // Claude Code re-import on refresh failure (see
        // `@openacme/auth/refresh.ts`), so this branch covers both
        // "stored refresh_token still good" and "user just swapped
        // accounts in Claude Code" without extra work here.
        if (oauthNow && res.status === 401) {
          log.debug({ provider: "anthropic" }, "anthropic 401 — forcing token refresh and retrying");
          try {
            res = await send(true);
          } catch (e) {
            log.debug({ provider: "anthropic", err: e }, "anthropic refresh-on-401 failed");
            throw e;
          }
        }
        // 429 or 401 with OAuth: the account we're using is either
        // rate-capped (429) or its token expired between our refresh
        // probe and the API receipt (401). In both cases, the user may
        // have a fresher bearer in Claude Code (either a different
        // account they've since switched to, or just a refreshed token
        // CC managed on its own). Try a one-shot CC re-import; if the
        // active bearer differs from the one we just sent, retry with
        // it. If it doesn't differ, propagate the original status.
        if (oauthNow && (res.status === 429 || res.status === 401)) {
          const active = tryReimportClaudeCode(dataDir);
          if (active && active !== lastSentToken) {
            log.debug(
              { provider: "anthropic", status: res.status },
              "anthropic auth/rate retry — claude-code creds changed, retrying with new bearer"
            );
            res = await send(false);
          }
        }
        // 1M-context fallback: if the API rejects the beta because the
        // account lacks entitlement, latch it off for this process and
        // retry the same request without the beta header. Subsequent
        // requests skip the beta in `buildHeaders` from the start.
        if (
          !res.ok &&
          !anthropic1mDisabled &&
          anthropicSupports1mContext(config.model)
        ) {
          try {
            const body = await res.clone().text();
            if (ANTHROPIC_NO_1M_ENTITLEMENT_RX.test(body)) {
              anthropic1mDisabled = true;
              // Body kept verbatim — users grep for this string when
              // debugging context-size fallbacks.
              log.warn(
                { provider: "anthropic", contextWindow: 200_000 },
                "Anthropic 1M-context not entitled for this account; falling back to 200k for this and future requests."
              );
              res = await send(false);
            }
          } catch {
            // Body read errors fall through with the original response.
          }
        }
        // OAuth-only: strip the mcp_<PascalCase> prefix from tool names in the
        // response, otherwise the SDK's tool-call dispatcher fails with
        // AI_NoSuchToolError because the local registry holds unprefixed names.
        return oauthNow ? transformAnthropicOAuthResponse(res) : res;
      },
    });
    // Per-request cache markers: transformParams runs on every step of a
    // multi-step turn, so the cache frontier advances with the prompt tail.
    return wrapLanguageModel({
      model: provider(config.model),
      middleware: anthropicCacheMiddleware(config.cacheTtl),
    });
  },

  google: (config) => {
    const provider = createGoogleGenerativeAI({
      apiKey: config.apiKey ?? process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
      baseURL: config.baseUrl,
      headers: config.headers,
    });
    return provider(config.model);
  },

  openrouter: (config) => {
    const isClaudeModel =
      config.model.toLowerCase().startsWith("anthropic/") ||
      config.model.toLowerCase().includes("claude");
    const provider = createOpenAICompatible({
      name: "openrouter",
      apiKey: config.apiKey ?? process.env["OPENROUTER_API_KEY"],
      baseURL: config.baseUrl ?? "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://openacme.dev",
        "X-Title": "OpenAcme Agent",
        ...config.headers,
      },
      // Wire-level body rewrites the openai-compatible adapter can't do:
      // `usage: {include: true}` on every request (OpenRouter then reports
      // actual cost + cached tokens — the ledger's provider_reported
      // source), plus native `cache_control` markers for Claude-family
      // models (the adapter won't translate providerOptions for us).
      fetch: async (url, init) => {
        let newBody = injectUsageAccounting(init?.body);
        if (isClaudeModel) {
          newBody = injectAnthropicCacheControl(newBody, config.cacheTtl);
        }
        const rewritten =
          init && newBody !== init.body
            ? { ...init, body: newBody as RequestInit["body"] }
            : init;
        return fetch(url as string | URL, rewritten);
      },
    });
    return provider(config.model);
  },

  ollama: (config) => {
    const provider = createOpenAICompatible({
      name: "ollama",
      baseURL: config.baseUrl ?? "http://localhost:11434/v1",
      headers: config.headers,
    });
    return provider(config.model);
  },

  custom: (config) => {
    if (!config.baseUrl) {
      throw new Error("Custom provider requires a baseUrl");
    }
    const provider = createOpenAICompatible({
      name: "custom",
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      headers: config.headers,
    });
    return provider(config.model);
  },
};

/**
 * Get a Vercel AI SDK LanguageModel from a ModelConfig.
 * This is the primary entry point for LLM access across the platform.
 */
export function getModel(config: ModelConfig): LanguageModel {
  if (!config.provider || !config.model) {
    throw new Error(
      "No model configured. Add an API key or sign in via OAuth in Settings."
    );
  }
  const factory = providerFactories[config.provider];
  if (!factory) {
    throw new Error(`Unknown provider: ${config.provider}`);
  }
  return factory(config as ResolvedModelConfig);
}

/**
 * Provider information for display in UI/CLI.
 */
export interface ProviderInfo {
  id: Provider;
  name: string;
  requiresApiKey: boolean;
  envVar?: string;
  defaultBaseUrl?: string;
  /** Provider supports OAuth subscription login (ChatGPT Plus/Pro, Claude Pro/Max). */
  supportsOAuth?: boolean;
}

/**
 * List all supported providers.
 */
export function listProviders(): ProviderInfo[] {
  return [
    { id: "openai", name: "OpenAI", requiresApiKey: true, envVar: "OPENAI_API_KEY", supportsOAuth: true },
    { id: "anthropic", name: "Anthropic", requiresApiKey: true, envVar: "ANTHROPIC_API_KEY", supportsOAuth: true },
    { id: "google", name: "Google Gemini", requiresApiKey: true, envVar: "GOOGLE_GENERATIVE_AI_API_KEY" },
    { id: "openrouter", name: "OpenRouter", requiresApiKey: true, envVar: "OPENROUTER_API_KEY", defaultBaseUrl: "https://openrouter.ai/api/v1" },
    { id: "ollama", name: "Ollama (Local)", requiresApiKey: false, defaultBaseUrl: "http://localhost:11434/v1" },
    { id: "custom", name: "Custom (OpenAI-compatible)", requiresApiKey: false },
  ];
}
