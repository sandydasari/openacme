# OpenAcme — Claude Code guide

TypeScript agent platform. Multi-provider LLM with streaming tool-calls, SQLite-backed sessions, MCP integration, OAuth (ChatGPT / Claude subscriptions), an Ink-based CLI TUI, and a Vite + TanStack Router web UI served by the Hono server.

**Design lens.** This is an *AI workforce* platform — a structured set of role-specialized agents working for a small human team — not a single-agent assistant. Each agent carries a `name`, a `role` (third-person paragraph for coworkers), and a `persona` (second-person system prompt), and owns its own config, model, tools, skills, MCP servers, sessions, tasks, memory, workspace, and resources. When designing new state or behavior, the question is "does this hold for N agents working in parallel under different roles?" — not "does this work for the agent." Anywhere you'd reach for a global table or a singleton, default to scoping by `agent_id` instead. Cross-agent work — one agent assigning a task to another, one agent looking up coworkers via `agent_list` — is a first-class primitive, so anything you add should be addressable by agent.

---

## Workspace layout

Turborepo + pnpm 9. Workspace globs: `apps/*`, `packages/*`. Published packages are `@openacme/*`; internal tooling is `@repo/*`.

```
apps/
  cli/          # `openacme` binary — Commander + Ink TUI + Clack setup
  web/          # Vite + TanStack Router SPA (chat/agents/skills UI); static-built into packages/server/web
  docs/         # Next.js docs site (placeholder)

packages/
  agent-core/   # Agent class — agentic loop, streaming, history reconstruction
  server/       # Hono HTTP server + AgentManager (multi-agent orchestration)
  cli (apps)    # see above
  llm-provider/ # getModel() — OpenAI / Anthropic / Google / OpenRouter / Ollama / custom
  mcp-client/   # MCP stdio + HTTP/SSE transports; tool discovery into registry
  tools/        # ToolRegistry + built-ins (shell, read_file, write_file, edit,
                #   apply_patch, list_files, search_files, session_search, skill_view,
                #   web_search, web_extract, execute_code, process, memory, task_*,
                #   agent_list, browser_*)
  browser/      # Per-agent browser sessions via pluggable provider (local Chrome / Browserbase / Browser-Use / Firecrawl)
  db/           # better-sqlite3 + Drizzle; sessions/messages/user_profiles +
                #   task_comments/task_events + FTS5 (agents are filesystem-backed
                #   under <dataDir>/agents/, not in the DB)
  memory/       # Per-agent persistent MEMORY.md store (Anthropic memory_20250818 +
                #   Claude Code index/topic-file convention)
  tasks/        # Workforce task store (filesystem; isolation by assignee)
  config/       # Zod schema + YAML/JSON loader (~/.openacme/config.yaml)
  auth/         # OAuth (ChatGPT subscription, Claude Pro), token store, body/response
                #   transforms, refresh
  skills/       # SKILL.md discovery, progressive disclosure + multi-source hub
                #   (GitHub, marketplaces, URL, well-known, local, builtin) under hub/;
                #   bundled skills live at packages/skills/builtin/<name>/
  agent-catalog/# Bundled agent templates (Software Engineer, …) — Importable via web or CLI
  ui/           # Shared React components (minimal)
  eslint-config, typescript-config   # @repo/* internal
```

Default data dir: `~/.openacme/` (`config.yaml`, `auth.json` mode 0600, `state.db`, `AGENTS.md`, `agents/<id>/{AGENT.md,workspace/,resources/,memory/,browser-profiles/{chromium,firefox}/}`, `tasks/<id>.md`, `skills/`).
Default server: `127.0.0.1:3456`. Default model: `openrouter` + `anthropic/claude-sonnet-4-20250514`.

---

## The agent loop — request path

User message → response, end-to-end. **SSE is the only delivery channel for an agent turn** — interactive and autonomous turns share one streaming model. The originating tab is just another subscriber to the per-session SSE channel.

1. **Web** `apps/web/app/routes/index.tsx` manages `messages` state directly; `useLiveSession` opens an `EventSource` to `/api/sessions/:id/stream` keyed on `activeSessionId` and waits for `connected: true` before posting. For a fresh chat the client mints sessionId + user-message id (`crypto.randomUUID`) so the SSE subscription can open BEFORE the first POST.
2. **POST** `/api/chat` with `{ agentId, sessionId, messages: UIMessage[] }`:
   - Validates pending FileUIPart URLs, then `commit()`s them (moves bytes from `<dataDir>/attachments/__pending__/` to `<sessionId>/<attId>/<filename>`) and rewrites each part's URL.
   - Provider-gates non-text parts via `lookupModelMetadata(...).inputModalities`.
   - Ensures the session row exists with the caller-supplied id; persists + broadcasts the user message (`messages_appended`).
   - Stores an `AbortController` in the per-session `activeTurns` map.
   - Kicks off `runChatTurn(...)` in the **background** and returns `{ sessionId, userMessageId, assistantMessageId }` JSON immediately.
