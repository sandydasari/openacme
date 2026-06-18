# @openacme/browser

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.0

## 0.10.0

## 0.9.1

## 0.9.0

## 0.8.0

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

## 0.5.3

## 0.5.2

### Patch Changes

- Pin `camoufox-js` to 0.9.3 (regular dep, no longer optional). camoufox-js@0.10.x bumped its `impit` dep to ^0.13.0, and impit@0.13.1+ ships a `preinstall: npx only-allow pnpm` hook that blocks every npm-based install. 0.9.3 → impit@^0.11.0 (no preinstall) and exposes the same `launchOptions` / `CamoufoxFetcher` / `installedVerStr` API our `binaries.ts` consumes. `npm install -g @openacme/cli` now produces a daemon with the Camoufox provider working out of the box.

## 0.5.1

### Patch Changes

- Make `camoufox-js` an optional dependency and whitelist native builds for pnpm 10+.

  Two install-blocking bugs in 0.5.0:
  1. **`camoufox-js → impit@0.13.1` carries `"preinstall": "npx only-allow pnpm"`**, which breaks every npm-based global install of `@openacme/cli`. Camoufox is one of several browser providers (chromium / browserbase / browser-use / firecrawl all work without it) and the browser code already lazy-imports `camoufox-js` with a try/catch (`packages/browser/src/binaries.ts`). Moved to `optionalDependencies` so failed installs don't fail the whole tree.
  2. **pnpm 10's strict build-script policy** silently skips native module builds, so `better-sqlite3` never compiles → `@openacme/db` crashes on import. Added `pnpm.onlyBuiltDependencies: ["better-sqlite3", "impit", "protobufjs"]` to `@openacme/cli`'s manifest so pnpm honors the build at install time without `pnpm approve-builds -g`.

  After this release, both `npm install -g @openacme/cli` and `pnpm add -g @openacme/cli` produce a working daemon.

## 0.5.0

## 0.4.0

### Minor Changes

- Release 0.4.0. First publish — synchronized with the rest of the workforce.
