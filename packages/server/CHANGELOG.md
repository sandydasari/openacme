# @openacme/server

## 0.13.0

### Minor Changes

- [#53](https://github.com/sandydasari/openacme/pull/53) [`ef9ec2b`](https://github.com/sandydasari/openacme/commit/ef9ec2b4f998a9f5e0acd950128b862f7c6501c9) Thanks [@ukanwat](https://github.com/ukanwat)! - Agent-readable data-file attachments. Users can now attach zip, csv, tsv, json, txt, md, xlsx, docx, parquet, svg, xml, and yaml files. These are committed to disk and read by the agent via its tools rather than sent to the model, so even text-only models accept them. Attachments render rich in-chat previews — a file tree for archives, real spreadsheet tables (via SheetJS), csv/json previews — using the Pierre file-tree icon set for consistency with the resource browser.

### Patch Changes

- Updated dependencies [[`ef9ec2b`](https://github.com/sandydasari/openacme/commit/ef9ec2b4f998a9f5e0acd950128b862f7c6501c9)]:
  - @openacme/agent-core@0.13.0
  - @openacme/agent-catalog@0.13.0
  - @openacme/auth@0.13.0
  - @openacme/browser@0.13.0
  - @openacme/config@0.13.0
  - @openacme/db@0.13.0
  - @openacme/email@0.13.0
  - @openacme/llm-provider@0.13.0
  - @openacme/mcp-client@0.13.0
  - @openacme/memory@0.13.0
  - @openacme/skills@0.13.0
  - @openacme/tasks@0.13.0
  - @openacme/tools@0.13.0
  - @openacme/tool-host@0.7.7

## 0.12.0

### Minor Changes

- Ambient Acme, per-agent email, /skill mentions, and live config reload.
  - **Ambient Acme panel** — summon the platform helper from anywhere in the web UI; it floats instead of shifting layout, resumes the last session, and shows an active state in the sidebar. Chat engine extracted into a shared `useChatSession` so the panel reuses attachments + streaming. `CurrentViewContext` lets routes publish the focused entity, surfaced to Acme as a `data-ui-context` part (latest-only materialization) with a UI-context chip.
  - **Per-agent email** — each agent gets its own identity and isolated mailbox, with global IMAP/SMTP connection defaults, a Settings → Email tab, live config, and an editable OAuth redirect-URI override.
  - **/skill mentions** — reference skills inline in the composer via a `data-skill-ref` part with per-message materialization.
  - **Live config reload** — on-disk edits to `config.yaml` / `AGENTS.md` / skills apply live by evicting cached agents; global settings (model/email) reload without a restart. Replaces the config watcher with an explicit Acme-only `reload_config` tool; effective rw-path grants let Acme edit platform surfaces. Only `server.host` / `server.port` still need a restart.
  - **Fixes** — `web_search` no longer shows "0 results" for content-blob providers; no redirect to `/login` on a 401 while already on an auth page.
  - Refreshed the shipped Acme platform agent; added blog + changelog to the docs site, community health files, and color brand logos.

### Patch Changes

- Updated dependencies []:
  - @openacme/agent-catalog@0.12.0
  - @openacme/agent-core@0.12.0
  - @openacme/auth@0.12.0
  - @openacme/browser@0.12.0
  - @openacme/config@0.12.0
  - @openacme/db@0.12.0
  - @openacme/email@0.12.0
  - @openacme/llm-provider@0.12.0
  - @openacme/mcp-client@0.12.0
  - @openacme/memory@0.12.0
  - @openacme/skills@0.12.0
  - @openacme/tasks@0.12.0
  - @openacme/tools@0.12.0
  - @openacme/tool-host@0.7.6

## 0.11.0

### Patch Changes

- Updated dependencies [[`716ee56`](https://github.com/sandydasari/openacme/commit/716ee56ef4eb652a5c1c6eb1a6665ef867616e2a)]:
  - @openacme/tool-host@0.7.5
  - @openacme/agent-catalog@0.11.0
  - @openacme/agent-core@0.11.0
  - @openacme/auth@0.11.0
  - @openacme/browser@0.11.0
  - @openacme/config@0.11.0
  - @openacme/db@0.11.0
  - @openacme/llm-provider@0.11.0
  - @openacme/mcp-client@0.11.0
  - @openacme/memory@0.11.0
  - @openacme/skills@0.11.0
  - @openacme/tasks@0.11.0
  - @openacme/tools@0.11.0

## 0.10.0

### Minor Changes

- [#37](https://github.com/sandydasari/openacme/pull/37) [`d2d2df7`](https://github.com/sandydasari/openacme/commit/d2d2df71f6678c913cfa5ffa641c9b1c465cad2a) Thanks [@ukanwat](https://github.com/ukanwat)! - Local-trusted auth: zero-credential local installs, full admin for shared ones.
  - **Local installs are frictionless again.** On a loopback bind (the default) the daemon auto-establishes a real session for loopback requests, so opening `http://127.0.0.1:3456` lands straight in the app — no claim page, no login form. Auth stays on under the hood (a real `local@localhost` operator + session). The per-request `Host` header is the gate: a non-loopback `Host` (DNS-rebind, or a tunnel/proxy) is never auto-trusted.
  - **Sharing requires a login.** `openacme expose` rewrites config to bind the network + require an account, then restarts — one command covers tunnels, reverse proxies, and direct IP. `openacme expose --off` reverses it. Exposing rotates the local operator out so its loopback cookie can't be replayed remotely. (`server.requireAuth` forces a login on a loopback bind for the rare tunnel-without-an-open-port case.)
  - **Web member admin (Settings → Members).** For shared installs: signed-in-as + sign out, the member roster + revoke, and one-click invite-link generation — previously CLI-only. Deployment-mode aware: local installs see an "invite your team" explainer with a docs link instead.
  - **Reachable claim/invite links.** `openacme claim` / `invite` and the boot log no longer print `localhost` when shared — they use a detected address (or a clear placeholder) and hint to substitute your domain/public IP.
  - A branded 404 page, and a docs link in the sidebar.

### Patch Changes

- Updated dependencies []:
  - @openacme/agent-catalog@0.10.0
  - @openacme/agent-core@0.10.0
  - @openacme/auth@0.10.0
  - @openacme/browser@0.10.0
  - @openacme/config@0.10.0
  - @openacme/db@0.10.0
  - @openacme/llm-provider@0.10.0
  - @openacme/mcp-client@0.10.0
  - @openacme/memory@0.10.0
  - @openacme/skills@0.10.0
  - @openacme/tasks@0.10.0
  - @openacme/tools@0.10.0
  - @openacme/tool-host@0.7.4

## 0.9.1

### Patch Changes

- Updated dependencies [[`1582351`](https://github.com/sandydasari/openacme/commit/1582351775c726619614498fa8ec2c01e4e5f42a)]:
  - @openacme/db@0.9.1
  - @openacme/agent-core@0.9.1
  - @openacme/tools@0.9.1
  - @openacme/mcp-client@0.9.1
  - @openacme/tool-host@0.7.3
  - @openacme/agent-catalog@0.9.1
  - @openacme/auth@0.9.1
  - @openacme/browser@0.9.1
  - @openacme/config@0.9.1
  - @openacme/llm-provider@0.9.1
  - @openacme/memory@0.9.1
  - @openacme/skills@0.9.1
  - @openacme/tasks@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [[`b0d78ae`](https://github.com/sandydasari/openacme/commit/b0d78aed13b9286413fe4d679461cc4be5491e15)]:
  - @openacme/db@0.9.0
  - @openacme/agent-core@0.9.0
  - @openacme/tools@0.9.0
  - @openacme/mcp-client@0.9.0
  - @openacme/tool-host@0.7.2
  - @openacme/agent-catalog@0.9.0
  - @openacme/auth@0.9.0
  - @openacme/browser@0.9.0
  - @openacme/config@0.9.0
  - @openacme/llm-provider@0.9.0
  - @openacme/memory@0.9.0
  - @openacme/skills@0.9.0
  - @openacme/tasks@0.9.0

## 0.8.0

### Minor Changes

- [#29](https://github.com/sandydasari/openacme/pull/29) [`f30a4c0`](https://github.com/sandydasari/openacme/commit/f30a4c08cf36de512c88b37594eac5b92dae20cf) Thanks [@ukanwat](https://github.com/ukanwat)! - Release 0.8.0 — a large batch of work since 0.7.0 across the whole workforce
  platform. All `@openacme/*` packages move together (fixed group).

  Highlights:
  - **Per-member authentication.** Replaces the single shared access-secret with
    email/password accounts (flat-role admins), stateful sessions, first-run
    claim via a one-time setup link, and out-of-band invite links. No loopback
    bypass; `/api/health` stays unauthenticated. CLI: `claim`, `invite`,
    `members list|revoke`. **Breaking:** existing installs re-onboard once (the
    old `secret` file is ignored; first boot prints a claim link).
  - **Usage ledger** — per-call token/cost metering, `/api/usage`, and a `/usage`
    page (overview, breakdown, activity, forecast).
  - **Teams org chart** and a tasks-board UX overhaul (searchable filters,
    smoother kanban drag, humanized times, board-mode detail sheet).
  - **Inline markdown editing** (TipTap) across web panes.
  - **Landing page + docs site** (Fumadocs static export), including the
    remote-access and self-hosting guides.
  - **Latest model presets** refresh.
  - Real end-to-end test suite (HTTP + browser) behind a no-mock model seam.
  - Default server port changed `3210` → `3456`.
  - Tool-host scaling fixes: lazy worker spawn, cached stdio MCP discovery,
    bounded per-session shells.

### Patch Changes

- Updated dependencies []:
  - @openacme/agent-catalog@0.8.0
  - @openacme/agent-core@0.8.0
  - @openacme/auth@0.8.0
  - @openacme/browser@0.8.0
  - @openacme/config@0.8.0
  - @openacme/db@0.8.0
  - @openacme/llm-provider@0.8.0
  - @openacme/mcp-client@0.8.0
  - @openacme/memory@0.8.0
  - @openacme/skills@0.8.0
  - @openacme/tasks@0.8.0
  - @openacme/tools@0.8.0
  - @openacme/tool-host@0.7.1

## 0.7.0

### Minor Changes

- **Mobile-ready PWA with web push notifications, and editorial workflow refinements.**

  This release wires `ping_user` agent events through to native mobile notifications and lands a full mobile-responsive UI pass so the operator can run the workforce from their phone.

  **Push pipeline (`@openacme/db`, `@openacme/server`)**
  - New `push_subscriptions` table + `PushStore` for per-device endpoints (single-operator deployment, unique endpoint upsert).
  - `PushDispatcher` fan-outs every `ping_user` event to subscribed devices via web-push, with 404/410 endpoint cleanup. VAPID keys auto-generate to `<dataDir>/push-vapid.json` (mode 0600) on first boot.
  - New routes: `GET /api/push/vapid-public-key`, `POST|DELETE /api/push/subscribe`, `GET|DELETE /api/push/subscriptions`, `POST /api/push/test`.
  - Auth middleware whitelists `/sw.js`, `/manifest.webmanifest`, and PWA icons pre-login so iOS can fetch the manifest before a session cookie exists.
  - VAPID subject defaults to a valid mailto URI (Apple's push service rejects `.local` domains with 403).
  - Service worker uses `renotify: true` so same-tag pushes still alert; test pings use a unique tag per fire.

  **Web app: mobile responsive + PWA shell**
  - Bottom tab bar replaces the hamburger drawer on mobile; sidebar is desktop-only.
  - Manifest, hand-rolled service worker (push event + notificationclick with `includeUncontrolled: true`), generated icons, apple-touch-icon.
  - Master/detail layouts on `/agents`, `/tasks`, `/skills`, `/settings` column-stack on mobile with a back-to-list pill.
  - Task dialog goes full-takeover above the tab bar on mobile.
  - iOS standalone-PWA auth fallback: secret is also stored in `localStorage` and injected as `Authorization: Bearer` on every API call, so cookie eviction between PWA launches doesn't force re-login. Login page silently re-authenticates from the stored token.
  - Service worker auto re-subscribes to push on every launch when permission is already granted (handles iOS subscription eviction).
  - One-tap "Enable notifications" prompt on first PWA launch.

  **Memory (`@openacme/memory`)**
  - `DEFAULT_MEMORY_CHAR_LIMIT` raised from 2200 to 4000 — accommodates ~60-80 tight one-liner index entries before consolidation pressure kicks in. Per-agent override via `memoryCharLimit` frontmatter unchanged.

  **Tools (`@openacme/tools`)**
  - **Removed `web_upload` built-in.** It only served one workflow (catbox → URL for Buffer's createPost). Agents that need catbox upload should configure a small stdio MCP server via per-agent `mcpServers` — keeps the third-party host boundary visible in the agent's frontmatter rather than bundled platform-wide.

### Patch Changes

- Updated dependencies []:
  - @openacme/agent-catalog@0.7.0
  - @openacme/agent-core@0.7.0
  - @openacme/auth@0.7.0
  - @openacme/browser@0.7.0
  - @openacme/config@0.7.0
  - @openacme/db@0.7.0
  - @openacme/llm-provider@0.7.0
  - @openacme/mcp-client@0.7.0
  - @openacme/memory@0.7.0
  - @openacme/skills@0.7.0
  - @openacme/tasks@0.7.0
  - @openacme/tools@0.7.0

## 0.6.0

### Minor Changes

- @openacme/\* → 0.6.0

  Highlights since 0.5.3:
  - **Multimodal `read_file`** — images render inline in chat; screenshots from `browser_take_screenshot` flow through the same path.
  - **Browser overhaul** — pluggable providers (local Chrome, Browserbase, Browser-Use, Firecrawl), per-agent sessions, auto-provisioned Browserbase contexts, tool-result spill to attachments.
  - **Agent-scoped `session_search`** — full-text search now scoped to the caller's agent; no cross-agent leakage.
  - **Rename-swap compaction** — preflight + UX fixes; dead fork bookkeeping removed.
  - **Web design pass** — Cmd-K palette, workforce status, signal-blue meta, bounded search + FTS5 endpoint, agent filter polish.
  - **Auth picker** with provider-availability gating; upstream provider errors surfaced in chat UI.
  - **Software Engineer** agent template rebuilt with a real SWE persona.
  - Fixes: ChatGPT OAuth (two fixes), Browser-Use `/api/v2` profile auto-create, `context-1m` beta dropped on OAuth path, web behind reverse proxy.

### Patch Changes

- Updated dependencies []:
  - @openacme/agent-catalog@0.6.0
  - @openacme/agent-core@0.6.0
  - @openacme/auth@0.6.0
  - @openacme/browser@0.6.0
  - @openacme/config@0.6.0
  - @openacme/db@0.6.0
  - @openacme/llm-provider@0.6.0
  - @openacme/mcp-client@0.6.0
  - @openacme/memory@0.6.0
  - @openacme/skills@0.6.0
  - @openacme/tasks@0.6.0
  - @openacme/tools@0.6.0

## 0.5.3

### Patch Changes

- Ship the web UI's static export in the published `@openacme/server` tarball. The package's `prepack` script already copied `apps/web/out` → `packages/server/web`, but the `files` allowlist excluded `web/`, so the static files were silently dropped from the publish. Result: every `npm install -g @openacme/cli` install loaded the API on :3210 but returned 404 on `/`. Adding `"web"` to `files` makes the published Hono daemon serve the bundled UI as documented.

- Updated dependencies []:
  - @openacme/agent-catalog@0.5.3
  - @openacme/agent-core@0.5.3
  - @openacme/auth@0.5.3
  - @openacme/browser@0.5.3
  - @openacme/config@0.5.3
  - @openacme/db@0.5.3
  - @openacme/llm-provider@0.5.3
  - @openacme/mcp-client@0.5.3
  - @openacme/memory@0.5.3
  - @openacme/skills@0.5.3
  - @openacme/tasks@0.5.3
  - @openacme/tools@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies []:
  - @openacme/browser@0.5.2
  - @openacme/tools@0.5.2
  - @openacme/agent-core@0.5.2
  - @openacme/mcp-client@0.5.2
  - @openacme/agent-catalog@0.5.2
  - @openacme/auth@0.5.2
  - @openacme/config@0.5.2
  - @openacme/db@0.5.2
  - @openacme/llm-provider@0.5.2
  - @openacme/memory@0.5.2
  - @openacme/skills@0.5.2
  - @openacme/tasks@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @openacme/browser@0.5.1
  - @openacme/tools@0.5.1
  - @openacme/agent-core@0.5.1
  - @openacme/mcp-client@0.5.1
  - @openacme/agent-catalog@0.5.1
  - @openacme/auth@0.5.1
  - @openacme/config@0.5.1
  - @openacme/db@0.5.1
  - @openacme/llm-provider@0.5.1
  - @openacme/memory@0.5.1
  - @openacme/skills@0.5.1
  - @openacme/tasks@0.5.1

## 0.5.0

### Minor Changes

- Add `cacheTtl: "5m" | "1h"` to model config so callers can opt into Anthropic's 1-hour prompt-cache tier. Threaded into both Anthropic-cache code paths (native Anthropic via `applyAnthropicCacheControl(messages, ttl)` and OpenRouter+Claude via `injectAnthropicCacheControl(body, ttl)`). Per-agent UI in the agents page; workforce-wide default in Settings → Providers backed by new `GET /api/config` (extended) + `PUT /api/config/model`.

### Patch Changes

- Updated dependencies []:
  - @openacme/agent-core@0.5.0
  - @openacme/config@0.5.0
  - @openacme/llm-provider@0.5.0
  - @openacme/agent-catalog@0.5.0
  - @openacme/db@0.5.0
  - @openacme/mcp-client@0.5.0
  - @openacme/skills@0.5.0
  - @openacme/tasks@0.5.0
  - @openacme/tools@0.5.0
  - @openacme/auth@0.5.0
  - @openacme/browser@0.5.0
  - @openacme/memory@0.5.0

## 0.4.0

### Minor Changes

- Release 0.4.0.

  Highlights since 0.3.0:
  - **Browser tool**: managed Chrome via CDP with shared user-data-dir and per-agent tab ownership; ten `browser_*` tools.
  - **Tasks v2**: comments + events split out of the task body into SQLite; pure event-driven scheduler with debounced wakes, echo suppression, lazy session allocation, recurring self-reset, and mid-turn event injection.
  - **Agent catalog**: bespoke in-tree templates importable into the workforce (CLI `agents catalog` / `agents import`, web modal). Ships the Coder and Acme platform templates.
  - **Skills Hub**: install + track skills from GitHub, marketplaces, URLs, `.well-known`, LobeHub, Skills.sh, ClawHub, local dirs, and a new `builtin` source.
  - **AGENTS.md**: shared workforce context injected into every agent's prompt; restart-free updates via cache eviction.
  - **Per-agent workspace + resources**: `<agentDir>/workspace/` as default cwd with a session-persistent shell, and `<agentDir>/resources/` listed in the prompt.
  - **First-run setup wizard**: provider credentials, model seed, agent creation — web + CLI.
  - **SSE-only streaming** for interactive turns: agent runs are server-owned, the originating tab is just another subscriber.
  - **Pino-backed structured logger** with OTel log export.
  - **LLM-generated session titles** via a structured subagent.
  - **Operator home page** with live SSE, plus `ping_user` / `sleep` primitives.
  - **Workforce framing**: `role` + `agent_list` tool + peer-notes memory; silent OAuth recovery via Claude Code re-import.
  - **Design refresh**: four-color signal system, unified task activity timeline, polished OAuth callback, CLI per-tool rendering with green/red diff backgrounds.

### Patch Changes

- Updated dependencies []:
  - @openacme/agent-core@0.4.0
  - @openacme/auth@0.4.0
  - @openacme/config@0.4.0
  - @openacme/db@0.4.0
  - @openacme/llm-provider@0.4.0
  - @openacme/mcp-client@0.4.0
  - @openacme/skills@0.4.0
  - @openacme/tools@0.4.0
  - @openacme/agent-catalog@0.1.1
  - @openacme/tasks@0.1.1

## 0.3.0

### Minor Changes

- Per-agent state (memory + tasks), AI SDK v6 migration, MCP HTTP + OAuth, prompt caching, attachments, and a paper-aesthetic web UI.
  - **Per-agent persistent memory** (`@openacme/memory`) and **per-agent task store + scheduler** (`@openacme/tasks`) — both filesystem-backed, scoped by agent id. New `task_*` and `memory` built-in tools.
  - **AI SDK v4 → v6 migration** end-to-end. `UIMessage` is now the canonical shape across DB rows, persistence, agent input, server response, and web render. Web uses `@ai-sdk/react`'s `useChat` + `DefaultChatTransport`; server uses `createUIMessageStream` over `Agent.runStream`. Zod 3 → 4.
  - **Anthropic prompt caching** for native and OpenRouter Claude paths; cache markers preserve string content as string when marking cacheable.
  - **MCP**: first-class Streamable HTTP transport with OAuth 2.1 client, plus `cwd` for stdio servers. Web + CLI editors for per-agent MCP server config.
  - **Web UI**: paper-aesthetic redesign, theme toggle (system/light/dark) with light-mode contrast pass, single-URL dev (Hono fronts UI on `:3210` via proxy to Next; published serves the bundled static export from the same port), proper date-time picker and searchable assignee in the task modal, inline custom views and git-style diffs in tool rendering, attachments via picker / drag-drop / `@`-fuzzy file picker.
  - **CLI**: cancellable turns, credential-aware model pickers, windowed session picker that surfaces agent name, background daemon mode with secret-auth for non-loopback access, consolidated `pnpm agent <subcommand>` aliases.
  - **Server**: RFC 5987 Content-Disposition for non-ASCII attachment filenames; `/api/health` now reports the actual server package version instead of a hardcoded string. Always-on system tools (agent introspection / self-management) merged into every agent's effective tool set and hidden from the user-facing tool picker.

### Patch Changes

- Updated dependencies []:
  - @openacme/agent-core@0.3.0
  - @openacme/auth@0.3.0
  - @openacme/config@0.3.0
  - @openacme/db@0.3.0
  - @openacme/llm-provider@0.3.0
  - @openacme/mcp-client@0.3.0
  - @openacme/skills@0.3.0
  - @openacme/tools@0.3.0

## 0.2.0

### Minor Changes

- Anthropic Agent Skills standard + agent-loadable skill bodies.
  - `@openacme/skills` parses canonical top-level frontmatter (`tags`, `related-skills`) while still reading legacy `metadata.hermes.*`. Skill folders are walked at load time so companion files (`scripts/*`, `references/*`, …) are recorded as resources without being read until requested. New `parseSkillDirectory` + `Skill.resources`/`Skill.dirPath`.
  - `@openacme/tools` ships a new `skill_view` built-in (Level 1 progressive disclosure) bound from the server. Returns the SKILL.md body, the on-disk dir path, and the resource list — agents read companion files via the existing `read_file` / `shell` tools.
  - `@openacme/server` exposes `POST /api/skills/import` for multipart folder uploads (path-traversal guards, 200-entry / 10 MB cap, top-prefix stripping) and binds the skill registry into `skill_view`.
  - `@openacme/cli` adds `openacme skills list|view|add|remove` and a `/skills` slash command + read-only overlay in the TUI.
  - `@openacme/agent-core` system prompt now points the model at `skill_view`.
  - `@openacme/config` adds `skill_view` to the default agent tools array.

  All `@openacme/*` packages bump together (changeset `fixed` group) so users always get a uniform version across the workspace.

### Patch Changes

- Updated dependencies []:
  - @openacme/skills@0.2.0
  - @openacme/tools@0.2.0
  - @openacme/agent-core@0.2.0
  - @openacme/config@0.2.0
  - @openacme/mcp-client@0.2.0
  - @openacme/db@0.2.0
  - @openacme/llm-provider@0.2.0
  - @openacme/auth@0.2.0
