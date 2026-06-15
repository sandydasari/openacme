import { z } from 'zod';
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Supported LLM provider identifiers — single source of truth.
 *
 * `PROVIDERS` is exported as a const tuple so consumers (Zod, the
 * `refresh-models` script, future provider-aware code) can derive both
 * the runtime list and the literal-narrowed `Provider` type from it.
 *
 * `REGISTRY_PROVIDERS` is the subset that has entries in the bundled
 * `model-registry.json` (data fetched from models.dev). Two providers
 * are intentionally absent:
 *   - `custom` — "bring-your-own base URL", not a real models.dev key.
 *     A user routing custom to an OpenAI-compatible Azure endpoint with
 *     `model: "gpt-4o"` still resolves via the suffix-match path inside
 *     `lookupModelMetadata` (matches `openai/gpt-4o`).
 *   - `ollama` — models.dev keys by API endpoint provider. Ollama is a
 *     local runtime; the same downloaded weight (llama3.1, qwen2.5,
 *     deepseek-r1, …) runs on Ollama, vLLM, LM Studio, llama.cpp, etc.
 *     and isn't owned by any single provider in the registry. Ollama
 *     users get `{}` from `lookupModelMetadata` and should set absolute
 *     `compressionThresholdTokens` in their behavior config; reactive
 *     413 / context_overflow recovery works regardless.
 *
 * The `refresh-models` script imports `REGISTRY_PROVIDERS` to filter the
 * upstream dump — keeping the enum and filter in sync at build time.
 */
export const PROVIDERS = [
  "openai",
  "anthropic",
  "openrouter",
  "google",
  "ollama",
  "custom",
] as const;
export type Provider = (typeof PROVIDERS)[number];
export const ProviderSchema = z.enum(PROVIDERS);

export const REGISTRY_PROVIDERS = [
  "openai",
  "anthropic",
  "openrouter",
  "google",
] as const satisfies readonly Provider[];

/**
 * Authentication mode for a model: API key (default) or OAuth subscription.
 * OAuth tokens live in `~/.openacme/auth.json` — see `@openacme/auth`.
 */
