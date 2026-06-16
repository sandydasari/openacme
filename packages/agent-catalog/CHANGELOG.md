# @openacme/agent-catalog

## 0.12.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.8.0

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

## 0.5.3

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies []:
  - @openacme/config@0.5.0

## 0.4.0

### Minor Changes

- Release 0.4.0. First publish — synchronized with the rest of the workforce.
