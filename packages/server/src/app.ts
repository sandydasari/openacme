import { Hono } from "hono";
import { cors } from "hono/cors";
import { createLogger } from "@openacme/config/logger";
import { readRawConfig, writeRawConfig } from "@openacme/config";
import {
  isCamoufoxInstalled,
  isCamoufoxPrefetching,
  prefetchCamoufox,
} from "@openacme/browser";

const log = createLogger("server.app");

import {
  createUIMessageStream,
  readUIMessageStream,
  type UIMessage,
} from "ai";
import {
  ensureStepBoundaries,
  extractErrorText,
  extractStatusCode,
  finalizeOrphanToolParts,
  sanitizeStoredHistory,
  type ModelResolver,
  type OpenAcmeUIMessage,
} from "@openacme/agent-core";
import { AgentManager } from "./agent-manager.js";
import { authMiddleware } from "./middleware/auth.js";
import { registerAuthRoutes, registerMemberRoutes } from "./routes/auth.js";
import { registerUploadsRoutes, type UploadsContext } from "./routes/uploads.js";
import { registerFilesRoutes } from "./routes/files.js";
import { registerFsRoutes } from "./routes/fs.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerTeamRoutes } from "./routes/teams.js";
import { registerSetupRoutes, setDefaultModelIfUnset } from "./routes/setup.js";
import { registerSkillsHubRoutes } from "./routes/skills-hub.js";
import { registerAgentCatalogRoutes } from "./routes/agent-catalog.js";
import { registerEmailRoutes } from "./routes/email.js";
import { registerStreamRoutes } from "./routes/streams.js";
import { registerHomeRoutes } from "./routes/home.js";
import { registerPushRoutes } from "./routes/push.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { SkillHub, HubError } from "@openacme/skills";
import {
  AgentDefinitionSchema,
  MCPServerConfigSchema,
  ModelConfigSchema,
  loadGlobalMcpServers,
  saveGlobalMcpServers,
  lookupModelMetadata,
  resolveDeploymentMode,
  reachableBaseUrl,
  type Config,
  type AgentDefinition,
  type MCPServerConfig,
  type ModelConfig,
  type Provider,
} from "@openacme/config";
import {
  listProviders,
  MODEL_PRESETS,
  detectProviderCredentials,
} from "@openacme/llm-provider";
import { registry as toolRegistry, closeShellSession } from "@openacme/tools";
import { MCPClient } from "@openacme/mcp-client";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

const PENDING_URL_RE = /^\/api\/attachments\/__pending__\/(pend_[^/]+)\/(.+)$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PKG_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
    );
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// Wire shapes for `/api/config` + `PUT /api/config/model`. Derived from the
// existing `ModelConfig` so there's no parallel definition to drift —
// strip `apiKey` (lives in .env, never on the wire) and surface the two
// fields the schema guarantees as defaults (`auth`, `cacheTtl`) as
// non-optional on the GET response.
type ModelDefaultsView = Omit<ModelConfig, "apiKey"> &
  Required<Pick<ModelConfig, "auth" | "cacheTtl">>;
export type ModelDefaultsUpdate = Omit<Partial<ModelConfig>, "apiKey">;

const ModelDefaultsUpdateSchema = ModelConfigSchema.partial().omit({
  apiKey: true,
});

export interface ConfigResponse {
  dataDir: string;
  model: ModelDefaultsView;
  server: Config["server"];
  behavior: Config["behavior"];
  skills: Config["skills"];
}

export interface ConfigModelUpdateResponse {
  ok: true;
  requiresRestart: boolean;
}

/**
 * Create the Hono HTTP app with all API routes.
 */
