# @openacme/agent-core

## 0.12.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.12.0
  - @openacme/db@0.12.0
  - @openacme/llm-provider@0.12.0
  - @openacme/memory@0.12.0
  - @openacme/tasks@0.12.0
  - @openacme/tools@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.11.0
  - @openacme/db@0.11.0
  - @openacme/llm-provider@0.11.0
  - @openacme/memory@0.11.0
  - @openacme/tasks@0.11.0
  - @openacme/tools@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.10.0
  - @openacme/db@0.10.0
  - @openacme/llm-provider@0.10.0
  - @openacme/memory@0.10.0
  - @openacme/tasks@0.10.0
  - @openacme/tools@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`1582351`](https://github.com/sandydasari/openacme/commit/1582351775c726619614498fa8ec2c01e4e5f42a)]:
  - @openacme/db@0.9.1
  - @openacme/tools@0.9.1
  - @openacme/config@0.9.1
  - @openacme/llm-provider@0.9.1
  - @openacme/memory@0.9.1
  - @openacme/tasks@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [[`b0d78ae`](https://github.com/sandydasari/openacme/commit/b0d78aed13b9286413fe4d679461cc4be5491e15)]:
  - @openacme/db@0.9.0
  - @openacme/tools@0.9.0
  - @openacme/config@0.9.0
  - @openacme/llm-provider@0.9.0
  - @openacme/memory@0.9.0
  - @openacme/tasks@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.8.0
  - @openacme/db@0.8.0
  - @openacme/llm-provider@0.8.0
  - @openacme/memory@0.8.0
  - @openacme/tasks@0.8.0
  - @openacme/tools@0.8.0

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
  - @openacme/config@0.7.0
  - @openacme/db@0.7.0
  - @openacme/llm-provider@0.7.0
  - @openacme/memory@0.7.0
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
  - @openacme/config@0.6.0
  - @openacme/db@0.6.0
  - @openacme/llm-provider@0.6.0
  - @openacme/memory@0.6.0
  - @openacme/tasks@0.6.0
  - @openacme/tools@0.6.0

## 0.5.3

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.5.3
  - @openacme/db@0.5.3
  - @openacme/llm-provider@0.5.3
  - @openacme/memory@0.5.3
  - @openacme/tasks@0.5.3
  - @openacme/tools@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies []:
  - @openacme/tools@0.5.2
  - @openacme/config@0.5.2
  - @openacme/db@0.5.2
  - @openacme/llm-provider@0.5.2
  - @openacme/memory@0.5.2
  - @openacme/tasks@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @openacme/tools@0.5.1
  - @openacme/config@0.5.1
  - @openacme/db@0.5.1
  - @openacme/llm-provider@0.5.1
  - @openacme/memory@0.5.1
  - @openacme/tasks@0.5.1

## 0.5.0

### Minor Changes

- Add `cacheTtl: "5m" | "1h"` to model config so callers can opt into Anthropic's 1-hour prompt-cache tier. Threaded into both Anthropic-cache code paths (native Anthropic via `applyAnthropicCacheControl(messages, ttl)` and OpenRouter+Claude via `injectAnthropicCacheControl(body, ttl)`). Per-agent UI in the agents page; workforce-wide default in Settings → Providers backed by new `GET /api/config` (extended) + `PUT /api/config/model`.

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.5.0
  - @openacme/llm-provider@0.5.0
  - @openacme/db@0.5.0
  - @openacme/tasks@0.5.0
  - @openacme/tools@0.5.0
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
  - @openacme/config@0.4.0
  - @openacme/db@0.4.0
  - @openacme/llm-provider@0.4.0
  - @openacme/tools@0.4.0
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
  - @openacme/config@0.3.0
  - @openacme/db@0.3.0
  - @openacme/llm-provider@0.3.0
  - @openacme/tools@0.3.0

## 0.2.0

### Patch Changes

- Anthropic Agent Skills standard + agent-loadable skill bodies.
  - `@openacme/skills` parses canonical top-level frontmatter (`tags`, `related-skills`) while still reading legacy `metadata.hermes.*`. Skill folders are walked at load time so companion files (`scripts/*`, `references/*`, …) are recorded as resources without being read until requested. New `parseSkillDirectory` + `Skill.resources`/`Skill.dirPath`.
  - `@openacme/tools` ships a new `skill_view` built-in (Level 1 progressive disclosure) bound from the server. Returns the SKILL.md body, the on-disk dir path, and the resource list — agents read companion files via the existing `read_file` / `shell` tools.
  - `@openacme/server` exposes `POST /api/skills/import` for multipart folder uploads (path-traversal guards, 200-entry / 10 MB cap, top-prefix stripping) and binds the skill registry into `skill_view`.
  - `@openacme/cli` adds `openacme skills list|view|add|remove` and a `/skills` slash command + read-only overlay in the TUI.
  - `@openacme/agent-core` system prompt now points the model at `skill_view`.
  - `@openacme/config` adds `skill_view` to the default agent tools array.

  All `@openacme/*` packages bump together (changeset `fixed` group) so users always get a uniform version across the workspace.

- Updated dependencies []:
  - @openacme/tools@0.2.0
  - @openacme/config@0.2.0
  - @openacme/db@0.2.0
  - @openacme/llm-provider@0.2.0