export const AuthModeSchema = z.enum(["api_key", "oauth"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

/**
 * Model configuration — which provider and model to use.
 *
 * `provider` and `model` are optional: the loader bootstraps them on first
 * boot from configured credentials (auth.json + env vars + .env) via
 * `detectConfiguredProvider`. When nothing is configured both stay undefined
 * and chat surfaces a clean "No model configured" error so the setup panel
 * picks up the state. Hardcoding a default here would silently route a user
 * with only an Anthropic key through OpenRouter (and into a confusing 401).
 */
export const ModelConfigSchema = z.object({
  provider: ProviderSchema.optional(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  auth: AuthModeSchema.default("api_key"),
  headers: z.record(z.string(), z.string()).optional(),
  // Anthropic prompt-cache breakpoint TTL. Honored on the native Anthropic
  // path and on OpenRouter+Claude; ignored on other providers. 1h costs 2×
  // input on writes vs 5m's 1.25×, but pays back across long agentic turns
  // where the prefix outlives the 5-minute window.
  cacheTtl: z.enum(["5m", "1h"]).default("5m"),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * Transport for an MCP server.
 *
 * - `stdio` — local subprocess; selected automatically when `command` is set.
 * - `http`  — Streamable HTTP (MCP spec rev 2025-03-26+).
 * - `sse`   — legacy HTTP+SSE; still supported for backwards-compat.
 *
 * When omitted on a URL-based server we try `http` first and fall back to
 * `sse` on a 404/405 from the POST /mcp endpoint (canonical "speaks SSE
 * only" signal). Set explicitly to skip auto-detect.
 */
export const MCPTransportSchema = z.enum(["http", "sse", "stdio"]);
export type MCPTransport = z.infer<typeof MCPTransportSchema>;

/**
 * MCP server configuration — how to connect to an external MCP server.
 *
 * Same JSON shape Claude Desktop / Cursor / Cline use, so users can
 * paste configs from anywhere. Lives at `<dataDir>/mcp.json` (catalog,
 * inherited by every agent) or per-agent for agent-private servers.
 */
export const MCPServerConfigSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    // Working directory for stdio servers. Most MCP servers take explicit
    // path args, but a few resolve relative paths from cwd (custom user
    // servers, some Python ones). Ignored for url-based transports.
    cwd: z.string().optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().positive().default(120),
    connectTimeout: z.number().positive().default(60),
    allowedTools: z.array(z.string()).optional(),
    // `enabled.default(true)` is load-bearing: every config in the wild
    // predates this field and must keep connecting on upgrade.
    enabled: z.boolean().default(true),
    transport: MCPTransportSchema.optional(),
  })
  // Catches the "neither command nor url" config at validation time
  // instead of at connect time — tighter feedback for both the API and
  // the YAML/JSON loaders.
  .refine((cfg) => Boolean(cfg.command) || Boolean(cfg.url), {
    message: "MCP server must specify either 'command' (stdio) or 'url' (HTTP/SSE)",
  });
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

/**
 * Per-agent browser overrides. Provider selection stays workforce-wide
 * (`config.browser.provider`); profile bindings are per-agent so each
 * agent has its own cookies / login state. Same idea as
 * `<agentDir>/browser-profiles/` for the local provider — each agent
 * gets its own remote profile on cloud providers.
 *
 * Namespaced by provider so settings stay grouped (and adding a new
 * provider doesn't flatten its config into a soup of `xProfileId`,
 * `yProfileName` fields). Only the sub-block matching the active
 * provider is read at acquire time. Auto-provisioned at agent creation
 * time when the cloud provider needs upfront profile creation
 * (Browser Use); lazily filled on first acquire if missing.
 *
 * Example AGENT.md frontmatter:
 *
 *     browser:
 *       browserUse:
 *         profileId: 6c0cbf15-d470-4ca7-a90e-f7fea12f1d33
 *       firecrawl:
 *         profileName: redditor
 */
export const AgentBrowserOverridesSchema = z
  .object({
    browserUse: z
      .object({
        profileId: z
          .string()
          .optional()
          .describe(
            "Browser Use profile UUID for THIS agent. Sessions inherit the profile's cookies / saved logins. Auto-provisioned on agent creation when BROWSER_USE_API_KEY is set; lazily on first acquire otherwise."
          ),
      })
      .strict()
      .optional(),
    firecrawl: z
      .object({
        profileName: z
          .string()
          .optional()
          .describe(
            "Firecrawl profile name for THIS agent. Auto-creates on first session use. Defaults to the agent id when unset."
          ),
      })
      .strict()
      .optional(),
    browserbase: z
      .object({
        contextId: z
          .string()
          .optional()
          .describe(
            "Browserbase Context UUID for THIS agent. Sessions inherit the context's cookies / saved logins. Auto-provisioned on agent creation when BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID are set; lazily on first acquire otherwise."
          ),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AgentBrowserOverrides = z.infer<typeof AgentBrowserOverridesSchema>;

/**
 * Per-agent email binding — the agent's own mailbox identity. Non-secret
 * only; the IMAP password / OAuth tokens live in `<agentDir>/email.json`
 * (mode 0600), never here. Each agent picks its own provider, so agent A can
 * be on Gmail while agent B is on a self-hosted IMAP host.
 */
export const AgentEmailSchema = z
  .object({
    provider: z.enum(["imap", "gmail", "microsoft"]),
    address: z.string().describe("The agent's email address."),
    host: z.string().optional().describe("IMAP only: IMAP server hostname."),
    port: z.number().optional().describe("IMAP only: IMAP port (default 993)."),
    user: z
      .string()
      .optional()
      .describe("IMAP only: login user (defaults to `address`)."),
    smtpHost: z
      .string()
      .optional()
      .describe("IMAP only: SMTP server hostname (defaults to `host`)."),
    smtpPort: z
      .number()
      .optional()
      .describe("IMAP only: SMTP port (default 587)."),
    tls: z
      .boolean()
      .optional()
      .describe(
        "IMAP only: implicit TLS (default true, port 993). Set false for a STARTTLS host (port 143) — the client still upgrades to TLS."
      ),
  })
  .strict();
export type AgentEmail = z.infer<typeof AgentEmailSchema>;

/**
 * Agent definition — a named agent with its own config.
 */
export const AgentDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Visual identity for UI surfaces (rosters, session rows, pickers).
  // A text glyph (typically an emoji), or `icon:<name>` from the web
  // UI's bundled icon set. Clients fall back to a generic agent icon
  // when absent or when they can't render the value (e.g. TUI + icons).
  avatar: z.string().optional(),
  // Description of this agent for their coworkers in the workforce.
  // Read in third-person ("this agent owns X, handles Y, redirects Z
  // to @other"). Distinct from `persona` (second-person, the agent's
  // own instructions). Paragraph-length — 2-5 sentences. `.default("")`
  // keeps existing on-disk AGENT.md files valid without migration.
  role: z
    .string()
    .default("")
    .describe(
      "Paragraph-length description of this agent for their coworkers (other agents " +
        "in the workforce). Recommended shape: what they own, what they handle well, " +
        "where to redirect work that isn't theirs. Distinct from `persona` (the " +
        "agent's own system prompt body in second-person). Read in third-person."
    ),
  // Optional per-agent override. When absent, the root `config.yaml`'s
  // `model` is used at agent-manager resolution time. Don't prefault
  // here — that would silently bake the schema's hardcoded defaults
  // (openrouter / sonnet-4-20250514) into every agent that didn't
  // override, ignoring the root config.
  model: ModelConfigSchema.optional(),
  persona: z.string().default("You are a helpful AI assistant."),
  // Environment-touching tools the agent may use. Introspection /
  // self-management tools (`skill_view`, `memory`, `session_search`,
  // `task_*`) are NOT listed here — they're merged in unconditionally
  // by `AgentManager` from `SYSTEM_TOOLS` in `@openacme/tools`. Don't
  // duplicate them here or the on-disk file ends up with redundant entries.
  tools: z
    .array(z.string())
    .default([
      "shell",
      "read_file",
      "write_file",
      "edit",
      "apply_patch",
      "list_files",
      "search_files",
      "web_search",
      "web_extract",
      "execute_code",
      "process",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press_key",
      "browser_take_screenshot",
      "browser_wait_for",
      "browser_evaluate",
      "browser_console_messages",
      "browser_tabs",
      "browser_act",
      "email_list",
      "email_search",
      "email_read",
      "email_send",
      "email_reply",
      "email_mark",
    ]),
  // Agent-PRIVATE MCP servers — names must not collide with the global
  // catalog at `<dataDir>/mcp.json`. The agent-store enforces this on
  // write; the manager re-checks defensively when assembling the union.
  mcpServers: z.record(z.string(), MCPServerConfigSchema).default({}),
  // Names of global mcp.json servers this agent should NOT receive.
  // Empty (default) = inherit everything.
  mcpDisabled: z.array(z.string()).default([]),
  // Per-agent skills allowlist. `[]` (default) means the agent sees every
  // installed skill in the workforce. Non-empty restricts to just those
  // names. Edit-form picker, not exposed in the catalog import form.
  skills: z.array(z.string()).default([]),
  // Heartbeat / failsafe probe cadence (milliseconds). When an
  // autonomous turn ends with eligible non-terminal work AND the agent
  // didn't call `sleep` to set a per-turn override, the scheduler will
  // re-wake this session after this interval to ensure tasks don't sit
  // forever waiting on a missed event. Default 30 min. Minimum 60s
  // (cost bound); use `sleep("never")` for max-24h sparse polling.
  probeIntervalMs: z
    .number()
    .int()
    .min(60_000)
    .default(30 * 60 * 1000),
  // Platform-managed agent. Optional + truthy semantics: present + true
  // means catalog-owned (refreshed in place on platform self-update; API
  // and web UI reject mutations). Absent or false means user-owned.
  // Optional rather than .default(false) so user-authored AGENT.md files
  // don't grow a noisy `managed: false` line on every save.
  managed: z.boolean().optional(),
  // Per-agent browser overrides. Provider stays workforce-wide; profile
  // bindings live here so each agent's cookies / login state are isolated.
  // Same idea as `<agentDir>/browser-profiles/` for the local provider —
  // each agent gets its own remote profile on cloud providers.
  browser: AgentBrowserOverridesSchema.optional(),
  // Per-agent email mailbox. Absent → the agent has no email and its
  // `email_*` tools are excluded from its tool set by AgentManager. Provider
  // + address are per-agent; secrets live in `<agentDir>/email.json` (0600).
  email: AgentEmailSchema.optional(),
  // Extra filesystem grants beyond the compiled default policy. Human-edited
  // in AGENT.md only — grants come from definitions, never from agents. A
  // bare relative path resolves under the data dir; `~` and absolute work too.
  // `rw` re-opens writes (and reads) for the path; `ro` re-opens reads only.
  // Grants subtract from the SOFT denies (config surfaces, AGENTS.md,
  // coworkers' dirs, team rooms) — they can NEVER reach the hard denies
  // (secrets, coworkers' minds/mailbox, the agent's own AGENT.md).
  paths: z
    .array(
      z.object({
        path: z.string().min(1),
        access: z.enum(["ro", "rw"]),
      })
    )
    .default([]),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/**
 * Team definition — a roster, a charter, and a shared workspace.
 * Lives at `<dataDir>/teams/<id>/TEAM.md` (frontmatter + markdown body)
 * with a sibling `workspace/` directory shared by all members.
 *
 * TEAM.md is human-owned: it's written via HTTP/web/disk only — there is
 * deliberately no agent tool that edits it, because the charter body is
 * injected into every member's system prompt (an agent-writable charter
 * would be a cross-agent prompt-injection channel).
 */
export const TeamDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Agent ids. Validated for shape, not existence — a team may reference
  // an agent created later; consumers filter against live agents.
  members: z.array(z.string()).default([]),
  // Archived teams drop out of member prompts and lose write access;
  // the workspace stays readable so old path references don't rot.
  // Optional + truthy semantics (same idiom as AgentDefinition.managed)
  // so hand-authored TEAM.md files don't grow noisy `archived: false`.
  archived: z.boolean().optional(),
  // Routing default, not authority: a task created with this team and no
  // explicit assignee lands on the manager for triage. Must be a member.
  manager: z.string().min(1).nullable().optional(),
  // Markdown body of TEAM.md — the team's shared context, injected into
  // member prompts between AGENTS.md (org) and persona (individual).
  charter: z.string().default(""),
});
export type TeamDefinition = z.infer<typeof TeamDefinitionSchema>;

/**
 * Server configuration.
 */
export const ServerConfigSchema = z.object({
  port: z.number().default(3456),
  host: z.string().default("127.0.0.1"),
  // Force the email/password flow even on a loopback bind. Default false:
  // local installs are zero-credential (the daemon auto-establishes a session
  // for loopback requests). A non-loopback bind always requires auth
  // regardless of this flag.
  requireAuth: z.boolean().default(false),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Per-model metadata. Vercel AI SDK's `LanguageModelV1`/`V2` doesn't
 * expose any of these — we look them up here.
 *
 * Source of truth: `data/model-registry.json` in this package,
 * a bundled snapshot of https://models.dev/api.json (community-maintained,
 * AI SDK-aligned). Refresh on demand via
 * `pnpm --filter @openacme/config refresh-models`.
 *
 * The JSON lives outside `src/` so `tsc --build` doesn't have to copy it
 * into `dist/` — we resolve the path relative to `import.meta.url` and
 * `readFileSync` at module load time.
 *
 * All fields optional — refresh script populates whatever models.dev
 * exposes for that model. Consumers (compression, future cost display,
 * future modality routing) read defensively.
 */
export const ModelMetadataSchema = z.object({
  /** Max input tokens. Source: `limit.context`. */
  contextWindow: z.number().optional(),
  /** Max output tokens per call. Source: `limit.output`. */
  maxOutputTokens: z.number().optional(),
  /** USD per million input tokens. Source: `cost.input`. */
  inputCostPerMTok: z.number().optional(),
  /** USD per million output tokens. Source: `cost.output`. */
  outputCostPerMTok: z.number().optional(),
  /** USD per million cached-read input tokens. Source: `cost.cache_read`. */
  cacheReadCostPerMTok: z.number().optional(),
  /** USD per million cache-write input tokens. Source: `cost.cache_write`. */
  cacheWriteCostPerMTok: z.number().optional(),
  /** Allowed input modalities — e.g. ["text", "image", "pdf"]. */
  inputModalities: z.array(z.string()).optional(),
  /** Allowed output modalities — e.g. ["text"]. */
  outputModalities: z.array(z.string()).optional(),
  /** Model accepts file attachments. */
  supportsAttachment: z.boolean().optional(),
  /** Model emits interleaved reasoning blocks (Anthropic style). */
  supportsReasoning: z.boolean().optional(),
  /** Model supports OpenAI-style tool calls. */
  supportsToolCall: z.boolean().optional(),
  /** Model honors `temperature` (some Kimi/o1-class models ignore it). */
  supportsTemperature: z.boolean().optional(),
  /** Family/series id — e.g. "claude-opus", "gpt-4". */
  family: z.string().optional(),
  /** Knowledge cutoff date (ISO yyyy-mm-dd). */
  knowledgeCutoff: z.string().optional(),
  /** Whether weights are open. */
  openWeights: z.boolean().optional(),
});
export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;

// Resolve `data/model-registry.json` relative to this module so it
// works in dev (`src/schema.ts` → `../data/...`) and after build
// (`dist/schema.js` → `../data/...`). The `data/` dir is shipped via the
// `files` array in package.json, so npm consumers see it too.
const REGISTRY: Record<string, ModelMetadata> = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataPath = join(here, "..", "data", "model-registry.json");
  return JSON.parse(readFileSync(dataPath, "utf-8")) as Record<
    string,
    ModelMetadata
  >;
})();

/**
 * Resolve metadata for a given model config. Looks up the bundled
 * snapshot, in order:
 *
 *   1. `${provider}/${model.model}` — canonical key in the snapshot.
 *   2. Suffix match on the bare model id — registry keys are
 *      `provider/modelId`; we match a config like
 *      `{ provider: "custom", model: "gpt-4o" }` against `openai/gpt-4o`.
 *      Useful for the `custom` provider routing to OpenAI-compatible
 *      endpoints (Azure OpenAI, vLLM with same model name, etc.).
 *   3. Prefix match — handles versioned ids like
 *      `claude-opus-4-7-20251201` matching `anthropic/claude-opus-4-7`.
 *      Only matches when the registry key is followed by `-` in the
 *      resolved id, so `claude-3` doesn't accidentally match
 *      `claude-3-5-sonnet`.
 *   4. Fallback: `{}`.
 *
 * Synchronous: the registry JSON is loaded once at module init.
 */
export function lookupModelMetadata(model: ModelConfig): ModelMetadata {
  const qualified = `${model.provider}/${model.model}`;
  const direct = REGISTRY[qualified];
  if (direct) return direct;
  const bareSuffix = `/${model.model}`;
  for (const [k, v] of Object.entries(REGISTRY)) {
    // Exact suffix match: `openai/gpt-4o` ends with `/gpt-4o`.
    if (k.endsWith(bareSuffix)) return v;
  }
  for (const [k, v] of Object.entries(REGISTRY)) {
    // Versioned-id prefix match: `anthropic/claude-opus-4-7` is a prefix
    // of `anthropic/claude-opus-4-7-20251201`.
    if (qualified.startsWith(k + "-")) return v;
  }
  return {};
}

/**
 * Agent behavior configuration.
 *
 * Compression (Hermes-style): when a turn's `usage.inputTokens` crosses
 * the threshold, the agent forks the session synchronously at end-of-turn.
 * The fork:
 *   1. Pre-prunes old tool results (dedup, 1-line summaries, JSON arg trim)
 *   2. Cuts the head/tail boundary by token budget, anchored to the most
 *      recent user message so a tool-call/result pair never splits
 *   3. Summarizes the older portion via auxiliary model (or main model on
 *      aux-model failure), with iterative UPDATE prompts on subsequent
 *      compressions
 *   4. Builds a new child session with [pre-pruned head, summary, pre-pruned tail]
 *
 * Trigger: set `compressionThresholdTokens` for an absolute threshold, OR
 * `compressionThresholdPercent` (in which case the resolved context window
 * comes from `modelRegistry[model].contextWindow`). When both are set,
 * the absolute wins. Both null disables proactive compression; reactive
 * compression on provider 413 / context_overflow errors still fires.
 */
export const AgentBehaviorSchema = z.object({
  // Per-call output cap. Without this the Anthropic SDK auto-picks the
  // model's published max (e.g. 128K for opus-4-7) — fine on 1M-context
  // accounts but on a 200K-entitled account it eats nearly the whole
  // budget and "Request size exceeds model context window" kicks in
  // before compression can help. 16K is a sane default for tool-use
  // turns; raise for long-form generation workloads.
  maxOutputTokens: z.number().default(16384),
  // Trigger. Default `compressionThresholdPercent: 0.5` enables proactive
  // compression at half the model's context window for any model present
  // in the bundled registry. Models without a registry entry fall through
  // silently — set `compressionThresholdTokens` to opt those in absolutely.
  compressionThresholdTokens: z.number().nullable().default(null),
  compressionThresholdPercent: z.number().nullable().default(0.5),
  // Boundary
  compressionProtectFirstN: z.number().default(3),
  compressionTailTokenBudget: z.number().default(20000),
  // Summarizer. The 0.10–0.80 clamp guards against accidentally requesting
  // a 5%-ratio summary (loses everything) or 95% (defeats compression).
  compressionSummaryTargetRatio: z.number().min(0.1).max(0.8).default(0.2),
  compressionSummarizerInputCharBudget: z.number().default(80000),
  compressionSummarizerModel: ModelConfigSchema.optional(),
});
export type AgentBehavior = z.infer<typeof AgentBehaviorSchema>;

/**
 * Skills configuration.
 */
export const SkillsConfigSchema = z.object({
  directory: z.string().default("skills"),
  autoGenerate: z.boolean().default(false),
});
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

/**
 * Web tools configuration — search provider + key resolution.
 * If `searchApiKey` is unset the agent reads from env vars at call-time
 * (OPENACME_SEARCH_API_KEY, then TAVILY_API_KEY / EXA_API_KEY / BRAVE_API_KEY).
 */
export const WebConfigSchema = z.object({
  searchProvider: z.enum(["tavily", "exa", "brave"]).default("tavily"),
  searchApiKey: z.string().optional(),
});
export type WebConfig = z.infer<typeof WebConfigSchema>;

/**
 * Browser configuration — per-agent sessions via a pluggable provider.
 *
 * Each agent that uses a browser tool gets its OWN session under the
 * selected provider: separate Chrome process + user-data-dir at
 * `<dataDir>/agents/<id>/browser-profile/` for the local provider, or a
 * separate cloud session for browserbase / browser-use / firecrawl.
 * Cloud providers read their credentials from env vars at first call.
 * Local Chrome is headed by default so the user can log in per agent;
 * flip `headless: true` for server / CI deployments.
 */
export const BrowserConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z
    .enum(["local", "browserbase", "browser-use", "firecrawl"])
    .default("local")
    .describe(
      "Which backend supplies each agent's browser. 'local' spawns Chrome per agent; the cloud providers create one remote session per agent."
    ),
  localBrowser: z
    .enum(["chromium", "camoufox"])
    .default("chromium")
    .describe(
      "Local provider only: which browser to run. 'chromium' prefers a system Chrome/Brave/Edge install and falls back to Playwright's auto-installed Chromium. 'camoufox' uses the Firefox-based stealth browser; the binary auto-downloads on first use."
    ),
  executablePath: z
    .string()
    .optional()
    .describe(
      "Local provider only: explicit path to a Chromium-family binary. When set, overrides `localBrowser`. Useful for custom builds or pinning a specific version."
    ),
  headless: z
    .boolean()
    .default(false)
    .describe(
      "Local provider only: run each agent's Chrome without a visible window. Default false — the user typically needs to see the window to log in to sites the agent will operate on."
    ),
  noSandbox: z
    .boolean()
    .default(false)
    .describe(
      "Local provider only: pass --no-sandbox to Chrome. Required when running as root in Docker / certain CI images."
    ),
});
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

/**
 * Workforce-wide email config. Per-agent mailboxes are bound in each
 * AGENT.md (`email:` block) with secrets in `<agentDir>/email.json`. The
 * only thing that lives here is the BYO OAuth app credentials shared across
 * agents — one Google / Microsoft app authorizes many agent mailboxes.
 * These app credentials are sensitive; prefer env-var injection and keep
 * config.yaml readable only by the daemon user.
 */
export const EmailConfigSchema = z.object({
  // Default IMAP/SMTP connection settings inherited by per-agent `imap`
  // mailboxes that omit them — so a workforce on one mail host sets host/port
  // once here and each agent only supplies its own address + app-password.
  // Credentials are NEVER global; only these non-secret coordinates.
  imap: z
    .object({
      host: z.string().optional(),
      port: z.number().optional(),
      smtpHost: z.string().optional(),
      smtpPort: z.number().optional(),
      tls: z.boolean().optional(),
    })
    .optional(),
  google: z
    .object({
      clientId: z.string(),
      clientSecret: z.string(),
    })
    .optional()
    .describe("BYO Google OAuth app (Gmail API) — your own client credentials."),
  microsoft: z
    .object({
      clientId: z.string(),
      clientSecret: z.string(),
      tenant: z.string().optional(),
    })
    .optional()
    .describe("BYO Microsoft Entra app (Graph) — your own client credentials."),
});
export type EmailConfig = z.infer<typeof EmailConfigSchema>;

/**
 * Root configuration schema — maps to config.yaml
 *
 * Agents are not stored here. They live as folders under
 * `<dataDir>/agents/<id>/AGENT.md`, one folder per agent. Any `agents:`
 * key in older configs is silently ignored by Zod's default object stripping.
 */
export const ConfigSchema = z.object({
  dataDir: z.string().default("~/.openacme"),
  model: ModelConfigSchema.prefault({}),
  server: ServerConfigSchema.prefault({}),
  behavior: AgentBehaviorSchema.prefault({}),
  skills: SkillsConfigSchema.prefault({}),
  web: WebConfigSchema.prefault({}),
  browser: BrowserConfigSchema.prefault({}),
  email: EmailConfigSchema.prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;