export async function createApp(
  config: Config,
  opts?: { resolveModel?: ModelResolver; tickIntervalMs?: number }
): Promise<{ app: Hono; manager: AgentManager }> {
  const app = new Hono();
  const manager = new AgentManager(config, opts);

  // Per-session abort handles for in-flight interactive turns. Survives
  // the HTTP request that initiated the turn — SSE-only streaming means
  // the POST returns before the agent finishes; cancel is the only
  // remaining path. Cleared on completion or DELETE active-turn.
  const activeTurns = new Map<string, AbortController>();

  // Middleware. CORS stays permissive (tunnels / reverse proxies depend on
  // it) but credentials-less: the default wildcard ACAO can't carry cookies,
  // so a cross-origin page can't read authenticated responses. The session
  // cookie's SameSite=Lax + HttpOnly is the real CSRF/exfil backstop.
  app.use("/*", cors());

  // Auth: per-member email+password with stateful sessions (see
  // @openacme/db AuthStore). The mode is derived from the bind host —
  // `local_trusted` (loopback) transparently auto-sessions loopback requests
  // so a local user never logs in; `authenticated` (non-loopback, or
  // requireAuth) needs a real login. Login + enrollment routes mount BEFORE
  // the gate (reachable without a session); member management mounts after.
  const deploymentMode = resolveDeploymentMode(config.server);

  // Boot reconciliation: when not local_trusted, a stale loopback operator
  // from a previous local boot must not be a valid remote login. Its sessions
  // cascade-delete; if that empties the roster, the claim flow takes over.
  if (deploymentMode === "authenticated") {
    manager.authStore.deleteLocalOperator();
  }

  registerAuthRoutes(app, { store: manager.authStore, deploymentMode });
  registerSetupRoutes(app, { dataDir: config.dataDir, manager });
  app.use("/*", authMiddleware({ store: manager.authStore, deploymentMode }));
  registerMemberRoutes(app, { store: manager.authStore });

  // Fresh install / post-upgrade on an exposed install: no members yet →
  // mint a one-time claim token and print the setup link to the log. Reading
  // the log is the proof-of-deployer that gates first-run (closes the
  // public-URL claim window). Skipped in local_trusted — a local user is
  // auto-sessioned and never claims.
  if (
    deploymentMode === "authenticated" &&
    manager.authStore.countMembers() === 0
  ) {
    const { token } = manager.authStore.createEnrollToken();
    const { url } = reachableBaseUrl(config.server);
    log.warn(
      { setupPath: `/setup?token=${token}` },
      `No operator account yet. Claim this instance at ${url}/setup?token=${token}` +
        ` (use your domain/public IP if you reach this server by another name)`
    );
  }

  // Attachment upload + serve routes. The orphan map returned here is
  // shared with /api/chat below so we can resolve `attachmentId` parts
  // back to a path on disk.
  const uploads: UploadsContext = registerUploadsRoutes(app, manager);

  // Static-style serve for agent-side binary content (read_file on
  // image/PDF, screenshots). Sibling to /api/attachments — see
  // routes/files.ts for the trust-model distinction.
  registerFilesRoutes(app, manager);

  // Scoped file browser API: agent workspace/resources + team workspace
  // (listing, Range-capable bytes, batch stat for the chat linkifier).
  registerFsRoutes(app, manager, config);

  // Tasks: founder read/edit/delete. POST is intentionally absent — task
  // creation is agent-only via the `task_create` tool.
  registerTaskRoutes(app, manager);

  // Teams: human-owned rosters + charters. No DELETE (archive instead);
  // no agent-side write path by design.
  registerTeamRoutes(app, manager);

  // Bundled agent catalog — browse + import templates. Mount before the
  // generic /api/agents/:id so /api/agents/catalog/* takes the specific path.
  registerAgentCatalogRoutes(app, manager, config);

  // Per-agent email: bind IMAP / run Gmail+Graph OAuth, status, unbind.
  // Specific /api/agents/:id/email paths + the /api/email/oauth/callback
  // redirect target. Mounted after authMiddleware (the OAuth redirect
  // carries the member cookie in authenticated mode; open mode passes all).
  registerEmailRoutes(app, manager, config);

  // Live SSE streams: per-session (chat pane live updates) and
  // workforce-wide (home page row deltas). Mounted before generic
  // session routes so /api/sessions/:id/stream resolves to the SSE
  // handler, not the generic catch-all.
  registerStreamRoutes(app, manager);

  // Home page payload + workforce summary stream. The structured GET
  // is paired with the workforce stream above for live updates.
  registerHomeRoutes(app, manager);

  // Web Push subscribe / unsubscribe / VAPID key / test. Inherits the
  // shared authMiddleware so tunnel-exposed deployments require the
  // same access secret as everything under /api/.
  registerPushRoutes(app, manager);

  // Usage ledger reads: summary / series / breakdown / heatmap / events.
  registerUsageRoutes(app, manager);

  // Health check
  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      version: PKG_VERSION,
      agents: manager.listAgents().length,
      skills: manager.skillRegistry.size,
    })
  );

  // ── Agents ──
  app.get("/api/agents", (c) => {
    const agents = manager.listAgents();
    return c.json(agents);
  });

  app.get("/api/agents/:id", (c) => {
    // Return the full AgentDefinition (matches what GET /api/agents
    // lists), not the runtime AgentConfig — the latter drops
    // persisted-only fields like `role` that the web UI needs.
    const def = manager.getAgentDef(c.req.param("id"));
    if (!def) return c.json({ error: "Agent not found" }, 404);
    return c.json(def);
  });

  app.post("/api/agents", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Add default id if not provided
    const id = (body.id as string) || randomUUID();

    // Validate and apply defaults using Zod schema
    const parseResult = AgentDefinitionSchema.safeParse({ ...body, id });
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((e: { path: PropertyKey[]; message: string }) => `${e.path.join(".")}: ${e.message}`);
      return c.json({ error: "Validation failed", details: errors }, 400);
    }

    const def = parseResult.data;
    try {
      await manager.createAgent(def);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return c.json(def, 201);
  });

  app.put("/api/agents/:id", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    try {
      const updated = await manager.updateAgent(c.req.param("id"), body);
      return c.json(updated);
    } catch (e) {
      const message = (e as Error).message;
      // Distinguish between not found and other errors
      if (message.includes("not found")) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: message }, 400);
    }
  });

  app.delete("/api/agents/:id", async (c) => {
    const id = c.req.param("id");
    try {
      // Check if agent exists first
      manager.getAgent(id);
    } catch {
      return c.json({ error: "Agent not found" }, 404);
    }
    try {
      await manager.deleteAgent(id);
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ── Sessions ──
  // listActive (not list) hides sessions that have been compressed away —
  // parents that have a child session pointing at them. Otherwise the sidebar
  // shows the same conversation twice (parent + child) after a compression
  // fork.
  app.get("/api/agents/:id/sessions", (c) => {
    const sessions = manager.sessionStore.listActive(c.req.param("id"));
    return c.json(sessions);
  });

  app.get("/api/sessions/:id/messages", (c) => {
    // Returns UIMessage[] verbatim — useChat consumes these directly via
    // setMessages on session change.
    const messages = sanitizeStoredHistory(
      manager.messageStore.getHistory(c.req.param("id"))
    );
    return c.json(messages);
  });

  app.get("/api/sessions/:id", (c) => {
    // Session metadata (title, agent id, timestamps). Used by the chat
    // header to render the session title instead of just the id slug.
    const id = c.req.param("id");
    const session = manager.sessionStore.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  app.delete("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const session = manager.sessionStore.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    // Tasks bound to this session would otherwise become zombies — the
    // scheduler can't allocate a fresh session for an already-bound task
    // and silently drops events for the missing session. Null out
    // bindings; reset in_progress tasks to open so they can be re-picked.
    const orphaned = manager.taskStore.list({ session_id: id });
    for (const t of orphaned) {
      if (t.status === "done" || t.status === "canceled") continue;
      const patch: { session_id: null; status?: "open" } = { session_id: null };
      if (t.status === "in_progress") patch.status = "open";
      try {
        await manager.taskStore.update(t.id, patch, { actor: "system:user" });
      } catch (e) {
        log.warn(
          { err: e, taskId: t.id, sessionId: id },
          "failed to clear task binding on session delete"
        );
      }
    }
    // messages cascade-delete via FK; FTS triggers keep the index in sync
    manager.sessionStore.delete(id);
    // Reap the per-session bash subprocess if one was running — local
    // (unbound test paths) and in the agent's tool-host worker.
    closeShellSession(session.agentId, id);
    manager.toolHostManager.notifySessionClosed(session.agentId, id);
    // Drop the broadcaster's ring buffer + subscriber set for this
    // session so a deleted session's last 50 events don't sit in
    // memory until process restart.
    manager.broadcaster.forget(id);
    return c.json({ success: true });
  });

  // ── Chat ──
  // Client owns sessionId + user-message id; the server uses both
  // verbatim so the optimistic upsert in the originating tab converges
  // with the `messages_appended` echo. Caller must subscribe SSE before
  // posting — chunks flow there, not over this response.
  app.post("/api/chat", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const { agentId, sessionId, messages } = body as {
      agentId: string;
      sessionId?: string;
      messages: unknown;
    };

    if (!agentId || !Array.isArray(messages)) {
      return c.json(
        { error: "agentId and messages[] are required" },
        400
      );
    }

    const def = manager.getAgentDef(agentId);
    if (!def) return c.json({ error: "Agent not found" }, 404);

    // Cheap upfront gate before we touch attachments / persist anything.
    // The Agent build path throws the same message if we let it through,
    // but a 400 here keeps the SSE channel clean and lets the web's
    // ChatSetupPanel render the "configure a provider" state synchronously.
    if (!def.model.provider || !def.model.model) {
      return c.json(
        {
          error:
            "No model configured. Add an API key or sign in via OAuth in Settings.",
        },
        400
      );
    }

    const effectiveSessionId = sessionId || randomUUID();

    // Validate-then-commit: walk the incoming messages once to collect
    // every pending id; verify they're all known; only then commit (move
    // files under the session dir). Naive map-and-commit has a partial-
    // failure footgun — earlier files would be moved before a later
    // unknown id triggers the 400, leaving orphan files in the session
    // dir with no message row to reference them.
    const incoming = messages as UIMessage[];
    const pendingIds: string[] = [];
    for (const m of incoming) {
      if (m.role !== "user") continue;
      for (const p of m.parts) {
        const tp = p as { type?: string; url?: string };
        if (tp.type !== "file" || typeof tp.url !== "string") continue;
        const match = tp.url.match(PENDING_URL_RE);
        if (!match) continue;
        const pendingId = match[1]!;
        if (!uploads.pending.has(pendingId)) {
          return c.json(
            { error: `Unknown or expired attachment: ${pendingId}` },
            400
          );
        }
        pendingIds.push(pendingId);
      }
    }

    // All pending ids are known — safe to commit. Cache results so
    // each id only commits once even if referenced by multiple parts
    // (defensive — useChat won't normally do that, but the user could
    // hand-craft a request).
    const committedById = new Map<
      string,
      ReturnType<typeof uploads.commit>
    >();
    const attachmentKinds: Array<"image" | "file"> = [];
    const committed = incoming.map((m) => {
      if (m.role !== "user") return m;
      const parts = m.parts.map((p) => {
        const tp = p as { type?: string; url?: string };
        if (tp.type !== "file" || typeof tp.url !== "string") return p;
        const match = tp.url.match(PENDING_URL_RE);
        if (!match) return p;
        const pendingId = match[1]!;
        let result = committedById.get(pendingId);
        if (result === undefined) {
          result = uploads.commit(pendingId, effectiveSessionId);
          committedById.set(pendingId, result);
        }
        if (!result) return p;
        attachmentKinds.push(result.kind);
        return {
          ...(p as object),
          url: result.url,
          mediaType: result.mediaType,
          filename: result.filename,
        } as typeof p;
      });
      return { ...m, parts };
    });

    // Provider gating: reject file/image parts on text-only models. The
    // bundled registry's `inputModalities` is the source of truth; an
    // empty/missing list means "unknown" and we let the request through.
    if (attachmentKinds.length > 0) {
      const meta = lookupModelMetadata(def.model);
      if (meta.inputModalities && meta.inputModalities.length > 0) {
        const allowed = new Set(meta.inputModalities);
        const hasImg = attachmentKinds.includes("image");
        const hasFile = attachmentKinds.includes("file");
        if (hasImg && !allowed.has("image")) {
          return c.json(
            {
              error: `Model '${def.model.model}' does not accept images`,
              supportedModalities: meta.inputModalities,
            },
            400
          );
        }
        if (
          hasFile &&
          !allowed.has("pdf") &&
          !allowed.has("file")
        ) {
          return c.json(
            {
              error: `Model '${def.model.model}' does not accept PDFs/files`,
              supportedModalities: meta.inputModalities,
            },
            400
          );
        }
      }
    }

    // Ensure the session row exists with the caller-supplied id BEFORE
    // anything that depends on it (user-message persist, broadcaster
    // events, agent.runStream's system-prompt write).
    if (!manager.sessionStore.get(effectiveSessionId)) {
      manager.sessionStore.create(agentId, { id: effectiveSessionId });
    }

    const lastUser = committed[committed.length - 1];
    // Union of interactive (`activeTurns`) AND autonomous (dispatcher)
    // turns. Without the dispatcher check, a POST landing during an
    // autonomous turn falls through to the standard path and spawns a
    // parallel `runChatTurn` — two assistant replies for one user
    // message, the first ignoring the new message (its history snapshot
    // predates the POST).
    const inFlight =
      activeTurns.has(effectiveSessionId) ||
      manager.dispatcher.isRunning(effectiveSessionId);

    // Mid-turn send semantics: if a turn is already running for this
    // session, DON'T abort. Queue the user message to the inbox WITHOUT
    // persisting to chat history yet — the autonomous turn that fires
    // after the current turn ends will drain the inbox and persist the
    // user message at the natural end of history (after the in-flight
    // turn's assistant lands). Without deferred persist, history ends
    // up [user1, user2, assistant1] which confuses the model on the
    // follow-up turn — the model sees its own assistant as the last
    // turn and won't naturally respond to the still-pending user2.
    //
    // UI: the page's optimistic update already shows the queued
    // message; the persisted version arrives via broadcaster after
    // drain with the same id so the optimistic row upserts in place.
    if (inFlight) {
      if (!lastUser || lastUser.role !== "user") {
        return c.json({ error: "no_user_message" }, 400);
      }
      try {
        manager.inboxStore.deliver({
          agentId,
          kind: "user_message",
          source: "user",
          sourceId: lastUser.id,
          relatedSession: effectiveSessionId,
          payload: lastUser,
        });
      } catch (e) {
        log.warn(
          { err: e, sessionId: effectiveSessionId },
          "inbox queue (mid-turn user message) failed"
        );
        return c.json({ error: "queue_failed" }, 500);
      }
      // Broadcast so other tabs viewing this session render the queue
      // chip too. The originating tab already added optimistically;
      // its receive-side dedup by id keeps the round-trip a no-op.
      manager.broadcaster.broadcast(effectiveSessionId, {
        kind: "inbox_queued",
        messageId: lastUser.id,
        parts: lastUser.parts as unknown[],
      });
      return c.json({
        sessionId: effectiveSessionId,
        userMessageId: lastUser.id,
        // assistantMessageId omitted — the queued message will get
        // its own assistant id assigned by the autonomous turn.
        queued: true,
      });
    }

    // Standard interactive path — no turn running. Persist + broadcast
    // the user message before the stream runs so (a) its DB timestamp
    // predates any `ping_user` event the agent fires during the turn
    // (otherwise `unresolvedPingsBySession` would immediately clear
    // those pings), and (b) other tabs see the user message land at
    // the same instant the assistant stream starts.
    if (lastUser?.role === "user") {
      try {
        manager.messageStore.append(effectiveSessionId, {
          id: lastUser.id,
          role: "user",
          parts: lastUser.parts as unknown[],
        });
        manager.broadcaster.broadcast(effectiveSessionId, {
          kind: "messages_appended",
          messages: [
            {
              id: lastUser.id,
              role: "user",
              parts: lastUser.parts as unknown[],
            },
          ],
        });
      } catch (e) {
        log.warn({ err: e }, "user message pre-persist skipped");
      }
    }

    const controller = new AbortController();
    activeTurns.set(effectiveSessionId, controller);
    const signal = controller.signal;

    // Used for both the streamed `start` chunk and the final
    // `messages_appended` so per-tab assemblers and the end-of-turn
    // upsert refer to the same row.
    const responseMessageId = randomUUID();

    void runChatTurn({
      manager,
      agentId,
      sessionId: effectiveSessionId,
      committed,
      responseMessageId,
      signal,
    }).finally(() => {
      if (activeTurns.get(effectiveSessionId) === controller) {
        activeTurns.delete(effectiveSessionId);
      }
    });

    return c.json({
      sessionId: effectiveSessionId,
      userMessageId: lastUser?.id ?? null,
      assistantMessageId: responseMessageId,
    });
  });

  // The server-owned agent run is decoupled from the HTTP request that
  // initiated it (SSE-only streaming), so this is the only way for the
  // UI to cancel without closing the tab. 404 = no turn was running.
  app.delete("/api/sessions/:id/active-turn", (c) => {
    const id = c.req.param("id");
    const ctrl = activeTurns.get(id);
    if (!ctrl) return c.json({ ok: false, reason: "no active turn" }, 404);
    ctrl.abort();
    activeTurns.delete(id);
    return c.json({ ok: true });
  });

  // Cancel a queued user message (sent while a turn was streaming, sits
  // in `agent_inbox` until the autonomous follow-up drains it). The UI's
  // ✕ on the queued-message chip calls this. Race: if the follow-up
  // turn already drained the row, `cancelled` is 0 — the message has
  // landed in chat history and is no longer cancelable.
  app.delete("/api/sessions/:sessionId/queued/:messageId", (c) => {
    const sessionId = c.req.param("sessionId");
    const messageId = c.req.param("messageId");
    const session = manager.sessionStore.get(sessionId);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const cancelled = manager.inboxStore.cancelQueuedUserMessage({
      agentId: session.agentId,
      messageId,
      sessionId,
    });
    // Broadcast on actual cancel so other tabs drop their chip. When
    // `cancelled === 0` the row was already drained (race) — no chip
    // exists in any tab anymore, and the broadcast would be confusing
    // because the message HAS landed in chat by now.
    if (cancelled > 0) {
      manager.broadcaster.broadcast(sessionId, {
        kind: "inbox_cancelled",
        messageId,
      });
    }
    return c.json({ ok: true, cancelled });
  });

  // ── Models ──
  // Returns each provider augmented with its curated model presets so the
  // UI can render a model dropdown without a second round-trip. Each preset
  // is also enriched with `inputModalities` from the bundled registry so
  // the client can disable the file picker on text-only models.
  app.get("/api/models", (c) => {
    // Availability bits drive the auth picker in Settings → Model and
    // the per-agent editor. Both flags are independent — a provider
    // with BOTH an env-var key and an OAuth token reports both as
    // true, even though the runtime tie-break in `shouldUseOAuth`
    // would pick api_key. The picker needs to know what the user
    // *could* pick, not which one would currently win.
    const creds = detectProviderCredentials(config.dataDir);
    return c.json(
      listProviders().map((p) => ({
        ...p,
        apiKeyConfigured: creds.apiKeyConfigured[p.id] === true,
        oauthConfigured: creds.oauthConfigured[p.id] === true,
        models: (MODEL_PRESETS[p.id] ?? []).map((m) => {
          const meta = lookupModelMetadata({
            provider: p.id,
            model: m.id,
            auth: "api_key",
            cacheTtl: "5m",
          });
          return {
            ...m,
            inputModalities: meta.inputModalities,
          };
        }),
      }))
    );
  });

  // ── Tools ──
  app.get("/api/tools", (c) => {
    return c.json({
      tools: toolRegistry.getInfo(),
      toolsets: toolRegistry.getToolsets(),
    });
  });

  // ── MCP ──

  // Status of every agent's MCP servers — connected, failed, disabled,
  // awaiting_oauth — used by the UI to render the status panel.
  app.get("/api/mcp/status", (c) => {
    return c.json({ agents: manager.getMcpStatus() });
  });

  app.get("/api/agents/:id/mcp/status", (c) => {
    const id = c.req.param("id");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    const servers = manager.getMcpClient(id)?.getStatus() ?? [];
    return c.json({ agentId: id, servers });
  });

  // Force a full reinit of one agent's MCP — disconnect + reconnect every
  // server. Use after a global mcp.json edit when the watcher missed it
  // (e.g., on a network filesystem) or to recover from a transient failure.
  app.post("/api/agents/:id/mcp/refresh", async (c) => {
    const id = c.req.param("id");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    await manager.queueMcpReinit(id);
    const servers = manager.getMcpClient(id)?.getStatus() ?? [];
    return c.json({ agentId: id, servers });
  });

  // Per-server connect/disconnect/reconnect for an agent.
  app.post("/api/agents/:id/mcp/servers/:name/connect", async (c) => {
    const client = manager.getMcpClient(c.req.param("id"));
    if (!client) return c.json({ error: "Agent has no MCP client" }, 404);
    return c.json(await client.connectServer(c.req.param("name")));
  });

  app.post("/api/agents/:id/mcp/servers/:name/disconnect", async (c) => {
    const client = manager.getMcpClient(c.req.param("id"));
    if (!client) return c.json({ error: "Agent has no MCP client" }, 404);
    await client.disconnectServer(c.req.param("name"));
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/mcp/servers/:name/reconnect", async (c) => {
    const client = manager.getMcpClient(c.req.param("id"));
    if (!client) return c.json({ error: "Agent has no MCP client" }, 404);
    return c.json(await client.reconnect(c.req.param("name")));
  });

  // Force a fresh OAuth flow — clears stored tokens for that server,
  // then reconnects. Use when a token's been revoked server-side or
  // when the user wants to switch accounts.
  app.post("/api/agents/:id/mcp/servers/:name/reauth", async (c) => {
    const client = manager.getMcpClient(c.req.param("id"));
    if (!client) return c.json({ error: "Agent has no MCP client" }, 404);
    const name = c.req.param("name");
    await manager.clearMcpOAuthTokens(name);
    return c.json(await client.reconnect(name));
  });

  // Dry-run a config without registering any tools — for the "Test
  // connection" UI button. Body is a single MCPServerConfig.
  app.post("/api/mcp/test", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = MCPServerConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: "Validation failed",
          details: parsed.error.issues.map(
            (err: { path: PropertyKey[]; message: string }) =>
              `${err.path.join(".")}: ${err.message}`
          ),
        },
        400
      );
    }
    // `testConnection` opens a transport, lists tools, closes — never
    // touches the registry or the manager's per-agent maps. Use a
    // throwaway client so we don't disturb any live agent state.
    const probe = new MCPClient(toolRegistry);
    const result = await probe.testConnection(parsed.data);
    return c.json(result);
  });

  // ── Global MCP catalog (~/.openacme/mcp.json) ──

  app.get("/api/mcp/global", (c) => {
    return c.json({ mcpServers: loadGlobalMcpServers(config.dataDir) });
  });

  // PUT replaces the whole catalog. Triggers reinit for every agent so
  // the new/changed/removed servers take effect without a process restart.
  app.put("/api/mcp/global", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const body = (raw && typeof raw === "object" ? raw : {}) as {
      mcpServers?: unknown;
    };
    if (
      body.mcpServers !== undefined &&
      (typeof body.mcpServers !== "object" || body.mcpServers === null)
    ) {
      return c.json({ error: "mcpServers must be an object" }, 400);
    }
    const entries = Object.entries(
      (body.mcpServers ?? {}) as Record<string, unknown>
    );
    const validated: Record<string, MCPServerConfig> = {};
    for (const [name, cfg] of entries) {
      const result = MCPServerConfigSchema.safeParse(cfg);
      if (!result.success) {
        return c.json(
          {
            error: `Invalid config for server '${name}'`,
            details: result.error.issues.map(
              (err: { path: PropertyKey[]; message: string }) =>
                `${err.path.join(".")}: ${err.message}`
            ),
          },
          400
        );
      }
      validated[name] = result.data;
    }
    saveGlobalMcpServers(config.dataDir, validated);
    // Reinit in the background — N agents × connect retries can take
    // minutes, and the catalog write is already durable. The UI polls
    // /api/mcp/status to watch connections come up.
    void Promise.all(
      manager.listAgents().map((def) => manager.queueMcpReinit(def.id))
    );
    return c.json({ mcpServers: validated });
  });

  // Per-agent private servers. The agent-store rejects writes whose names
  // collide with the global catalog.
  app.post("/api/agents/:id/mcp/servers", async (c) => {
    const id = c.req.param("id");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const body = (raw && typeof raw === "object" ? raw : {}) as {
      name?: unknown;
      config?: unknown;
    };
    if (typeof body.name !== "string" || body.name.length === 0) {
      return c.json({ error: "'name' must be a non-empty string" }, 400);
    }
    const cfgResult = MCPServerConfigSchema.safeParse(body.config);
    if (!cfgResult.success) {
      return c.json(
        {
          error: "Invalid server config",
          details: cfgResult.error.issues.map(
            (err: { path: PropertyKey[]; message: string }) =>
              `${err.path.join(".")}: ${err.message}`
          ),
        },
        400
      );
    }
    const next: Record<string, MCPServerConfig> = {
      ...(def.mcpServers ?? {}),
      [body.name]: cfgResult.data,
    };
    try {
      await manager.updateAgent(id, { mcpServers: next });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return c.json({ id, mcpServers: next });
  });

  app.delete("/api/agents/:id/mcp/servers/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    if (!Object.prototype.hasOwnProperty.call(def.mcpServers ?? {}, name)) {
      return c.json({ error: "Server not found in agent" }, 404);
    }
    const next: Record<string, MCPServerConfig> = { ...def.mcpServers };
    delete next[name];
    try {
      await manager.updateAgent(id, { mcpServers: next });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return c.json({ id, mcpServers: next });
  });

  // ── Skills ──
  app.get("/api/skills", (c) => {
    return c.json(manager.skillRegistry.getIndex());
  });

  app.get("/api/skills/:name", (c) => {
    const skill = manager.skillRegistry.getSkill(c.req.param("name"));
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    return c.json(skill);
  });

  app.post("/api/skills", async (c) => {
    let body: { name: string; description: string; tags: string[]; body: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const { name, description, tags, body: skillBody } = body;
    if (!name || !description) {
      return c.json({ error: "name and description are required" }, 400);
    }

    try {
      const skillsDir = path.resolve(config.dataDir, config.skills.directory);
      const skill = manager.skillRegistry.saveSkill(
        skillsDir,
        name,
        description,
        tags || [],
        skillBody || ""
      );
      return c.json(skill, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // Edit an existing skill's frontmatter + body. The name is fixed —
  // it's the folder identity; renames are delete + recreate.
  app.put("/api/skills/:name", async (c) => {
    const name = c.req.param("name");
    const existing = manager.skillRegistry.getSkill(name);
    if (!existing) return c.json({ error: "Skill not found" }, 404);

    let body: { description?: string; tags?: string[]; body?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const description = body.description ?? existing.description;
    if (!description) {
      return c.json({ error: "description is required" }, 400);
    }

    try {
      const skillsDir = path.resolve(config.dataDir, config.skills.directory);
      const skill = manager.skillRegistry.saveSkill(
        skillsDir,
        name,
        description,
        body.tags ?? existing.tags,
        body.body ?? existing.body
      );
      return c.json(skill);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  app.delete("/api/skills/:name", (c) => {
    const name = c.req.param("name");
    const skillsDir = path.resolve(config.dataDir, config.skills.directory);
    const deleted = manager.skillRegistry.deleteSkill(skillsDir, name);
    if (!deleted) {
      return c.json({ error: "Skill not found" }, 404);
    }
    // If this skill was hub-managed, drop the lockfile entry too so we
    // don't leave a zombie behind (lock claims installed, disk doesn't).
    // uninstall() is a no-op if not in the lockfile.
    try {
      new SkillHub(skillsDir, manager.skillRegistry).uninstall(name);
    } catch {
      // best-effort cleanup; legacy delete already succeeded
    }
    return c.json({ success: true });
  });

  // Import a skill folder. Client sends multipart/form-data where each field
  // name is the file's path relative to the skill root. Top-level
  // `SKILL.md` required. Caps and validation happen inside the hub.
  app.post("/api/skills/import", async (c) => {
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: "Expected multipart/form-data" }, 400);
    }

    const entries: { relPath: string; file: File }[] = [];
    for (const [rawKey, raw] of Object.entries(form)) {
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (value instanceof File) entries.push({ relPath: rawKey, file: value });
      }
    }
    if (entries.length === 0) {
      return c.json({ error: "No files in upload" }, 400);
    }

    // Strip a single shared top-level folder if every entry has one — lets
    // users drop either `my-skill/SKILL.md` or `SKILL.md` and get the same
    // result. Detailed path validation runs inside the hub.
    let topPrefix: string | null = null;
    for (const e of entries) {
      const parts = e.relPath.replace(/\\/g, "/").split("/");
      const head = parts[0] ?? "";
      if (parts.length > 1 && head) {
        if (topPrefix === null) topPrefix = head;
        else if (topPrefix !== head) topPrefix = "";
      } else {
        topPrefix = "";
      }
    }
    const stripPrefix = topPrefix ? topPrefix + "/" : "";

    const skillsDir = path.resolve(config.dataDir, config.skills.directory);
    const staging = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openacme-import-")
    );

    try {
      for (const e of entries) {
        const rel = e.relPath.replace(/\\/g, "/");
        const trimmed = stripPrefix && rel.startsWith(stripPrefix)
          ? rel.slice(stripPrefix.length)
          : rel;
        if (!trimmed) continue;
        const target = path.join(staging, trimmed);
        const targetReal = path.resolve(target);
        if (!targetReal.startsWith(path.resolve(staging) + path.sep)) {
          return c.json({ error: `Invalid path: ${e.relPath}` }, 400);
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const buf = Buffer.from(await e.file.arrayBuffer());
        await fs.promises.writeFile(target, buf);
      }

      const hub = new SkillHub(skillsDir, manager.skillRegistry);
      try {
        const result = await hub.install(staging, { source: "local" });
        const skill = manager.skillRegistry.getSkill(result.name);
        return c.json({ success: true, name: result.name, skill }, 201);
      } catch (err) {
        if (err instanceof HubError) {
          const code = err.code === "ALREADY_INSTALLED" || err.code === "LOCAL_SKILL_EXISTS"
            ? 409
            : 400;
          return c.json({ error: err.message }, code);
        }
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          500
        );
      }
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  });

  // ── Skills Hub (multi-source import) ──
  registerSkillsHubRoutes(app, manager, config);

  // ── AGENTS.md ──
  app.get("/api/agents-md", (c) => {
    return c.json({ content: manager.getAgentsMd() ?? null });
  });

  app.put("/api/agents-md", async (c) => {
    let body: { content?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body.content !== "string") {
      return c.json({ error: "Body must be { content: string }" }, 400);
    }
    try {
      manager.setAgentsMd(body.content);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500
      );
    }
    return c.json({ content: manager.getAgentsMd() ?? null });
  });

  // ── Config ──
  // Returns the workforce-wide root config (no API keys). The `model` block
  // is the default inherited by every agent without its own `model:`
  // override; reads fresh from disk via `readRawConfig` so the UI shows what
  // will apply on next restart, not the in-memory snapshot the running
  // daemon booted with.
  app.get("/api/config", (c) => {
    const raw = readRawConfig(config.dataDir);
    const rawModel = (raw.model as Partial<ModelConfig> | undefined) ?? {};
    const body: ConfigResponse = {
      dataDir: config.dataDir,
      model: {
        provider: rawModel.provider ?? config.model.provider,
        model: rawModel.model ?? config.model.model,
        baseUrl: rawModel.baseUrl,
        headers: rawModel.headers,
        auth: rawModel.auth ?? "api_key",
        cacheTtl: rawModel.cacheTtl ?? "5m",
      },
      server: config.server,
      behavior: config.behavior,
      skills: config.skills,
    };
    return c.json(body);
  });

  // Partial update of the root `model:` block. Mirrors /api/browser/config:
  // readRawConfig + spread-merge + writeRawConfig. The setup-wizard feedback
  // memory enforces this pattern — parsing into ConfigSchema and re-saving
  // would re-materialize every Zod default and clobber unset user fields.
  // Never accepts `apiKey` — keys live in .env via /api/keys.
  app.put("/api/config/model", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = ModelDefaultsUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid model config", issues: parsed.error.issues },
        400
      );
    }
    const raw = readRawConfig(config.dataDir);
    const existing = (raw.model as Record<string, unknown> | undefined) ?? {};
    const next: Record<string, unknown> = { ...existing };
    // Only persist keys the caller actually sent. `parsed.data` carries Zod
    // defaults (auth, cacheTtl) for absent fields — writing those would clobber
    // the user's on-disk values on a partial update (the setup-must-merge rule).
    const sentKeys = new Set(Object.keys(body as Record<string, unknown>));
    for (const [k, v] of Object.entries(parsed.data)) {
      if (!sentKeys.has(k) || v === undefined) continue;
      next[k] = v;
    }
    writeRawConfig(config.dataDir, { ...raw, model: next });
    // Live-apply: reloadConfig evicts cached Agents so the next turn reads the
    // new default off `this.config`. Model changes never need a restart.
    const { restartRequired } = manager.reloadConfig();
    const ok: ConfigModelUpdateResponse = {
      ok: true,
      requiresRestart: restartRequired.length > 0,
    };
    return c.json(ok);
  });

  // ── API Keys ──
  const envPath = path.join(config.dataDir, ".env");

  app.get("/api/keys", (c) => c.json(detectProviderCredentials(config.dataDir)));

  // Save an API key to the .env file
  app.post("/api/keys", async (c) => {
    let body: { provider: string; apiKey: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const { provider, apiKey } = body;
    if (!provider || !apiKey) {
      return c.json({ error: "provider and apiKey are required" }, 400);
    }

    // Find the provider's env var name
    const providers = listProviders();
    const providerInfo = providers.find((p) => p.id === provider);
    if (!providerInfo?.envVar) {
      return c.json({ error: "Unknown provider or no env var defined" }, 400);
    }

    // Ensure data directory exists
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }

    // Read existing .env using dotenv.parse
    let envVars: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf-8");
      envVars = dotenv.parse(envContent);
    }

    // Update the key
    const envVar = providerInfo.envVar;
    envVars[envVar] = apiKey.trim();

    // Write back as key=value lines
    const newContent = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n";

    fs.writeFileSync(envPath, newContent);

    // Also set in current process so it takes effect immediately
    process.env[envVar] = apiKey.trim();

    // First-time provider setup: also seed the top-level `model` in
    // config.yaml with a sensible default for this provider, so the
    // platform default isn't `openrouter` (the schema fallback) when the
    // user just signed in with someone else. `reloadConfig` evicts
    // cached Agents so the inheriting platform agent (Acme) reflects
    // the new model on the next chat — no restart needed.
    setDefaultModelIfUnset(config.dataDir, {
      provider: provider as Provider,
      auth: "api_key",
    });
    manager.reloadConfig();

    return c.json({ success: true, envVar });
  });

  // ── Web search (Tavily / Exa / Brave) ──
  // Same .env-file mechanism as /api/keys; separate routes because these
  // aren't LLM providers and shouldn't pollute listProviders(). The
  // `web_search` tool reads these env vars at call time via
  // resolveSearchProvider() in @openacme/tools.
  const WEB_SEARCH_PROVIDERS: Record<string, string> = {
    tavily: "TAVILY_API_KEY",
    exa: "EXA_API_KEY",
    brave: "BRAVE_API_KEY",
  };
  const WEB_SEARCH_OVERRIDE_VAR = "OPENACME_SEARCH_PROVIDER";

  function readDotenv(): Record<string, string> {
    if (!fs.existsSync(envPath)) return {};
    return dotenv.parse(fs.readFileSync(envPath, "utf-8"));
  }
  function writeDotenv(vars: Record<string, string>) {
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }
    const content =
      Object.entries(vars)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n";
    fs.writeFileSync(envPath, content);
  }

  app.get("/api/web", (c) => {
    const envVars = readDotenv();
    const configured: Record<string, boolean> = {};
    for (const [pid, varName] of Object.entries(WEB_SEARCH_PROVIDERS)) {
      configured[pid] = !!process.env[varName] || !!envVars[varName];
    }
    const overrideRaw =
      process.env[WEB_SEARCH_OVERRIDE_VAR] ||
      envVars[WEB_SEARCH_OVERRIDE_VAR] ||
      null;
    const override =
      overrideRaw && overrideRaw in WEB_SEARCH_PROVIDERS ? overrideRaw : null;
    // Mirror resolveSearchProvider's resolution order so the UI shows what
    // would actually be used right now.
    let active: string;
    if (override) active = override;
    else if (configured.tavily) active = "tavily";
    else if (configured.brave) active = "brave";
    else active = "exa";
    return c.json({
      providers: Object.keys(WEB_SEARCH_PROVIDERS),
      configured,
      override,
      active,
    });
  });

  app.post("/api/web/keys", async (c) => {
    let body: { provider?: string; apiKey?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const { provider, apiKey } = body;
    if (!provider || !(provider in WEB_SEARCH_PROVIDERS)) {
      return c.json(
        { error: "Unknown web search provider (use tavily, exa, or brave)" },
        400
      );
    }
    if (!apiKey || !apiKey.trim()) {
      return c.json({ error: "apiKey is required" }, 400);
    }
    const envVar = WEB_SEARCH_PROVIDERS[provider]!;
    const envVars = readDotenv();
    envVars[envVar] = apiKey.trim();
    writeDotenv(envVars);
    process.env[envVar] = apiKey.trim();
    return c.json({ success: true, envVar });
  });

  app.delete("/api/web/keys/:provider", (c) => {
    const provider = c.req.param("provider");
    if (!(provider in WEB_SEARCH_PROVIDERS)) {
      return c.json({ error: "Unknown web search provider" }, 400);
    }
    const envVar = WEB_SEARCH_PROVIDERS[provider]!;
    const envVars = readDotenv();
    delete envVars[envVar];
    writeDotenv(envVars);
    delete process.env[envVar];
    return c.json({ success: true });
  });

  app.post("/api/web/provider", async (c) => {
    let body: { provider?: string | null };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const { provider } = body;
    const envVars = readDotenv();
    if (provider === null || provider === undefined || provider === "") {
      delete envVars[WEB_SEARCH_OVERRIDE_VAR];
      delete process.env[WEB_SEARCH_OVERRIDE_VAR];
    } else {
      if (!(provider in WEB_SEARCH_PROVIDERS)) {
        return c.json({ error: "Unknown web search provider" }, 400);
      }
      envVars[WEB_SEARCH_OVERRIDE_VAR] = provider;
      process.env[WEB_SEARCH_OVERRIDE_VAR] = provider;
    }
    writeDotenv(envVars);
    return c.json({ success: true });
  });

  // ── Browser ──
  // Cloud-provider creds live in <dataDir>/.env so they pick up without a
  // restart. Provider selection (`browser.provider`) plus local-only knobs
  // (executablePath, headless, noSandbox) live in config.yaml; agents
  // instantiate one provider at AgentManager construction, so changing
  // those requires a daemon restart.
  const BROWSER_PROVIDERS = ["local", "browserbase", "browser-use", "firecrawl"] as const;
  type BrowserProviderId = (typeof BROWSER_PROVIDERS)[number];
  const BROWSER_CRED_VARS: Record<Exclude<BrowserProviderId, "local">, readonly string[]> = {
    browserbase: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
    "browser-use": ["BROWSER_USE_API_KEY"],
    firecrawl: ["FIRECRAWL_API_KEY"],
  };

  function isBrowserProviderId(v: unknown): v is BrowserProviderId {
    return typeof v === "string" && (BROWSER_PROVIDERS as readonly string[]).includes(v);
  }

  const LOCAL_BROWSERS = ["chromium", "camoufox"] as const;
  type LocalBrowserId = (typeof LOCAL_BROWSERS)[number];
  const isLocalBrowserId = (v: unknown): v is LocalBrowserId =>
    typeof v === "string" && (LOCAL_BROWSERS as readonly string[]).includes(v);

  app.get("/api/browser", (c) => {
    const envVars = readDotenv();
    const configured: Record<string, boolean> = {};
    for (const [pid, vars] of Object.entries(BROWSER_CRED_VARS)) {
      configured[pid] = vars.every((v) => !!process.env[v] || !!envVars[v]);
    }
    // Read fresh from disk — in-memory `config` is the snapshot the running
    // AgentManager booted with; the UI needs to show what will apply on the
    // next restart (which is what was just saved).
    const raw = readRawConfig(config.dataDir);
    const rawBrowser = (raw.browser as Record<string, unknown> | undefined) ?? {};
    const active = isBrowserProviderId(rawBrowser.provider) ? rawBrowser.provider : config.browser.provider;
    const localBrowser = isLocalBrowserId(rawBrowser.localBrowser) ? rawBrowser.localBrowser : config.browser.localBrowser;
    const exePath = typeof rawBrowser.executablePath === "string" ? rawBrowser.executablePath : (config.browser.executablePath ?? "");
    const headless = typeof rawBrowser.headless === "boolean" ? rawBrowser.headless : config.browser.headless;
    const noSandbox = typeof rawBrowser.noSandbox === "boolean" ? rawBrowser.noSandbox : config.browser.noSandbox;
    // Per-local-browser readiness — currently only Camoufox needs an
    // out-of-band binary fetch; Chromium auto-installs via Playwright on
    // first acquire and reports through normal channels. Anything not
    // explicitly tracked is treated as ready by default.
    const localBrowserReady: Record<string, boolean> = {};
    const localBrowserFetching: Record<string, boolean> = {};
    for (const lb of LOCAL_BROWSERS) {
      switch (lb) {
        case "camoufox":
          localBrowserReady[lb] = isCamoufoxInstalled();
          localBrowserFetching[lb] = isCamoufoxPrefetching();
          break;
        case "chromium":
          localBrowserReady[lb] = true;
          localBrowserFetching[lb] = false;
          break;
      }
    }
    return c.json({
      providers: BROWSER_PROVIDERS,
      localBrowsers: LOCAL_BROWSERS,
      active,
      localBrowser,
      executablePath: exePath,
      headless,
      noSandbox,
      configured,
      localBrowserReady,
      localBrowserFetching,
    });
  });

  app.post("/api/browser/config", async (c) => {
    let body: {
      provider?: string;
      localBrowser?: string;
      executablePath?: string;
      headless?: boolean;
      noSandbox?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (body.provider !== undefined && !isBrowserProviderId(body.provider)) {
      return c.json({ error: `Unknown browser provider: ${body.provider}` }, 400);
    }
    if (body.localBrowser !== undefined && !isLocalBrowserId(body.localBrowser)) {
      return c.json({ error: `Unknown local browser: ${body.localBrowser}` }, 400);
    }
    const raw = readRawConfig(config.dataDir);
    const existing = (raw.browser as Record<string, unknown> | undefined) ?? {};
    const next: Record<string, unknown> = { ...existing };
    if (body.provider !== undefined) next.provider = body.provider;
    if (body.localBrowser !== undefined) next.localBrowser = body.localBrowser;
    if (body.executablePath !== undefined) {
      const trimmed = body.executablePath.trim();
      if (trimmed) {
        // Validate at save time — silent acceptance + late failure at first
        // browser call is a worse UX than a clear 400.
        if (!fs.existsSync(trimmed)) {
          return c.json(
            { error: `Path does not exist on disk: ${trimmed}` },
            400
          );
        }
        try {
          const stat = fs.statSync(trimmed);
          if (stat.isDirectory()) {
            return c.json(
              { error: `Path is a directory, not a binary: ${trimmed}` },
              400
            );
          }
          // X-bit check on POSIX; permission-mode check is moot on Windows.
          if (process.platform !== "win32" && !(stat.mode & 0o111)) {
            return c.json(
              { error: `Path is not executable (chmod +x first): ${trimmed}` },
              400
            );
          }
        } catch (e) {
          return c.json(
            { error: `Could not stat ${trimmed}: ${(e as Error).message}` },
            400
          );
        }
        next.executablePath = trimmed;
      } else {
        delete next.executablePath;
      }
    }
    if (body.headless !== undefined) next.headless = !!body.headless;
    if (body.noSandbox !== undefined) next.noSandbox = !!body.noSandbox;
    writeRawConfig(config.dataDir, { ...raw, browser: next });
    // Fire-and-forget binary prefetch on the heavy choice so the user's
    // first browser_navigate isn't a silent ~60s download.
    if (body.localBrowser === "camoufox" && !isCamoufoxInstalled()) {
      void prefetchCamoufox();
    }
    // Live-apply: reloadConfig hot-swaps the browser provider, so the change
    // takes effect on the next browser session with no restart.
    manager.reloadConfig();
    return c.json({ success: true });
  });

  app.post("/api/browser/keys", async (c) => {
    let body: { provider?: string; apiKey?: string; projectId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const { provider, apiKey, projectId } = body;
    if (!provider || provider === "local" || !(provider in BROWSER_CRED_VARS)) {
      return c.json({ error: "Unknown cloud browser provider" }, 400);
    }
    if (!apiKey || !apiKey.trim()) {
      return c.json({ error: "apiKey is required" }, 400);
    }
    const envVars = readDotenv();
    const vars = BROWSER_CRED_VARS[provider as Exclude<BrowserProviderId, "local">];
    const apiKeyVar = vars[0]!;
    envVars[apiKeyVar] = apiKey.trim();
    process.env[apiKeyVar] = apiKey.trim();
    if (provider === "browserbase") {
      if (!projectId || !projectId.trim()) {
        return c.json({ error: "projectId is required for browserbase" }, 400);
      }
      envVars["BROWSERBASE_PROJECT_ID"] = projectId.trim();
      process.env["BROWSERBASE_PROJECT_ID"] = projectId.trim();
    }
    writeDotenv(envVars);
    return c.json({ success: true });
  });

  app.delete("/api/browser/keys/:provider", (c) => {
    const provider = c.req.param("provider");
    if (!provider || provider === "local" || !(provider in BROWSER_CRED_VARS)) {
      return c.json({ error: "Unknown cloud browser provider" }, 400);
    }
    const envVars = readDotenv();
    for (const v of BROWSER_CRED_VARS[provider as Exclude<BrowserProviderId, "local">]) {
      delete envVars[v];
      delete process.env[v];
    }
    writeDotenv(envVars);
    return c.json({ success: true });
  });

  // ── Static Web UI ──
  // Skipped when the embedded Vite dev server fronts the UI. Otherwise
  // prefer the bundled path (published install, filled by prepack) and fall
  // back to the workspace build (e.g. test daemons after `pnpm build`).
  const inWebDev = !!process.env["OPENACME_WEB_DEV"];
  const bundledWebDir = path.resolve(__dirname, "../web");
  const workspaceWebDir = path.resolve(__dirname, "../../../apps/web/out");
  const webDir = !inWebDev && fs.existsSync(path.join(bundledWebDir, "index.html"))
    ? bundledWebDir
    : !inWebDev && fs.existsSync(path.join(workspaceWebDir, "index.html"))
      ? workspaceWebDir
      : null;
  if (webDir) {
    const { serveStatic } = await import("@hono/node-server/serve-static");

    // Serve static assets (/assets, favicon, PWA files, etc.)
    app.use("/*", serveStatic({ root: webDir }));

    // SPA fallback: a single index.html; the client router resolves the
    // route. Read per-request so rebuilding apps/web refreshes a running
    // daemon without restart.
    app.get("*", (c) =>
      c.html(fs.readFileSync(path.join(webDir, "index.html"), "utf-8"))
    );
  }

  return { app, manager };
}

/**
 * Run one interactive chat turn in the background. SSE is the only
 * delivery channel; `createUIMessageStream` is used purely for its
 * onFinish assembly — the wrapper's stream output is drained and
 * discarded since the POST already returned.
 */
const UPSTREAM_ERROR_MAX_CHARS = 4096;

function buildUpstreamErrorPart(
  err: unknown,
  agentId: string,
  manager: AgentManager
) {
  const statusCode = extractStatusCode(err);
  const raw = extractErrorText(err);
  const message =
    raw.length > UPSTREAM_ERROR_MAX_CHARS
      ? raw.slice(0, UPSTREAM_ERROR_MAX_CHARS)
      : raw;
  let provider: string | undefined;
  try {
    provider = manager.getAgent(agentId).config.model.provider;
  } catch {
    /* agent gone — render without provider chip */
  }
  return {
    type: "data-upstream-error" as const,
    data: { provider, statusCode, message },
  };
}

async function runChatTurn(args: {
  manager: AgentManager;
  agentId: string;
  sessionId: string;
  committed: UIMessage[];
  responseMessageId: string;
  signal: AbortSignal;
}): Promise<void> {
  const { manager, agentId, sessionId, responseMessageId, signal } = args;
  // `history` is mutable because preflight compression may compact the
  // session in place; we re-read from the message store after to pick
  // up the new [head + summary + tail] shape.
  let history = args.committed;

  manager.dispatcher.markInteractiveBusy(sessionId);
  manager.broadcaster.broadcast(sessionId, {
    kind: "session_state",
    state: "running",
  });

  // Sandbox degradation is loud: every turn carries a transient warning
  // chip so unconfined tool execution is never silent.
  if (manager.toolHostManager.degradeReason) {
    const sandboxStatusId = `sandbox-${responseMessageId}`;
    manager.broadcaster.broadcast(sessionId, {
      kind: "ui_message_part",
      part: {
        type: "data-status",
        id: sandboxStatusId,
        data: {
          id: sandboxStatusId,
          kind: "warn",
          message: `Sandbox unavailable — tools are running unconfined: ${manager.toolHostManager.degradeReason}`,
        },
        transient: true,
      },
    });
  }

  // Preflight: compact the session in place if the next request would
  // exceed the configured threshold. The session id is preserved
  // (rename-swap), so all external references stay valid; we only
  // need to re-read history after.
  const compressionStatusId = `compress-${responseMessageId}`;
  try {
    const agent = manager.getAgent(agentId);
    // Surface a chip while compaction runs — summarizing 100K+ tokens
    // can take 20-60s and looks like a freeze otherwise. Cleared
    // unconditionally in the `finally` so the chip doesn't linger.
    manager.broadcaster.broadcast(sessionId, {
      kind: "ui_message_part",
      part: {
        type: "data-status",
        id: compressionStatusId,
        data: {
          id: compressionStatusId,
          kind: "compressing",
          message: "Compacting older context…",
        },
        transient: true,
      },
    });
    await agent.preflightCompress(sessionId, history);
    history = sanitizeStoredHistory(
      manager.messageStore.getHistory(sessionId)
    ) as unknown as UIMessage[];
  } catch (e) {
    log.warn(
      { err: e, sessionId },
      "chat preflight compression failed; continuing on uncompacted history"
    );
  } finally {
    // Clear the in-progress chip. Same id + empty `message` removes
    // the entry from the client's statusBoard.
    manager.broadcaster.broadcast(sessionId, {
      kind: "ui_message_part",
      part: {
        type: "data-status",
        id: compressionStatusId,
        data: {
          id: compressionStatusId,
          kind: "info",
          message: "",
        },
        transient: true,
      },
    });
  }

  // `createUIMessageStream` doesn't reject the consumer when execute()
  // or the underlying stream errors — it routes through `onError` and
  // still calls `onFinish` with whatever parts assembled so far (often
  // empty). Capture the error here so `onFinish` can persist a stub
  // message with a `data-upstream-error` part instead of a 0-parts
  // assistant row. The outer drain catch below stays as a safety net
  // for synchronous throws that bypass this hook.
  // `streamText.onError` (set on `agent.runStream` below) gets the
  // raw APICallError with `.statusCode` + `.responseBody`. By the time
  // an error reaches the UI-message-stream wrapper's onError, the SDK
  // has stripped those down to a plain `Error.message`. So we capture
  // here, and use that captured error in `onFinish`. The wrapper's own
  // onError is just a fallback path for errors that never went through
  // streamText (e.g. recall, prompt-building).
  let capturedError: unknown = null;
  const wrapper = createUIMessageStream<OpenAcmeUIMessage>({
    onError: (err) => {
      if (!capturedError) capturedError = err;
      return extractErrorText(err);
    },
    execute: async ({ writer }) => {
      const agent = manager.getAgent(agentId);

      const recall = await agent.applyMemoryRecall({
        sessionId,
        history,
        signal,
      });
      // Attach to the new user msg before runStream: the model sees it
      // via uiToModelMessages this turn; persisted in onFinish so future
      // loads replay identical bytes (prefix cache).
      const recallPart = agent.buildRelevantMemoryPart(
        recall.entries,
        recall.modelContent
      );
      if (recallPart) {
        const lastUser = history[history.length - 1];
        if (lastUser?.role === "user") {
          lastUser.parts = [
            ...(lastUser.parts as UIMessage["parts"]),
            recallPart as unknown as UIMessage["parts"][number],
          ];
        }
      }

      const result = await agent.runStream({
        sessionId,
        history,
        signal,
        usage: { kind: "interactive", messageId: responseMessageId },
        onError: ({ error }) => {
          capturedError = error;
        },
      });
      // Synthetic start so SSE assemblers and `onFinish`'s
      // `responseMessage.id` agree on the same row.
      manager.broadcaster.broadcast(sessionId, {
        kind: "ui_message_part",
        part: { type: "start", messageId: responseMessageId },
        messageId: responseMessageId,
      });
      const uiStream = result.toUIMessageStream({
        sendStart: false,
        sendFinish: false,
      });
      // Tee the stream: branch A forwards chunks (writer + per-chunk
      // broadcast), branch B feeds an assembler that emits throttled
      // `messages_appended` snapshots for late-joining subscribers. A
      // refresh mid-stream opens a fresh SSE with no ring-buffer replay,
      // so the AI SDK assembler on the client can't process raw
      // text-delta chunks without their original text-start. The
      // snapshot path is the safety net — late-joiners render via the
      // upsert-by-id path on `messages_appended`. Tabs connected from
      // the start still get per-chunk streaming via branch A; the
      // snapshot broadcasts are redundant for them (upserting the same
      // assembled message they're already building) but harmless.
      const [streamA, streamB] = (
        uiStream as ReadableStream<unknown>
      ).tee();
      const SNAPSHOT_INTERVAL_MS = 500;
      let lastSnapshotAt = 0;
      const assembler = (async () => {
        try {
          for await (const m of readUIMessageStream<OpenAcmeUIMessage>({
            stream: streamB as ReadableStream<never>,
            message: {
              id: responseMessageId,
              role: "assistant",
              parts: [],
            } as OpenAcmeUIMessage,
          })) {
            if (!m.id) continue;
            const now = Date.now();
            if (now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) continue;
            lastSnapshotAt = now;
            try {
              manager.broadcaster.broadcast(sessionId, {
                kind: "messages_appended",
                messages: [
                  {
                    id: m.id,
                    role: "assistant",
                    parts: m.parts as unknown[],
                    metadata: m.metadata,
                  },
                ],
              });
            } catch (e) {
              log.warn({ err: e }, "runChatTurn snapshot broadcast failed");
            }
          }
        } catch (e) {
          log.warn({ err: e }, "runChatTurn assembler branch failed");
        }
      })();

      const reader = streamA.getReader();
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          try {
            writer.write(r.value as Parameters<typeof writer.write>[0]);
          } catch {
            /* wrapper closed (abort race) */
          }
          try {
            manager.broadcaster.broadcast(sessionId, {
              kind: "ui_message_part",
              part: r.value,
              messageId: responseMessageId,
            });
          } catch (e) {
            log.warn({ err: e }, "runChatTurn broadcaster forward failed");
          }
        }
      } finally {
        reader.releaseLock();
      }
      await assembler;
      manager.broadcaster.broadcast(sessionId, {
        kind: "ui_message_part",
        part: { type: "finish" },
        messageId: responseMessageId,
      });
    },
    originalMessages: history as unknown as OpenAcmeUIMessage[],
    generateId: () => responseMessageId,
    onFinish: ({ responseMessage }) => {
      manager.dispatcher.clearInteractiveBusy(sessionId);
      try {
        // Error branch: stream failed mid-turn (provider 4xx/5xx, network
        // drop, etc.). Append an upstream-error part so the user sees what
        // failed; preserve whatever assembled before the failure.
        const parts = !capturedError || signal.aborted
          ? ensureStepBoundaries(
              finalizeOrphanToolParts(
                responseMessage.parts as UIMessage["parts"]
              )
            )
          : [
              ...ensureStepBoundaries(
                finalizeOrphanToolParts(
                  responseMessage.parts as UIMessage["parts"]
                )
              ),
              buildUpstreamErrorPart(capturedError, agentId, manager),
            ];
        manager.messageStore.append(sessionId, {
          id: responseMessage.id,
          role: responseMessage.role as "user" | "assistant",
          parts: parts as unknown[],
        });
        // Final canonical broadcast — chunks already produced the live
        // assembly; this settles late subscribers + applies sanitization
        // (orphan tool parts, step boundaries) that the chunk path didn't.
        manager.broadcaster.broadcast(sessionId, {
          kind: "messages_appended",
          messages: [
            {
              id: responseMessage.id,
              role: responseMessage.role as "user" | "assistant",
              parts: parts as unknown[],
            },
          ],
        });
        manager.sessionStore.touch(sessionId);
      } catch (e) {
        log.error({ err: e }, "failed to persist chat turn");
      }
      // Idle goes AFTER persist + messages_appended so the client's
      // running→idle refetch can't race the DB write.
      manager.broadcaster.broadcast(sessionId, {
        kind: "session_state",
        state: "idle",
      });

      const turnHistory = [
        ...history,
        responseMessage as unknown as UIMessage,
      ];
      try {
        manager.getAgent(agentId).fireExtractor({
          sessionId,
          sessionMessages: turnHistory,
        });
      } catch (e) {
        log.warn({ err: e, agentId }, "memory.extractor launch failed");
      }
      try {
        manager.getAgent(agentId).fireTitle({
          sessionId,
          sessionMessages: turnHistory,
        });
      } catch (e) {
        log.warn({ err: e, agentId }, "title generation launch failed");
      }
    },
  });

  // Drain the wrapper to drive its onFinish assembly; nothing reads
  // the output (SSE is the delivery channel).
  const drainReader = (wrapper as ReadableStream<unknown>).getReader();
  try {
    for (;;) {
      const r = await drainReader.read();
      if (r.done) break;
    }
  } catch (e) {
    // Safety net for synchronous throws that bypass onError (rare —
    // most provider errors route through onError → onFinish, which
    // persists the upstream-error part). Just unstick observers.
    manager.dispatcher.clearInteractiveBusy(sessionId);
    log.warn({ err: e, sessionId }, "runChatTurn drain errored");
    manager.broadcaster.broadcast(sessionId, {
      kind: "session_state",
      state: "idle",
    });
  } finally {
    try {
      drainReader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