3. **`runChatTurn`** (helper at bottom of `app.ts`):
   - Marks interactive-busy, broadcasts `session_state: running`.
   - Wraps `Agent.runStream` chunks with `createUIMessageStream` purely for its onFinish assembly. Each chunk is broadcast as `ui_message_part`; the wrapper's own output stream is drained and discarded.
   - On finish: persists the assistant UIMessage, broadcasts `messages_appended` for it, broadcasts `session_state: idle` (**after** persist — the client's running→idle refetch must not race the DB write).
   - Fires extractor + title fire-and-forget.
4. **Cancel:** `DELETE /api/sessions/:id/active-turn` aborts the controller. The stop button uses this; it's the only cancel path because the POST already returned.
5. **AgentManager** `packages/server/src/agent-manager.ts` lazy-creates the `Agent` from the agent definition.
6. **Agent.runStream** (`packages/agent-core/src/agent.ts`):
   - `uiToModelMessages(history, { attachmentsRoot, tools })` — `inlineFileAttachments` rewrites `/api/attachments/...` URLs to `data:` URLs (providers can't reach 127.0.0.1), then defers to SDK's `convertToModelMessages`.
   - Builds + caches the system prompt per `sessionId` (`prompt.ts`); persisted via `sessionStore.updateSystemPrompt`. **Manual** invalidation via `invalidateSystemPromptCache()`.
   - `streamText({ model, system, messages, tools, stopWhen: stepCountIs(maxSteps), abortSignal })`.
   - Returns the `StreamTextResult`; the caller drives the stream.
7. **Client SSE** (`useLiveSession`): feeds `ui_message_part` chunks into `readUIMessageStream` for live assembly, upserts by id into `messages`. `messages_appended` upserts by id too — chunks and the end-of-turn canonical broadcast converge to one row. After running→idle the page refetches `/messages` to pick up sanitization + the server-side memory-recall part attached to the user message.

`UIMessage` (from `ai`) is the canonical shape across **DB rows, persistence layer, agent input, server response, web render**. We don't define our own message types — re-exported from `@openacme/agent-core` for convenience.

### Why SSE-only

Pre-refactor, interactive turns streamed over the HTTP response (`useChat` + `createUIMessageStreamResponse`) while autonomous turns went only via SSE — two execution models. The originating tab was BOTH the HTTP-response reader AND an SSE subscriber, which forced a same-id coordination dance (`responseMessageId` on the server, `suppressPartAssembly` on the client) to keep two assemblers from racing. Folding interactive into SSE collapses that to one path: agent runs are server-owned, tabs (including the originator) are observers. The TUI still runs its agent in-process via `agent.runStream` — that path doesn't touch the HTTP server, so no migration needed.

### Custom data parts

`OpenAcmeDataParts` (in `@openacme/agent-core/src/types.ts`) maps named data-part types to their payload shapes. `OpenAcmeUIMessage = UIMessage<…, OpenAcmeDataParts>` is the type-narrowed variant — the server uses it on `createUIMessageStream<OpenAcmeUIMessage>` so `writer.write({type: "data-X", data})` is type-checked.

The web's mirror in `apps/web/app/lib/types.ts` must be kept in sync (web can't import server packages — `// mirrored (not imported)` is the existing pattern).

Today only `data-status` is wired — mid-stream reconciliation hook. **Same `id` from the server replaces the previous part** on the client; empty `message` clears the entry. No path emits it yet; it's the expansion seat for proactive-compression and tool-prelude UI when those return. (`data-session` existed before the SSE-only refactor to ferry the server-assigned session id back to `useChat`; gone now that the client owns sessionIds.)

Adding a new data part: extend `OpenAcmeDataParts` in agent-core, mirror in web's `lib/types.ts`, handle it via `useLiveSession({onDataPart})` (transient parts are surfaced there since the assembler strips them from `messages`). Persisted (non-transient) data parts also need a renderer in `MessageBubble`.

---

## Tools

`packages/tools/src/registry.ts` — a singleton `ToolRegistry` keyed by tool name. Built-ins self-register on import (`packages/tools/src/builtins/*`); MCP tools register dynamically and are namespaced `mcp-<server>__<tool>`.

`ToolEntry` shape (see `types.ts`): `name`, `toolset`, `description`, `parameters: ZodSchema`, `handler: (args) => Promise<string>` (return JSON-stringified result), plus optional `emoji`, `parallelSafe`, `maxResultSizeChars`, `checkFn`.

Shadowing rule (`registry.ts:18`): a register call is **rejected** if a different `toolset` already owns the name. Two MCP toolsets *can* overwrite each other (legitimate server refresh).

### Adding a new built-in tool

1. Create `packages/tools/src/builtins/<name>.ts` with a Zod params schema and an `async handler(args) => JSON.stringify(...)`.
2. `registry.register({...})` at module top level.
3. Import the file in `packages/tools/src/index.ts` so it self-registers.
4. Decide the category:
   - **System tool** (always-on, not user-configurable — agent introspection / self-management like `task_*`, `skill_view`, `memory`, `session_search`): add the name to `SYSTEM_TOOLS` in `packages/tools/src/system.ts`. It will be merged into every agent's effective tool set by `AgentManager.createAgentFromDef` and hidden from the web's tool picker.
   - **User-configurable tool** (environment-touching — shell, file IO, web, exec): add to the `tools` default in `AgentDefinitionSchema` (`packages/config/src/schema.ts`) if it should ship on by default. Don't put it in `SYSTEM_TOOLS`.
5. Tools are stateless. Long results: enforce a size cap inside the handler (shell uses 50KB; see `shell.ts`).

### Wiring an external store into a tool

`session_search` needs the live DB and is bound at runtime via `bindSessionSearch(messageStore.search)` from `agent-manager.ts`. Mirror this pattern: register the tool with a placeholder handler, expose a `bindX(...)` setter, call it from `AgentManager` after stores exist.

---

## Persistence

`packages/db/src/connection.ts` — better-sqlite3, WAL on, FK on. Tables: `sessions`, `messages`, `user_profiles`. `fts_messages` is a self-contained FTS5 virtual table kept in sync via triggers that extract text from each message's `parts` JSON. Used by `MessageStore.search()` and the `session_search` tool. Agents are filesystem-backed, not in the DB.

`messages` shape: `id, session_id, role ("user" | "assistant"), parts (JSON UIMessagePart[]), metadata (JSON, optional), created_at`. One row per UIMessage — tool calls + their results live as `tool-${name}` parts inside an assistant message's parts array. File attachments are `file` parts whose `url` is `/api/attachments/<sessionId>/<attId>/<filename>` — the URL alone resolves to disk under `<dataDir>/attachments/`, no sidecar table.

Stores (`packages/db/src/stores/*`) are thin: `SessionStore`, `MessageStore`. `MessageStore.append/getHistory` JSON-stringifies/parses parts at the boundary; consumers see `StoredUIMessage` (id, role, parts: unknown[], metadata?). UUIDs auto-generated when `id` isn't supplied. Don't bypass the stores from app code.

`SessionStore.delete` cascades messages via FK and removes `<attachmentsRoot>/<sessionId>/` from disk. Pass `attachmentsRoot` via `createSessionStore(db, { attachmentsRoot })` to enable the FS hook.

---

## LLM providers

`packages/llm-provider/src/registry.ts:getModel(config)` dispatches by `provider`:

| provider     | adapter                              | OAuth aware | Notes |
|--------------|--------------------------------------|-------------|-------|
| `openai`     | `@ai-sdk/openai`                     | yes         | OAuth flips to ChatGPT Responses API at `OPENAI_INFERENCE_BASE_URL`; custom fetch injects bearer + ChatGPT account headers; `transformCodexOAuthBody` normalizes the body. |
| `anthropic`  | `@ai-sdk/anthropic`                  | yes         | OAuth applies `transformAnthropicOAuthBody` + Claude Code beta headers (interleaved-thinking, tool-streaming, oauth, `context-1m` for 4.6+). Sampling params stripped for 4.7+ even on API-key auth. `transformAnthropicOAuthResponse` strips the `mcp_` prefix from tool ids. |
| `google`     | `@ai-sdk/google`                     | no          | Standard Gemini. |
| `openrouter` | `@ai-sdk/openai-compatible`          | no          | Default in `ConfigSchema`. |
| `ollama`     | `@ai-sdk/openai-compatible`          | no          | Local. |
| `custom`     | `@ai-sdk/openai-compatible`          | no          | Requires `baseUrl`. |

OAuth resolution (`registry.ts:52`): if `auth: "oauth"` explicitly, use OAuth; else if `apiKey` is missing AND a token exists in `auth.json`, fall back silently. Set `OPENACME_DEBUG=1` (or include `auth`) to log the auth path taken.

### Adding a provider

Add the enum value to `ProviderSchema` (`config/src/schema.ts`), add a factory in `llm-provider/src/registry.ts`, document any required headers / body transforms next to the factory.

---

## MCP

`packages/mcp-client/src/client.ts` — `MCPClient.connect(servers)` runs init in parallel with retry (3 attempts, exponential 1/2/4s). Stdio: `StdioClientTransport` with `buildSafeEnv()` filtering credential-shaped env vars. HTTP/SSE: `SSEClientTransport` with headers. After `tools/list`, each tool registers as `mcp-<server>__<tool>` with the discovered Zod schema.

`security.ts:sanitizeError` strips secrets from error strings before they hit logs or the client. Tool results are clipped to `maxResultSizeChars`.

`AgentManager.initMCP()` is called once at server start and again on agent-config change. Per-agent `mcpServers` map lives in `AgentDefinitionSchema`.

---

## CLI

`apps/cli/src/index.ts` — Commander, runs `start` with no subcommand.

Subcommands (`apps/cli/src/commands/`):

- `setup` — Clack-based wizard; provider + auth + default model into `~/.openacme/config.yaml`. Never creates agents — the daemon materializes the Acme platform agent on first boot, everything else is hired via the web UI.
- `start` (default) — installs the launchd/systemd unit on first run, boots the Hono daemon, opens the web UI. `--expose` flips bind to 0.0.0.0 + generates an access secret. `--no-service` spawns detached with a PID file instead.
- `stop` / `restart` / `status` / `logs [-f]` — daemon lifecycle + introspection.
- `chat` — terminal chat. **In-process**: instantiates `AgentManager` directly, calls `agent.runStream()`, and consumes `result.fullStream` — no HTTP, no SSE wire format.
- `login [--provider] [--device]`, `logout` — OAuth flows in `@openacme/auth`.
- `secret show|rotate` — manage the access secret used for non-loopback web access.
- `skills list|view|add|remove` — manage locally-authored skills.
- `skills install|search|inspect|update|uninstall|audit|tap …` — Skills Hub: install + track skills from GitHub, marketplaces, URLs, etc. (see `apps/cli/src/commands/skills-hub.ts`).
- `mcp list|status|remove|test` — manage MCP servers (add/edit happens by editing `<dataDir>/mcp.json` directly).
- `memory status|show <agentId>` — inspect per-agent persistent MEMORY.md.

TUI (`apps/cli/src/tui/`) is React-on-Ink. `render.tsx` mounts the app; `state.ts` reducer carries `committed: UIMessage[]` and an in-flight assistant UIMessage assembled from `result.fullStream` events. `commands.ts` is the slash-command table (`/new`, `/clear`, `/help`, `/exit`, `/model`, `/agent`). Components: `MessageList`, `MessageBubble` (renders UIMessagePart[]), `ToolBlock` (renders ToolUIPart by `state`), `MultilineInput`, `PendingAttachmentsBar`, pickers, `StatusLine`, `Banner`, `CommandPalette`. Markdown via `marked` + `marked-terminal`. Non-TTY → `headless.ts`. Attachments via terminal drag-drop or `@<path>` resolved at submit (`attachments.ts`).

---

## Web

`apps/web/` — Vite + TanStack Router SPA (file-based routes under `app/routes/`, typed Zod-validated search params via `validateSearch`). Pages: `/` (chat), `/agents`, `/teams`, `/tasks`, `/skills` (Browse + Sources tabs for the Skills Hub), `/settings` (model/auth/MCP/Context — the **Context** tab edits `<dataDir>/AGENTS.md`), `/login`. Tailwind v4 + Radix primitives + react-markdown. `app/routeTree.gen.ts` is generated by the router plugin and checked in.

**One URL, one process, one port: `http://127.0.0.1:3456`.** In dev the server embeds Vite in middleware mode (`packages/server/src/dev-web.ts`, activated by `OPENACME_WEB_DEV=<path to apps/web>` which `packages/server/scripts/dev.mjs` sets) — `/api/*` goes to Hono, everything else to Vite, and the HMR WebSocket shares the same server. There is no separate web dev process or derived web port. Two parallel `pnpm dev` sessions against different data dirs just work as long as their `server.port`s differ:

```sh
OPENACME_DATA_DIR=~/.openacme-test pnpm dev   # → :3211 (or whatever server.port says)
```

The chat page owns its `messages` state directly (no `useChat` — agent runs are server-owned and observed via SSE; see the agent-loop section). `useLiveSession` opens the per-session `EventSource`, feeds chunks into `readUIMessageStream` for live assembly, and surfaces transient data-* parts via `onDataPart`. `messages` from `useState` is the canonical render source.

There is **no auth on the web ↔ server channel** today — assumes a trusted local environment. Don't add UI features that imply otherwise without first introducing a session/token layer.

Attachments: file picker / drag-drop POSTs to `/api/uploads` first → server returns `{pendingId, url: "/api/attachments/__pending__/<id>/<file>"}`. Web stages chips with the pending URL, then `sendMessage({ role:"user", parts: [{type:"text",text}, {type:"file", url, mediaType, filename}] })`. Server's `/api/chat` resolves pending URLs to committed ones at persist time.

---

## Auth (`@openacme/auth`)

OAuth for **ChatGPT** subscription and **Claude** subscription. API-key remains the fallback and is used directly by `llm-provider` factories when no OAuth is configured.

Files:
- `oauth-openai.ts`, `oauth-anthropic.ts` — login flows (browser via `loopback.ts` + `pkce.ts`, or device-code for headless).
- `store.ts` — atomic write of `~/.openacme/auth.json` at mode `0600`. Shape: `{ version: 1, openai?, anthropic? }`, each entry: `{ mode, access_token, refresh_token?, id_token?, expires_at, account_id?, last_refresh? }`.
- `refresh.ts:getOAuthToken(provider, dataDir)` — refresh-on-expiry; throws `OAuthRelogin` on hard failure (CLI catches, prompts re-login).
- `transforms-{openai,anthropic}.ts` — body / response normalization for OAuth-bound API contracts (header injection, `mcp_` prefix strip, sampling param strip).
- `security.ts` — credential-string masking for logs.

Never log raw tokens. Never write tokens anywhere except via `store.ts`.

---

## Config

`packages/config/src/schema.ts` is the source of truth. Top-level keys: `dataDir`, `model` (`ModelConfigSchema`), `server` (`port`, `host`), `behavior` (`AgentBehaviorSchema` — `maxSteps: 1000` + compression knobs), `skills` (`directory`, `autoGenerate`), `web` (`searchProvider`, `searchApiKey`), `browser` (`BrowserConfigSchema` — per-agent sessions via pluggable provider). **Agents are not in `config.yaml`** — each lives at `<dataDir>/agents/<id>/AGENT.md` (YAML frontmatter + system-prompt body) and is read/written by `AgentStore`. Shared workforce-wide context lives at `<dataDir>/AGENTS.md` and is merged into every agent's prompt.

`AgentDefinitionSchema` defaults `tools` to environment-touching tools only: `[shell, read_file, write_file, edit, apply_patch, list_files, search_files, web_search, web_extract, execute_code, process, browser_*]`. The introspection / self-management tools (`memory`, `session_search`, `skill_view`, `task_*`, `agent_list`) are **always-on system tools** merged in by `AgentManager` — do not list them under `tools`. Per-agent `model` overrides the root `model`. Other agent fields: `role` (third-person paragraph for coworkers), `persona` (second-person system prompt), `mcpServers` (private), `mcpDisabled` (excludes from global catalog), `skills`, `memoryCharLimit` (default 4000).

`loader.ts:loadConfig(dataDirOverride?)` resolves the data dir, reads `config.yaml` (or `.json`), merges with defaults, validates with Zod. **Always go through the schema** — don't read raw config elsewhere.

Env vars: `OPENACME_DATA_DIR` (set early by CLI so `auth.json` is findable without threading), `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `OPENROUTER_API_KEY`, `OPENACME_DEBUG` (drops the pino logger to `debug` level globally — any non-empty value works, including the historical `=auth`), `OPENACME_LOG_FILE` (override pino's destination; the CLI sets this to `<dataDir>/openacme-tui.log` in TUI mode so Ink owns the terminal cleanly). Dev-only telemetry: `OPENACME_TELEMETRY=1` enables OTel/Logfire export; off by default so user installs ship inert. Currently on in this repo — when testing or checking logs/traces, use the `logfire` MCP server.

---

## Skills

`packages/skills/src/registry.ts` — `SkillRegistry.loadFromDirectory(dir)` recursively scans for `SKILL.md` (flat or nested). Frontmatter via `gray-matter`: `name`, `description`, `tags`. Max file size 1MB, symlinks resolved.

Progressive disclosure:
- `getIndex()` / `getIndexAsString()` — name + description + tags only, injected into the system prompt.
- `getSkill(name)` — full markdown, fetched on demand by the `skill_view`-style tool (when present).

Per-agent `skills` array filters which skills are exposed; empty/missing means all.

### Skills Hub

`packages/skills/src/hub/` — multi-source installer that writes into the same `<dataDir>/skills/<name>/` directory the registry reads from. Sources today: GitHub repos, generic Git URLs, raw URL / archive, Claude marketplace (`.claude-plugin/marketplace.json`), `.well-known/skills.json`, LobeHub, Skills.sh, ClawHub, local directories, and `builtin` (skills shipped with the platform under `packages/skills/builtin/<name>/`). `SkillHub` (`hub.ts`) owns search/inspect/install/update/uninstall; bytes are staged under `<skillsDir>/_hub/staging/`, validated (`MAX_TOTAL_BYTES = 10MB`, `MAX_FILES = 200`, name + path traversal checks), then atomically swapped into `<skillsDir>/<name>/`.

The `builtin` source resolves identifiers (bare skill names) against `packages/skills/builtin/<identifier>/`. Adding a bundled skill: create the folder with a `SKILL.md` and update `packages/skills/package.json`'s `files` array if it isn't already covered by `"builtin"`. Bundled skills still go through the hub install path, so the lockfile + audit log track them like any other source — they just don't fetch over the network.

State: `lockfile.ts` (per-skill source + content hash + trust level), `audit.ts` (append-only install/update/uninstall log), `taps.ts` (user-added GitHub repos that act as extra "search this too" feeds), `index-cache.ts`. HTTP routes at `/api/skills/hub/*` in `routes/skills-hub.ts`; CLI at `apps/cli/src/commands/skills-hub.ts`; web UI in `apps/web/app/skills/`.

Two install-time invariants worth remembering: (1) **refuse to clobber a locally-authored skill** — if `<skillsDir>/<name>/` has no lockfile entry, install fails with a conflict the user has to resolve; (2) name validation rejects collisions with reserved paths (`_hub`, `..`) so the hub can never overwrite its own state.

---

## Agent catalog

`packages/agent-catalog/` — bespoke, in-tree list of platform-authored agent templates the user can import into their workforce. **Not a registry.** No remote sources, no lockfile, no provenance tracking on the imported agent. Each template directory mirrors the on-disk shape of a live agent folder (`AGENT.md` + `resources/`), so an import is essentially a copy under `<dataDir>/agents/<id>/` plus auto-installing the template's recommended skills + MCP servers.

Layout: `packages/agent-catalog/templates/<id>/{AGENT.md, resources/}`. AGENT.md adds five template-only frontmatter keys parsed by a separate `AgentTemplateMetaFrontmatterSchema` and stripped before the rest validates against `AgentDefinitionSchema`:

- `template_id`, `template_name`, `template_description`, `template_tags`
- `default_id_hint` — base used for auto-incremented ids on multi-instance import
- `recommended_skills: [{ name, source, identifier }]` — installed via SkillHub on import
- `recommended_mcp_servers: [{ name, config }]` — added to global `<dataDir>/mcp.json` on import (skipped silently if name already exists)

`AgentCatalog` is a read-once in-memory snapshot at module init (same idiom as `model-registry.json`). `buildAgentFromTemplate(template, opts, existingIds)` is pure — resolves the id (collision auto-increment off `default_id_hint`), merges template fields ⊕ caller overrides, validates. The side-effectful pipeline lives in `AgentManager.importAgentFromTemplate`:

1. Install recommended skills via `SkillHub.install` (skip already-installed; failures go into the manifest, never block).
2. Add recommended MCP servers to `mcp.json` via `saveGlobalMcpServers` (skip name collisions silently); `initMCP` if anything changed.
3. `buildAgentFromTemplate` → `createAgent(def)` (existing path, gets MCP reinit + cache eviction for free).
4. Copy `<templateDir>/resources/*` → `<agentDir>/resources/*`. Evict the cached Agent so the next chat picks up the resource listing in its prompt.

Returns `ImportManifest` with a two-bucket shape — `agent.{id, resourceFiles}` vs `workforce.{skills, mcpServers}` — that the web preview UI renders verbatim.

HTTP routes in `packages/server/src/routes/agent-catalog.ts`:

- `GET /api/agents/catalog` — list templates with summary counts (no persona body)
- `GET /api/agents/catalog/:templateId` — full template incl. recommended_*
- `GET /api/agents/catalog/:templateId/preview` — diff vs current state (`new` vs `kept`) for the UI's "Will install" block
- `POST /api/agents/catalog/:templateId/import` — body `{ idOverride?, nameOverride?, overrides? }`, returns `{ agent, manifest }`

Mounted **before** the generic `/api/agents/:id` routes in `app.ts` so the literal `catalog` segment wins. CLI: `apps/cli/src/commands/agents.ts` exposes `agents catalog` (list) + `agents import <templateId>` (one-shot) in-process via AgentManager.

### Adding a template

1. Create `packages/agent-catalog/templates/<id>/AGENT.md` with the template_* frontmatter.
2. Optional: drop reference files into `templates/<id>/resources/` (no frontmatter listing — walked at load).
3. If the template depends on a platform-bundled skill, ship the skill under `packages/skills/builtin/<name>/SKILL.md` and reference it via `{ source: "builtin", identifier: "<name>" }`. For network sources (GitHub, marketplaces), use the corresponding `source` id — same shape SkillHub.install takes.

---

## AGENTS.md, workspace, resources

Three filesystem surfaces that shape what an agent sees and where it works. All flow through `buildSystemPrompt` in `packages/agent-core/src/prompt.ts`.

- **`<dataDir>/AGENTS.md`** — single shared context file injected into every agent's system prompt under `Shared context (from AGENTS.md):`. Loaded once at AgentManager start and on explicit save via `setAgentsMd()` (which evicts all cached Agents so the next chat rebuilds prompts). Web editor lives in Settings → Context. Empty/missing → section omitted. Restart-free updates because the manager evicts; on-disk edits (e.g. Acme's) apply when the `reload_config` tool runs `reloadAll()` (see "reload_config" gotcha below).
- **`<dataDir>/agents/<id>/workspace/`** — per-agent default `cwd`. `AgentManager` mkdirs it idempotently on every agent build, threads it through `AgentConfig.workspaceDir`, and the prompt advertises it under `## Workspace`. **Per-session persistent shell:** the `shell` tool keeps a long-lived process per session so `cd`, exported env vars, and shell functions stick across calls. Absolute paths are still allowed; workspace is the default, not a sandbox.
- **`<dataDir>/agents/<id>/resources/`** — user-supplied files (style guides, templates, sample data). `agentStore.listResources(id)` walks the dir; the prompt lists each entry under `## Resources` as `relPath (size) — absPath` so persona references like "use template.json" resolve to a real path. Cap of 50 lines in the prompt with a `... and N more` tail; agents can still `read_file` anything. Mutations go through `/api/agents/:id/resources` which calls `evictAgent` so the next prompt sees fresh listings.

---

## Browser (`@openacme/browser`)

**Per-agent browser sessions via a pluggable provider.** Each agent that calls a browser tool gets its own session — a separate process under `<dataDir>/agents/<id>/browser-profiles/<family>/` (local provider, namespaced by engine family: `chromium` or `firefox`) or a separate remote session (cloud providers). Why per-agent: shared cookies cascade bans across the workforce, and shared fingerprints get the whole org flagged on social-media-style sites; each agent is a distinct persona, the runtime should reflect that. Why family-namespaced: Chromium-family browsers (Chrome / Brave / Edge / CloakBrowser) share the `chromium/` profile dir so swapping among them keeps logins; Firefox-based browsers (Camoufox) use `firefox/` because the profile format is incompatible. Lazy: nothing spawns / acquires until the first `browser_*` tool call. N inactive agents = 0 sessions held.

### Provider abstraction

`packages/browser/src/providers/base.ts` — `BrowserProvider` interface. The whole contract is "give me a CDP URL for this agent." Anything that can produce one slots in. Idempotent per agent id; the provider caches sessions internally.

V1 providers (all in `packages/browser/src/providers/`):

| name | who runs the browser | env / config |
|---|---|---|
| `local` (default) | this machine, per-agent Chrome | `executablePath`, `headless`, `noSandbox` |
| `browserbase` | Browserbase cloud | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, optional `_PROXIES`, `_ADVANCED_STEALTH`, `_KEEP_ALIVE`, `_SESSION_TIMEOUT`, `_BASE_URL` |
| `browser-use` | Browser Use cloud (best stealth in 2026 benchmarks) | `BROWSER_USE_API_KEY`, optional `_BASE_URL`, `_TIMEOUT_MIN`, `_PROXY_COUNTRY` |
| `firecrawl` | Firecrawl cloud | `FIRECRAWL_API_KEY`, optional `FIRECRAWL_API_URL`, `FIRECRAWL_BROWSER_TTL` |

Selection: `browser.provider` in `config.yaml` (workforce-wide for now; agent-level override is the obvious next extension, mirroring how `model` overrides root model). `createBrowserProvider(...)` in `providers/index.ts` is the factory called from `AgentManager`. Adding a new provider = one new file + one line in `PROVIDER_NAMES` + a switch case in `createBrowserProvider`.

### Local provider details

`LocalChromeProvider` (`providers/local.ts`) handles per-agent local sessions. For `browser.localBrowser: "chromium"` it spawns one Chrome/Brave/Edge/Chromium per agent and the manager attaches via CDP (`--remote-debugging-port=0` + reads `DevToolsActivePort` to avoid port collisions across N agents). For `browser.localBrowser: "camoufox"` it goes through `firefox.launchPersistentContext` from `camoufox-js` — bypasses CDP (Firefox doesn't speak it) and sidesteps macOS hardened-runtime traps that block bare-child-process spawns of adhoc-signed browsers. Headed by default (`browser.headless: false`); each agent's window appears separately so the user can log in per persona. `browser.executablePath` overrides the auto-detect with a user-supplied Chromium-family binary (always treated as `chromium` family for profile-dir resolution).

### Manager + tools

`BrowserManager` (`manager.ts`) holds a `Map<agentId, AgentBrowserInstance>` — each instance is `{acquired, browser, agentTabs, activeTargetId, pageState}`. All public methods take `agentId` as the first arg. CDP attachment is via `playwright-core`'s `connectOverCDP` to the acquired URL; `withReconnect` recovers from transient drops by calling `closeAgent(id)` and re-acquiring. `closeAgent(agentId)` is called from `AgentManager.deleteAgent` before the agent dir is removed — kills the agent's Chrome / cloud session so on-disk cleanup can succeed.

Tools register from `packages/tools/src/builtins/browser/`: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_take_screenshot`, `browser_wait_for`, `browser_evaluate`, `browser_console_messages`, `browser_tabs`, `browser_act`. All bound to a live `BrowserManager` in `AgentManager` via `bindBrowser`.

### Config

Under `browser` in `config.yaml`: `enabled` (default true), `provider` (default `local`), `executablePath` (local only), `headless` (local only, default false), `noSandbox` (local only, for Docker-as-root). The legacy `port` field is silently ignored — Chrome now picks its own port per agent.

---

## Tasks & the dispatcher

`@openacme/tasks` is one filesystem store under `<dataDir>/tasks/<id>.md` (YAML frontmatter + markdown body), shared by all agents. Per-agent isolation is by `assignee`, not by store. `task_list` / `task_view` / `task_create` / `task_update` / `task_comment` / `task_comments` are **system tools** (always on, hidden from the picker; see `SYSTEM_TOOLS` in `packages/tools/src/system.ts`). `agent_list` is also a system tool — every agent can look up its coworkers (id, name, role) without it being a configurable choice.

Tasks are documents (filesystem). **Comments and events live in SQLite** (`task_comments`, `task_events`) — they're message-shaped (high-frequency, append-only, queryable) and don't belong inside the task body. Body is the spec; comments are the discussion; events are the signal log.

`TaskStore` enforces the invariants:
- cycle-free `depends_on` (DFS on write). `blocked` is **explicit-only** — deps don't auto-flip status; readiness (`deps satisfied AND start_at due`) is a read-time predicate the dispatcher evaluates fresh each tick.
- at most one `in_progress` per `session_id`.
- a **recurring** task marked `done` self-resets to `open` with the next fire time (so the returned status is `open`, not `done`) — `canceled` is the only way to stop a recurrence permanently.
- inputs validated against the frontmatter schema at the write boundary so a bad PATCH can't land malformed YAML on disk.
- stored tasks always carry a concrete `assignee`. **Team-addressed creation**: `create` with `team` set and no assignee resolves the assignee to the team's `manager` via the injected `resolveTeamManager` (errors if the team is unknown, archived, or managerless). Explicit assignee always wins; the resolver is never consulted.
- `addComment`, `listComments`, `latestResult`, `commentCounts` delegate to the injected `CommentStore`. Mutating paths emit events via the injected `EventStore`. All injected ports are optional — tests can omit them.

### Team manager (routing default, not authority)

`TeamDefinitionSchema.manager` (optional, must be a member, validated in `team-store.upsert`; vacant seat = key absent, not `manager: null`). It does three things only: team-addressed `task_create` lands on the manager for triage; members' prompts show `Manager: <id>` in the Teams section; the manager's own prompt gets a triage-duty paragraph (claim / reassign via `task_update` / split — decide, don't relay). No charter/membership powers, no new tools. `updateTeam` auto-vacates the seat when a members update drops the manager, and rejects `archived: true` while open team-tagged tasks exist (archiving revokes workspace writes — live work would strand).

### Agent-driven task selection

The dispatcher is the **wake mechanism**, not a work-picker. `runAutonomous({sessionId})` brings the agent to life with queue + recent-activity context; the agent picks what to work on and calls `task_update(in_progress)` itself when claiming. Failure attribution is post-hoc: on `AutonomousTurnTimeout` or generic error, the dispatcher parks the in-progress task with `start_at = now + 5min` backoff and a `system:scheduler` comment.

### Wake policy (tick-based dispatcher + per-agent inbox)

`Dispatcher` (`packages/server/src/dispatcher.ts`) replaced the old event-driven `TaskScheduler`. It is **state-checking, not event-reactive**: a 60s tick (`DEFAULT_TICK_MS`) walks agents/sessions and decides who runs; events don't wake anything directly — they land as **inbox rows** (`InboxStore`, fanned out from `EventStore.onEmit` in AgentManager to the task's assignee + creator) which the next tick observes.

- `start()` runs a one-shot `startupSweep` (stale in_progress recovery, session allocation for unbound ready tasks), then ticks.
- `shouldSpawn(session)`: pending inbox rows → spawn; otherwise ready tasks (open, start_at due, deps satisfied — read-time predicates) → spawn. One turn per agent at a time (chain guard).
- Wake latency is bounded by the tick: up to ~60s from task creation to the assignee's turn starting.
- Inbox rows drained at turn start render as wake text; rows arriving **mid-turn** inject via `prepareStep` as structured `<system-event>` lines (event kind + JSON payload — never other agents' free prose), capped at 5 injections per turn.

### Editing the task model

- New frontmatter field: add to `TaskFrontmatterSchema` + `TaskCreate` / `TaskUpdate` + `TaskCreateInputSchema` / `TaskUpdateInputSchema` (write-boundary guards). Don't skip the second pair — `update()` would happily persist garbage.
- New status: extend `TASK_STATUSES`, then audit the closing branches in `update()` and the recurring-task self-reset.
- New recurrence kind: extend the discriminated union in both `types.ts` and the tool params in `builtins/tasks.ts`; add a branch in `computeNextFire` + `validateRecurrence`.
- New comment kind: add to the tool's Zod enum (currently only `result` is exposed; `system` is reserved and rejected by both the tool and HTTP routes).
- New event kind: add to the `EventKind` union in `packages/tasks/src/ports.ts`, emit at the appropriate site in `TaskStore`, and add a `summarizeEventPayload` branch so the prompt's `## Recent activity` section formats it.

---

## Conventions

- **TypeScript** strict, ES modules, `.js` import suffix on relative paths (NodeNext). Target Node ≥18.
- **Zod first**: tool params, config schema, agent definitions. Don't hand-roll JSON Schema — use `z.toJSONSchema` (registry uses it).
- **AI SDK types end-to-end**: persist + render `UIMessage` / `UIMessagePart`. Don't define parallel message types in app code; re-export from `@openacme/agent-core` (which re-exports from `ai`).
- **Stores are the boundary** to SQLite. App code uses `SessionStore` / `MessageStore`, not raw `db.prepare`. Agents are filesystem-backed via `AgentStore` (YAML), not in the DB.
- **Errors**: throw `Error` with a clear message. The server's `createUIMessageStream` surfaces it as a stream error; the CLI's `result.fullStream` `error` event handles the same. Don't swallow.
- **No emojis** in code or commit messages unless the user asks.
- **No new docs** unless asked. Working notes belong in commit messages, not in `docs/`.
- **Comments**: keep short or don't write them. See the **Comments** section below — this is enforced.
- **No backwards-compat shims** for unreleased / unpublished surfaces — change the code.
- **Trunk-based for normal work; PR only for releases.** `main` is branch-protected on GitHub — direct pushes are rejected. For regular work, still *commit* directly to `main` locally (each commit passes type-check + lint on its own); don't reference a "PR-N" sequence in plans or commit messages — phrase staged work as "commit 1, commit 2…". The one exception is a **release**: the version-bump commit goes out on a `changeset-release/main` branch and merges via PR (this is how every prior release landed). Don't open PRs for anything else, and don't create ad-hoc feature branches.
- **Comments**: only when the *why* is non-obvious. One-line target, two cap, no multi-line blocks. Don't name exact callers/files/lines — that rots; describe the invariant. Long *why* goes in the commit message.

---

## Non-obvious gotchas

- **Client owns sessionIds.** `crypto.randomUUID()` on the web mints a session id for a fresh chat; the server creates the row from whatever is passed. The SSE subscription is keyed on `activeSessionId` so it can open BEFORE the first POST; `send` waits for `liveConnectedRef.current === true` (capped 2s) so the agent's first chunks can't be missed. Stream route (`/api/sessions/:id/stream`) does NOT 404 on unknown sessionIds for this reason — broadcaster state is lazy.
- **Idle after persist, not before.** In `runChatTurn.onFinish`, the order is: persist assistant → broadcast `messages_appended` → broadcast `session_state: idle`. The client's running→idle effect refetches `/messages`; flipping that order races the DB write and the refetch lands an assistant-less history. Keep this order.
- **Reactive 413 retry is currently disabled** — 413s surface as stream errors today.
- **System-prompt cache invalidation is manual.** Changing an agent's tools / skills mid-process won't take effect until the cached `Agent` is evicted (`agents.clear()`/`delete(id)`) or you call `invalidateSystemPromptCache()`. AgentManager evicts on agent-definition mutation (the HTTP routes) and inside `reloadAll()`.
- **No filesystem watcher — on-disk config edits apply via `reload_config`.** There is intentionally NO watcher (an earlier attempt was reverted: auto-reiniting MCP on every `mcp.json` change stopped workers + invalidated prompt caches reactively, including mid-turn). Instead, on-disk edits (Acme editing `config.yaml`/`AGENTS.md`/`mcp.json`/coworkers' `AGENT.md`/`skills`) apply only when the **`reload_config`** tool calls `AgentManager.reloadAll()` — one explicit, full reload (`reloadConfig` + re-read AGENTS.md + `reloadSkills` + `initMCP` + evict-all). It's a **daemon-runtime, Acme-only** tool (in the Acme template's `tools`, not `SYSTEM_TOOLS`), so restarting workers during the reload can't kill the calling agent's own turn. Settings-UI saves still apply via their routes (explicit user actions). `server.host`/`server.port` still needs `openacme restart` (live socket bind) — `reloadAll` returns it in `restartRequired`.
- **Attachment URLs round-trip to disk paths** — `/api/attachments/<sessionId>/<attId>/<filename>` serves directly from `<dataDir>/attachments/<sessionId>/<attId>/<filename>`. No DB sidecar lookup. Pre-chat uploads land under `__pending__/<pendingId>/...` and `commit()` (in `routes/uploads.ts`) moves them under the real session at `/api/chat` time.
- **`inlineFileAttachments` is required at chat time.** Providers can't fetch our local URLs; the agent reads the bytes off disk and rewrites to a `data:` URL before `convertToModelMessages`. If you add a new local-URL scheme, extend `parseAttachmentUrl` in `messages.ts`.
- **Compression preserves FileUIParts via `originalParts` + `rebindAttachmentsForChild`.** The internal Step shape would otherwise drop file parts on user messages; flatten stashes the pristine parts, coalesce restores them, and `Agent.compress` copies the bytes under the child session dir + rewrites URLs. Don't strip `originalParts` from `Step`; don't skip the rebind.
- **OAuth body/response transforms are required for correctness**, not optional polish. Skipping them produces 400s on Anthropic OAuth and tool-id mismatches. Mirror existing transforms when adding a new OAuth-aware provider.
- **One URL, one process — `:3456`.** In dev (`OPENACME_WEB_DEV` set to the apps/web path), the server embeds Vite in middleware mode (`dev-web.ts`): `/api/*` → Hono, everything else → Vite, HMR WS on the same port. `vite` is a server devDependency behind a dynamic import — published dists never load it. In published installs Hono serves the bundled static at `packages/server/web/` (filled by `prepack`). Daemons started without `OPENACME_WEB_DEV` (e.g. test slots via `pnpm agent start --data-dir ~/.openacme-test`) prefer the bundled path and fall back to the workspace `apps/web/out` if you've built it — keep that fallback for test-daemon UI. The server's `tsx watch` ignores the web root (Vite writes bundled-config temp files under `apps/web/node_modules/.vite-temp/`; watching them causes a restart loop).
- **MCP env injection is filtered**. `buildSafeEnv` drops anything that smells like a credential. Pass explicit `env` in `MCPServerConfig` for tokens you actually need.
- **`apps/cli` chat does not call the server** — agent runs in-process via `agent.runStream`. Server-only changes (HTTP middleware, /api/chat handler) won't affect terminal chat behavior.
- **Scheduler errors land as `system:scheduler` comments, not body suffixes.** Pre-Tasks-v2 the scheduler appended `> [scheduler] turn timed out at ...` to the task body. New code emits a `kind: "system"` comment via `TaskStore.addComment` and the body stays clean. Pre-existing tasks still carry the historical body suffixes; no migration ran.
- **One slice per task tool.** `task_view` returns frontmatter + body only (no comments, no events). `task_comments` and the `/api/tasks/:id/comments` route return comments only. `/api/tasks/:id/events` returns the event log only. Don't bundle these — the cost compounds across calls and agents only pay for what they ask for.
- **Per-session events cursor is `sessions.last_seen_event_ts`.** Updated at the end of every successful autonomous turn so the next turn's `## Recent activity` section is incremental. New sessions inherit `created_at` so their first turn sees nothing-from-before.

---

## Commands

From repo root:

```
pnpm install                  # install workspace deps
pnpm dev                      # web + @openacme/server in parallel (turbo)
pnpm build                    # build all packages
pnpm check-types              # tsc --noEmit across the workspace
pnpm lint
pnpm test                     # vitest where present (most packages have none yet)
pnpm format                   # prettier

pnpm agent                    # run the CLI (no subcommand → start daemon + open web UI)
pnpm agent setup              # interactive setup wizard
pnpm agent start              # start daemon (idempotent; --expose for network bind)
pnpm agent stop               # stop daemon
pnpm agent restart            # restart daemon
pnpm agent status             # pid, bind, uptime, recent log
pnpm agent logs [-f]          # print or follow daemon log
pnpm agent chat               # terminal chat (in-process; no server needed)
pnpm agent login --provider <openai|anthropic>   # OAuth subscription sign-in
pnpm agent skills|mcp|memory  # subcommand groups; run with no args for help

pnpm changeset                # declare a version bump (interactive)
pnpm version-packages         # consume changesets locally
pnpm release                  # turbo build @openacme/* + changeset publish
```

Per-package: `pnpm --filter @openacme/<pkg> <script>`.

### Running a daemon to test changes

**Default — use the dev server against the test slot.** Code changes (server *and* web) hot-reload, so you don't have to rebuild after every edit. Drive it like:

```
OPENACME_DATA_DIR=~/.openacme-test pnpm dev
```

Pre-reqs (one time): write `~/.openacme-test/config.yaml` with `server: { port: 3211 }` and create at least one agent under `~/.openacme-test/agents/`. Everything (API + UI + HMR) is served on that single `server.port` — there is no separate or derived web port. The user's real daemon on `:3456` (if running) is untouched because the `server.port`s differ.

Don't `pnpm agent start` against the user's real data dir to "test" something — it kills their running daemon and dirties their sessions. Reach for the production daemon path only if you specifically need to validate the bundled-static install path.

For pure API smoke tests (no UI), the bundled-daemon path still works against the test slot:

```
pnpm agent start   --data-dir ~/.openacme-test --no-service --no-browser
pnpm agent restart --data-dir ~/.openacme-test --no-service --no-browser
pnpm agent stop    --data-dir ~/.openacme-test --no-service
pnpm agent status  --data-dir ~/.openacme-test --no-service
```

This serves the bundled UI if you've run `pnpm build` first (Hono falls back to `apps/web/out/` when `OPENACME_WEB_DEV` is unset). `--no-service` keeps it as a detached process; always `restart` rather than spawning a second daemon on the same slot.

**Driving the browser for UI tests.** Two options, both fine — pick whichever fits the loop. (1) The `playwright-cli` skill drives a live browser interactively: click, type, navigate, screenshot, observe console + network, all without writing a script. Best for "open the page, do the thing, look at the render." (2) For repeatable scripted checks, drive Playwright directly: one-time install `mkdir -p /tmp/pwt && cd /tmp/pwt && npm i @playwright/test && npx playwright install chromium`, then run one-shot `.mjs` files via `chromium.launch()`. Either way, **screenshot and open via Read to verify visually** — don't trust narrative without looking at the render.

---

## Releasing

Manual via Changesets — see `CONTRIBUTING.md`. Workflow `.github/workflows/release.yml` is `gh workflow run`-only, never automatic. Internal `workspace:*` deps auto-patch-bump per `.changeset/config.json` (`updateInternalDependencies: "patch"`). Provenance is **off** (private repo).

---

## Where to start when…

| Want to… | Open |
|---|---|
| Add a tool | `packages/tools/src/builtins/` + register in `index.ts` |
| Add an LLM provider | `packages/llm-provider/src/registry.ts` + `ProviderSchema` |
| Change agent loop | `packages/agent-core/src/{agent,messages,prompt}.ts` |
| Change compression | `packages/agent-core/src/compression.ts` (operates on `Step[]` flattened from `UIMessage[]`) |
| Add an HTTP route | `packages/server/src/app.ts` |
| Add a slash command | `apps/cli/src/tui/commands.ts` + a reducer action in `state.ts` |
| Touch chat UI | `apps/web/app/routes/index.tsx` (+ `app/components/`) |
| Add a custom UIMessage data part | server: `writer.write({type:"data-X", data, transient?})`; web: read transient in `useLiveSession({ onDataPart })`, non-transient renders from `messages` |
| Wire a new MCP server | per-agent `mcpServers` in config; nothing code-side if transport is stdio/SSE |
| Add an OAuth provider | `packages/auth/src/oauth-<name>.ts` + `transforms-<name>.ts` + plug into `llm-provider` factory |
| Persist a new field | `packages/db/src/schema.ts` + `pnpm db:generate` + the relevant store |
| Add config | `packages/config/src/schema.ts` |
| Change task state model / recurrence | `packages/tasks/src/{store,recurrence,types}.ts` |
| Change autonomous wake / scheduling | `packages/server/src/dispatcher.ts` (+ `Agent.runAutonomous` in `packages/agent-core/src/agent.ts`) |
| Add a task tool | `packages/tools/src/builtins/tasks.ts` — register, add to `SYSTEM_TOOLS` in `packages/tools/src/system.ts` |
| Add a browser tool | `packages/tools/src/builtins/browser/` + `BrowserManager` in `packages/browser/src/manager.ts` |
| Add a browser provider | new file in `packages/browser/src/providers/<name>.ts` implementing `BrowserProvider`; add to `PROVIDER_NAMES` + switch case in `providers/index.ts`; add to `BrowserConfigSchema.provider` enum in `packages/config/src/schema.ts` |
| Add a Skills Hub source | `packages/skills/src/hub/sources/<name>.ts` + register in `packages/skills/src/hub/hub.ts` (also extend `SkillSourceId` union + `schemas.ts`) |
| Add an agent template | `packages/agent-catalog/templates/<id>/{AGENT.md, resources/}` — frontmatter keys per the Agent catalog section |
| Ship a bundled skill | `packages/skills/builtin/<name>/SKILL.md` — installable via `{ source: "builtin", identifier: "<name>" }` |
| Edit shared workforce context | `<dataDir>/AGENTS.md` (web: Settings → Context) — restart-free; AgentManager evicts cached Agents on save |
| Add an always-on system tool | register handler in `packages/tools/src/builtins/`, add name to `SYSTEM_TOOLS` in `packages/tools/src/system.ts` |
