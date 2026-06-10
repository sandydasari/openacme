import { Agent, type AgentConfig } from "@openacme/agent-core";
import {
  compilePolicy,
  createAgentStore,
  createTeamStore,
  describePolicy,
  loadConfig,
  loadGlobalMcpServers,
  saveGlobalMcpServers,
  lookupModelMetadata,
  type AgentDefinition,
  type AgentStore,
  type Config,
  type MCPServerConfig,
  type ModelConfig,
  type TeamDefinition,
  type TeamStore,
} from "@openacme/config";
import { createLogger } from "@openacme/config/logger";

const log = createLogger("server.agent-manager");
import {
  createDatabase,
  createSessionStore,
  createMessageStore,
  createCommentStore,
  createEventStore,
  createInboxStore,
  createPushStore,
  type SessionStore,
  type MessageStore,
  type CommentStore,
  type EventStore,
  type InboxStore,
  type PushStore,
} from "@openacme/db";
import { createPushDispatcher, type PushDispatcher } from "./push.js";
import { loadOrCreateVapidKeys, type VapidKeys } from "./utils/vapid.js";
import {
  registry as toolRegistry,
  bindSessionSearch,
  bindSkillView,
  bindMemory,
  bindTaskStore,
  bindBrowser,
  bindAgentTool,
  bindPingUser,
  bindDeferSession,
  bindToolHost,
  closeAllShellSessions,
  sweepOverflow,
  deleteSessionToolCalls,
  SYSTEM_TOOLS,
} from "@openacme/tools";
import { ToolHostManager } from "@openacme/tool-host";
import * as fs from "node:fs";
import { MemoryStore } from "@openacme/memory";
import { TaskStore } from "@openacme/tasks";
import {
  BrowserManager,
  createBrowserProvider,
  type AgentBrowserOverrides,
} from "@openacme/browser";
import { Dispatcher } from "./dispatcher.js";
import { SessionBroadcaster } from "./broadcaster.js";
import {
  MCPClient,
  FileMCPTokenStore,
  jsonSchemaToZod,
  type MCPTokenStore,
  type OAuthCallback,
  type ServerState,
  type ServerStatus,
} from "@openacme/mcp-client";
import type { McpServerDiscovery } from "@openacme/tool-host";
import {
  awaitLoopbackCallback,
  openBrowser,
  looksHeadless,
} from "@openacme/auth";
import { HubError, SkillHub, SkillRegistry, type SkillIndexEntry } from "@openacme/skills";
import {
  AgentCatalog,
  buildAgentFromTemplate,
  TemplateImportError,
  type AgentTemplate,
} from "@openacme/agent-catalog";
import * as path from "node:path";

// Same shape as `SAFE_ID` in `@openacme/memory` and `@openacme/config`'s
// agent-store. Duplicated here to avoid a cross-package import for one
// regex; the three must stay in sync.
const PEER_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Pull the operator-facing message out of a `ping_user` event payload.
 *  Payload shape is `{ message: string }` per ping.ts but the column is
 *  JSON-typed so we treat it as `unknown` and narrow defensively. */
function readPingMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const msg = (payload as { message?: unknown }).message;
  return typeof msg === "string" ? msg : "";
}

/** Read optional `<dataDir>/AGENTS.md`. Returns undefined when absent. */
function readAgentsMd(dataDir: string): string | undefined {
  const file = path.join(dataDir, "AGENTS.md");
  try {
    const content = fs.readFileSync(file, "utf-8");
    return content.trim().length > 0 ? content : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    log.warn({ err: e, file }, "failed to read file");
    return undefined;
  }
}

/** Write `<dataDir>/AGENTS.md`, or delete it when `content` is empty/whitespace. */
function writeAgentsMd(dataDir: string, content: string): void {
  const file = path.join(dataDir, "AGENTS.md");
  if (content.trim().length === 0) {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return;
  }
  const body = content.endsWith("\n") ? content : content + "\n";
  fs.writeFileSync(file, body, "utf-8");
}

/**
 * AgentManager — manages multiple agent instances, MCP connections, and skills.
 * Routes chat requests to the correct agent.
 */
export class AgentManager {
  private agents = new Map<string, Agent>();
  private db: ReturnType<typeof createDatabase>;
  readonly sessionStore: SessionStore;
  readonly messageStore: MessageStore;
  readonly commentStore: CommentStore;
  readonly eventStore: EventStore;
  readonly inboxStore: InboxStore;
  readonly pushStore: PushStore;
  readonly pushDispatcher: PushDispatcher;
  readonly vapid: VapidKeys;
  readonly attachmentsRoot: string;
  readonly agentsDir: string;
  /** `<dataDir>/AGENTS.md` contents; restart to pick up edits. */
  private agentsMd: string | undefined;
  readonly memoryStore: MemoryStore;
  readonly taskStore: TaskStore;
  /** Periodic state-checker. Replaces the old event-driven
   *  `TaskScheduler`. Public-readonly so `app.ts` (`/api/chat`'s
   *  interactive busy hooks) and `routes/home.ts` (runningSessionIds)
   *  can reach it. */
  readonly dispatcher: Dispatcher;
  readonly agentStore: AgentStore;
  readonly teamStore: TeamStore;
  /** Per-agent sandboxed workers executing the raw (worker-runtime)
   *  tools. Lazy: nothing spawns until the first such tool call. */
  readonly toolHostManager: ToolHostManager;
  readonly browserManager: BrowserManager;
  readonly agentCatalog: AgentCatalog;
  /** In-memory per-session pub/sub for SSE clients. Shared by scheduler,
   *  agent runtime, and the home + per-session stream routes. */
  readonly broadcaster: SessionBroadcaster;
  private config: Config;
  private mcpClients = new Map<string, MCPClient>();
  /** Worker-run stdio MCP servers per agent: last discovery snapshot +
   *  the daemon-side proxy tool names registered from it. */
  private stdioMcp = new Map<
    string,
    { discovery: McpServerDiscovery[]; toolNames: string[] }
  >();
  readonly skillRegistry: SkillRegistry;

  constructor(config: Config) {
    this.config = config;
    this.db = createDatabase(config);
    this.attachmentsRoot = path.join(config.dataDir, "attachments");
    // agentsDir is computed below too; resolve it early so the SessionStore
    // delete hook can cascade per-session tool-call spill files.
    const agentsDirEarly = path.join(config.dataDir, "agents");
    this.sessionStore = createSessionStore(this.db, {
      attachmentsRoot: this.attachmentsRoot,
      onAfterDelete: (session) => {
        deleteSessionToolCalls(agentsDirEarly, session.agentId, session.id);
      },
    });
    this.messageStore = createMessageStore(this.db);
    this.commentStore = createCommentStore(this.db);
    this.eventStore = createEventStore(this.db);
    this.inboxStore = createInboxStore(this.db);
    this.pushStore = createPushStore(this.db);

    // VAPID keys persist under `<dataDir>/push-vapid.json`, generated on
    // first boot. The dispatcher fans out to every subscribed device on
    // `ping_user`; without subscriptions it's a no-op so we initialize
    // unconditionally rather than gating on config.
    this.vapid = loadOrCreateVapidKeys(config.dataDir, null);
    this.pushDispatcher = createPushDispatcher({
      pushStore: this.pushStore,
      vapid: this.vapid,
      logger: {
        info: (msg) => log.info(msg),
        warn: (msg) => log.warn(msg),
      },
    });

    // Agents live as folders at <dataDir>/agents/<id>/AGENT.md — the
    // directory is the only source of truth, no DB mirror, no shadow
    // state in config.yaml.
    this.agentsDir = path.join(config.dataDir, "agents");
    this.agentStore = createAgentStore(this.agentsDir);
    // Teams live as folders at <dataDir>/teams/<id>/TEAM.md, same
    // filesystem-backed idiom as agents. Human-owned: written via the
    // HTTP routes / disk only, never by agent tools.
    this.teamStore = createTeamStore(path.join(config.dataDir, "teams"));
    this.agentsMd = readAgentsMd(config.dataDir);
    // One MemoryStore per AgentManager — shared between every Agent
    // instance and the `memory` tool's binding so the in-process mutex
    // map is consistent across both write paths.
    this.memoryStore = new MemoryStore(this.agentsDir);

    // Wire the FTS5-backed cross-session search into the `session_search`
    // tool. Done here so @openacme/tools doesn't need a runtime dep on
    // @openacme/db. `resolveRoot` lets the tool collapse compression chains
    // back to one root and exclude the current conversation's lineage.
    bindSessionSearch({
      search: (query, limit, agentId) =>
        this.messageStore.search(query, limit, agentId),
      resolveRoot: (sessionId) => this.sessionStore.getRoot(sessionId),
    });

    // Wire the per-agent MEMORY.md root into the `memory` tool. Same bind
    // pattern as session_search; the tool resolves the active agentId from
    // AsyncLocalStorage at handler call time and uses the store closure to
    // find the file. The index char cap is a platform constant
    // (`DEFAULT_MEMORY_CHAR_LIMIT`) — not per-agent — so the tool reads it
    // directly from `@openacme/memory`.
    bindMemory({
      store: this.memoryStore,
    });

    // Tasks: one shared TaskStore, bound to the task tools and driven
    // by the autonomous scheduler. CommentStore + EventStore wire the
    // store's mutating paths to event emission so the scheduler hears
    // about every state change and the agent's "Recent activity" prompt
    // surface stays current.
    this.taskStore = new TaskStore(path.join(config.dataDir, "tasks"), {
      commentStore: this.commentStore,
      eventStore: this.eventStore,
      validateSession: (id) => this.sessionStore.get(id) !== null,
    });
    bindTaskStore({ store: this.taskStore });

    // ping_user fires a session-anchored event the EventStore listener
    // fans out to (a) the broadcaster for the operator's inbox row and
    // (b) the scheduler's onEvent (no-op for session-only events).
    bindPingUser({
      emit: ({ sessionId, agentId, message }) => {
        this.eventStore.append({
          sessionId,
          agentId,
          kind: "ping_user",
          actor: agentId,
          payload: { message },
        });
      },
    });

    // `defer_session(duration)` writes `sessions.defer_until`. The
    // dispatcher honours it on its periodic tick (skips routine
    // spawns until the timestamp), and new inbox rows bypass it
    // (defer suppresses noise, not signal). Sticky — the field
    // persists across signal-driven wakes until it naturally expires
    // or the agent replaces it with another defer_session call.
    bindDeferSession({
      setDeferUntil: (sessionId, unixSeconds) => {
        this.sessionStore.setDeferUntil(sessionId, unixSeconds);
      },
    });

    this.broadcaster = new SessionBroadcaster();
    this.dispatcher = new Dispatcher({
      taskStore: this.taskStore,
      sessionStore: this.sessionStore,
      inboxStore: this.inboxStore,
      agentManager: this,
      broadcaster: this.broadcaster,
    });
    // Event fan-out has two branches now:
    //   1. Inbox delivery — each event is delivered to every *relevant*
    //      agent minus the actor. For task events that means both the
    //      assignee and the creator (when they differ); for non-task
    //      events the recipient is `event.agentId`. Echo suppression
    //      lives at this boundary, not at emit sites, so emits can carry
    //      the honest actor for audit purposes. Without the dual-recipient
    //      step the task creator never hears about the assignee's done /
    //      result-comment events (the assignee's `agentId === actor`
    //      collapses the only previous route).
    //   2. Broadcaster — SSE fan-out to subscribed UI tabs.
    this.eventStore.onEmit((event) => {
      const recipients = new Set<string>();
      if (event.taskId) {
        const task = this.taskStore.get(event.taskId);
        if (task) {
          if (task.assignee) recipients.add(task.assignee);
          if (task.created_by) recipients.add(task.created_by);
        } else if (event.agentId) {
          // Task already deleted (e.g. on `task_deleted`); fall back to
          // the event's declared agentId so the signal isn't lost.
          recipients.add(event.agentId);
        }
      } else if (event.agentId) {
        recipients.add(event.agentId);
      }
      if (event.actor) recipients.delete(event.actor);

      for (const agentId of recipients) {
        try {
          this.inboxStore.deliver({
            agentId,
            kind: "system_notice",
            source: "system",
            sourceId: event.actor ?? null,
            relatedTask: event.taskId ?? null,
            relatedSession: event.sessionId ?? null,
            payload: {
              eventKind: event.kind,
              eventId: event.id,
              payload: event.payload,
            },
          });
        } catch (e) {
          log.warn(
            { err: e, eventId: event.id, agentId },
            "inboxStore.deliver failed — signal lost for this agent"
          );
        }
      }

      const sessionId = event.sessionId ?? this.deriveSessionForEvent(event);
      if (sessionId) {
        this.broadcaster.broadcast(sessionId, {
          kind: "task_event",
          event: {
            id: event.id,
            taskId: event.taskId,
            sessionId,
            agentId: event.agentId,
            actor: event.actor ?? null,
            kind: event.kind,
            payload: event.payload,
            createdAt: event.createdAt,
          },
        });
      }

      // Web Push fan-out — only `ping_user` notifies today. Other events
      // (status changes, task assignments) flow to the inbox and the SSE
      // stream but stay off the lock screen unless the agent explicitly
      // calls ping_user.
      if (event.kind === "ping_user") {
        const message = readPingMessage(event.payload);
        const agentName = this.agentStore.get(event.agentId)?.name ?? event.agentId;
        const url = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/";
        void this.pushDispatcher
          .dispatch({
            // Title = agent name; body = the actual ping message text.
            // ping_user enforces message.min(1) so the fallback only fires
            // if a historical event somehow has no message payload.
            title: agentName,
            body: message || "wants your attention",
            url,
            tag: sessionId ?? `ping-${event.agentId}`,
          })
          .catch((err) => {
            log.warn({ err, eventId: event.id }, "push dispatch failed");
          });
      }
    });
    // `taskStore.setOnChange` used to drive scheduler cron-arm
    // reconciliation. The dispatcher is purely state-checking on a
    // 60s tick, so this hook is no longer needed. The tick rediscovers
    // any task state shift on its next pass — at worst a 60-second
    // delay for state changes that don't fire an event (rare).


    // Browser: per-agent session via a pluggable provider. Local provider
    // spawns one Chrome per agent under `<dataDir>/agents/<id>/browser-profile/`;
    // cloud providers (browserbase / browser-use / firecrawl) create one
    // remote session per agent. Lazy — nothing spawns until the first
    // browser_* tool call. Bound via the same placeholder pattern as
    // session_search so @openacme/tools stays free of a runtime dep on
    // playwright-core.
    const browserProvider = createBrowserProvider({
      name: config.browser.provider,
      dataDir: config.dataDir,
      config: config.browser,
    });
    this.browserManager = new BrowserManager({
      provider: browserProvider,
      resolveOverrides: (id) => this.agentStore.get(id)?.browser,
      ensureOverrides: (id, current) =>
        this.ensureBrowserOverridesAtAcquire(id, current),
    });
    bindBrowser({ manager: this.browserManager });

    // Per-agent tool-host workers: worker-runtime tools (filesystem,
    // shell, exec, process) route here instead of running in the daemon.
    // Policy is compiled fresh at every worker (re)spawn so AGENT.md /
    // TEAM.md edits take effect on the next worker without bookkeeping.
    this.toolHostManager = new ToolHostManager({
      dataDir: config.dataDir,
      compilePolicyFor: (agentId) =>
        compilePolicy({
          agentId,
          agentDefs: this.agentStore.list(),
          teams: this.teamStore.list(),
          dataDir: config.dataDir,
        }),
      // stdio MCP servers run as children of the sandboxed worker so
      // they inherit the agent's confinement. URL servers stay daemon-
      // side (no local process; OAuth machinery untouched).
      stdioMcpServersFor: (agentId) => {
        const def = this.agentStore.get(agentId);
        if (!def) return {};
        return this.partitionServers(this.serversForAgent(def)).stdio;
      },
    });
    bindToolHost(this.toolHostManager);

    // agent_list: surface the workforce directory + the calling agent's peer
    // notes inline so a delegating agent sees canonical role plus their
    // own lived experience in one tool result. Peer notes live at
    // `<agentDir>/memory/peers/<peerId>.md` per memory convention; read
    // directly here (no MemoryStore dep) to keep @openacme/tools free
    // of @openacme/config and @openacme/memory.
    bindAgentTool({
      listAgents: () =>
        this.agentStore.list().map((def) => ({
          id: def.id,
          name: def.name,
          role: def.role ?? "",
        })),
      peerNoteFor: (callerId, peerId) => {
        // Defense in depth — agent ids in the store are SAFE_ID-validated
        // on upsert, but path interpolation is a sharp tool. Reject any
        // id whose shape would let `path.join` escape the peers dir.
        if (!PEER_ID_SAFE.test(callerId) || !PEER_ID_SAFE.test(peerId)) {
          return null;
        }
        const file = path.join(
          this.memoryStore.dirPath(callerId),
          "peers",
          `${peerId}.md`
        );
        try {
          const st = fs.statSync(file);
          const content = fs.readFileSync(file, "utf-8");
          return { content, mtimeMs: st.mtimeMs };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
          log.warn(
            { err: e, callerId, peerId },
            "peerNoteFor read failed"
          );
          return null;
        }
      },
    });

    // Load skills
    this.skillRegistry = new SkillRegistry();
    const skillsDir = path.isAbsolute(config.skills.directory)
      ? config.skills.directory
      : path.join(config.dataDir, config.skills.directory);
    this.skillRegistry.loadFromDirectory(skillsDir);
    if (this.skillRegistry.size > 0) {
      console.log(`  📚 Loaded ${this.skillRegistry.size} skills`);
    }

    // Wire the skill registry into the `skill_view` tool so agents can
    // pull a skill's body + companion file list on demand. Same bind
    // pattern as session_search to keep @openacme/tools independent of
    // @openacme/skills at runtime.
    bindSkillView({
      lookup: (name) => {
        const s = this.skillRegistry.getSkill(name);
        return s
          ? {
              name: s.name,
              description: s.description,
              tags: s.tags,
              body: s.body,
              dirPath: s.dirPath,
              resources: s.resources.map((r) => ({
                relPath: r.relPath,
                size: r.size,
              })),
            }
          : null;
      },
      list: () => this.skillRegistry.getIndex(),
    });

    // Bundled agent templates. Read-once snapshot of `packages/agent-catalog/templates/`;
    // no live reload. Importers route through `importAgentFromTemplate`.
    this.agentCatalog = new AgentCatalog();

    // Sweep orphan sessions + tasks left behind by pre-cascade
    // `deleteAgent` calls. Agents are filesystem-backed (no DB FK
    // available), so this is a startup-time application-level GC.
    // After `deleteAgent` was fixed to cascade, this should be a no-op
    // on healthy installs; existing installs with orphans get a clean
    // sweep here.
    this.purgeOrphans();

    // Drop tool-overflow spill files older than 30 days from every
    // agent's workspace. One-shot at boot; cheap walk that prevents
    // unbounded growth in `.tool-overflow/` for long-lived agents.
    try {
      const swept = sweepOverflow(this.agentsDir);
      if (swept.removed > 0) {
        log.info(
          { removed: swept.removed, bytes: swept.bytes },
          "removed stale tool-overflow spill files"
        );
      }
    } catch (e) {
      log.warn({ err: e }, "tool-overflow sweep failed");
    }
  }

  /**
   * One-shot orphan cleanup: any session whose `agent_id` no longer
   * matches an agent on disk, and any task whose `assignee` is gone,
   * gets deleted. Idempotent. Logs a single summary line per run.
   */
  private purgeOrphans(): void {
    const knownAgentIds = new Set(this.agentStore.list().map((a) => a.id));
    const allSessions = this.sessionStore.listAllActive();
    const orphanSessions = allSessions.filter(
      (s) => !knownAgentIds.has(s.agentId)
    );
    const orphanTasks = this.taskStore
      .list()
      .filter((t) => !knownAgentIds.has(t.assignee));
    if (orphanSessions.length === 0 && orphanTasks.length === 0) return;
    for (const s of orphanSessions) {
      try {
        this.sessionStore.delete(s.id);
      } catch (e) {
        log.warn({ err: e, sessionId: s.id }, "purgeOrphans: failed to drop session");
      }
    }
    // Tasks: best-effort delete with force. TaskStore.delete is async
    // (file IO) — fire and let it settle in the background; ordering
    // doesn't matter and we don't block startup.
    void (async () => {
      for (const t of orphanTasks) {
        try {
          await this.taskStore.delete(t.id, {
            force: true,
            actor: "system:purge-orphans",
          });
        } catch (e) {
          log.warn({ err: e, taskId: t.id }, "purgeOrphans: failed to drop task");
        }
      }
    })();
    console.log(
      `Workforce GC: cleaned ${orphanSessions.length} orphan session(s) and ${orphanTasks.length} orphan task(s) from deleted agents.`
    );
  }

  /**
   * Initialize MCP connections for every agent at boot.
   *
   * Each agent gets its own `MCPClient` so per-agent disable/private
   * servers don't leak across agents and so `disconnectServer` on one
   * agent leaves the others untouched.
   */
  async initMCP(): Promise<void> {
    // Parallelize across agents — each gets its own MCPClient and connects
    // independently, so there's no shared state to serialize on. Cuts boot
    // time roughly N× for N agents pointing at the same servers.
    await Promise.all(
      this.agentStore
        .list()
        .map((def) => this.reinitMCPForAgent(def.id))
    );
  }

  /**
   * Resolve the effective server set for one agent:
   *   (global mcp.json) − agentDef.mcpDisabled  ∪  agentDef.mcpServers
   *
   * No merging by name. Collisions are rejected on agent-store write,
   * so the only way they reach here is a hand-edit of mcp.json after
   * the agent was saved — log and skip the global one to avoid
   * silently shadowing the user's per-agent intent.
   */
  serversForAgent(def: AgentDefinition): Record<string, MCPServerConfig> {
    const global = loadGlobalMcpServers(this.config.dataDir);
    const disabled = new Set(def.mcpDisabled ?? []);
    const out: Record<string, MCPServerConfig> = {};

    for (const [name, cfg] of Object.entries(global)) {
      if (disabled.has(name)) continue;
      // Defensive only — agent-store rejects this collision on write,
      // so it'd take an out-of-band hand-edit to mcp.json AFTER the agent
      // was saved to land here. Skip silently; the user's intent (the
      // private entry) wins on the next save round-trip.
      if (Object.prototype.hasOwnProperty.call(def.mcpServers ?? {}, name)) {
        continue;
      }
      out[name] = cfg;
    }
    for (const [name, cfg] of Object.entries(def.mcpServers ?? {})) {
      out[name] = cfg;
    }
    return out;
  }

  /** Split an agent's effective server map by where they run: stdio
   *  servers (local child processes) belong inside the sandboxed worker;
   *  URL servers stay daemon-side. */
  private partitionServers(servers: Record<string, MCPServerConfig>): {
    stdio: Record<string, MCPServerConfig>;
    url: Record<string, MCPServerConfig>;
  } {
    const stdio: Record<string, MCPServerConfig> = {};
    const url: Record<string, MCPServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg.command) stdio[name] = cfg;
      else url[name] = cfg;
    }
    return { stdio, url };
  }

  /** Drop the daemon-side proxy registrations for an agent's worker-run
   *  stdio MCP tools. */
  private deregisterStdioMcp(id: string): void {
    const prev = this.stdioMcp.get(id);
    if (!prev) return;
    for (const name of prev.toolNames) toolRegistry.deregister(name);
    this.stdioMcp.delete(id);
  }

  /**
   * Tear down and rebuild the MCP client for one agent. Called from
   * `initMCP` and agent CRUD. (No file watcher: editing `mcp.json`
   * requires a server restart by design — simpler model than reasoning
   * about hot reload races.)
   */
  async reinitMCPForAgent(id: string): Promise<void> {
    const def = this.agentStore.get(id);
    if (!def) {
      // Agent may have been deleted between the change event and the
      // reinit — disconnect any leftover client and bail.
      const stale = this.mcpClients.get(id);
      if (stale) {
        await stale.disconnect();
        this.mcpClients.delete(id);
      }
      this.deregisterStdioMcp(id);
      return;
    }

    const existing = this.mcpClients.get(id);
    if (existing) {
      await existing.disconnect();
      this.mcpClients.delete(id);
    }
    // Restart the worker so its stdio MCP children come up under the
    // current config (the init payload is computed at spawn time).
    this.deregisterStdioMcp(id);
    await this.toolHostManager.stopWorker(id);

    const { stdio, url } = this.partitionServers(this.serversForAgent(def));
    if (Object.keys(stdio).length + Object.keys(url).length === 0) {
      // Drop the cached Agent so any tool change (not just MCP) lands
      // on the next chat call.
      this.agents.delete(id);
      return;
    }

    if (Object.keys(url).length > 0) {
      const mcpClient = new MCPClient(toolRegistry, {
        tokenStore: this.mcpTokenStore(),
        oauthRedirectUrl: this.mcpOAuthRedirectUrl(),
        onUnauthorized: this.mcpOAuthCallback,
      });
      // Boot/reinit don't drive the browser flow — they'd block for up to
      // 5min waiting for the loopback. Servers needing auth land in
      // `awaiting_oauth`; the user explicitly hits the connect endpoint
      // (which omits skipOAuth) to authorize.
      await mcpClient.connect(url, { skipOAuth: true });
      this.mcpClients.set(id, mcpClient);
    }

    if (Object.keys(stdio).length > 0) {
      // Eager worker spawn: tool definitions must exist at prompt-build
      // time, and only MCP discovery is dynamic. Failure-tolerant — a
      // broken stdio server (or worker) must not block agent creation.
      try {
        const discovery = await this.toolHostManager.discoverMcp(id);
        const toolNames: string[] = [];
        for (const server of discovery) {
          for (const tool of server.tools) {
            const registryName = `mcp_${server.server}__${tool.name}`;
            toolRegistry.register({
              name: registryName,
              toolset: `mcp-${server.server}`,
              description:
                tool.description ??
                `Tool from MCP server '${server.server}'`,
              parameters: jsonSchemaToZod(tool.inputSchema),
              emoji: "🔌",
              parallelSafe: true,
              // Execution happens in the worker, where the real MCP
              // client registered the same name; this daemon-side entry
              // is schema + routing only.
              runtime: "worker",
              handler: async () =>
                JSON.stringify({
                  error: `MCP tool '${registryName}' requires the agent's tool-host worker`,
                }),
            });
            toolNames.push(registryName);
          }
        }
        this.stdioMcp.set(id, { discovery, toolNames });
      } catch (e) {
        log.warn(
          { err: e, agentId: id },
          "stdio MCP discovery via tool-host failed; agent comes up without those tools"
        );
      }
    }

    // System prompt + tool list both depend on MCP discovery — evict
    // the cached Agent so the next chat picks up the new tool set.
    // Per-server state (connected/failed/awaiting_oauth/lastError) lives
    // in `getStatus()` for callers that want to surface it.
    this.agents.delete(id);
  }

  /**
   * MCP server status, optionally scoped to one agent.
   */
  getMcpStatus(agentId?: string): Array<{ agentId: string; servers: ServerStatus[] }> {
    const ids = agentId
      ? [agentId]
      : [...new Set([...this.mcpClients.keys(), ...this.stdioMcp.keys()])];
    return ids.map((id) => ({
      agentId: id,
      servers: [
        ...(this.mcpClients.get(id)?.getStatus() ?? []),
        // Worker-run stdio servers, reshaped to the ServerStatus contract.
        ...(this.stdioMcp.get(id)?.discovery ?? []).map((d) => ({
          name: d.server,
          state: d.state as ServerState,
          connected: d.connected,
          toolCount: d.tools.length,
          tools: d.tools.map((t) => `mcp_${d.server}__${t.name}`),
          lastError: d.lastError,
          attemptCount: 0,
          transport: "stdio" as const,
        })),
      ],
    }));
  }

  /**
   * Direct access to a per-agent MCP client. Used by per-server
   * connect/disconnect/test routes that need to touch the live client.
   */
  getMcpClient(agentId: string): MCPClient | undefined {
    return this.mcpClients.get(agentId);
  }

  /**
   * Wipe stored OAuth tokens for one MCP server. Used by the reauth
   * endpoint — next connect will trigger a fresh browser flow.
   */
  async clearMcpOAuthTokens(serverName: string): Promise<void> {
    await this.mcpTokenStore().deleteTokens(serverName);
  }

  /**
   * Resolve an agent's effective model. Per-agent `model` overrides the
   * root `config.yaml` model; missing per-agent → fall back to root.
   * `AgentDefinitionSchema.model` is intentionally optional so we can
   * detect "user didn't override" here instead of baking in the schema's
   * hardcoded defaults.
   */
  private resolveModel(def: AgentDefinition): ModelConfig {
    return def.model ?? this.config.model;
  }

  /**
   * Return an agent def with `model` resolved against the root config.
   * Called on every list/get boundary so callers (HTTP, web, internal)
   * see a fully-populated model regardless of whether the AGENT.md
   * file specified one. The returned type narrows `model` to non-optional.
   */
  private withResolvedModel(
    def: AgentDefinition
  ): AgentDefinition & { model: ModelConfig } {
    return def.model
      ? (def as AgentDefinition & { model: ModelConfig })
      : { ...def, model: this.config.model };
  }

  /**
   * Get or lazily create an Agent instance.
   */
  getAgent(id: string): Agent {
    let agent = this.agents.get(id);
    if (!agent) {
      const def = this.agentStore.get(id);
      if (!def) throw new Error(`Agent not found: ${id}`);
      agent = this.createAgentFromDef(def);
      this.agents.set(id, agent);
    }
    return agent;
  }

  /**
   * Get an agent definition with its effective model resolved.
   */
  getAgentDef(
    id: string
  ): (AgentDefinition & { model: ModelConfig }) | null {
    const def = this.agentStore.get(id);
    return def ? this.withResolvedModel(def) : null;
  }

  /**
   * List all agent definitions with their effective models resolved.
   */
  listAgents(): (AgentDefinition & { model: ModelConfig })[] {
    return this.agentStore.list().map((def) => this.withResolvedModel(def));
  }

  /**
   * Create a new agent definition. If MCP servers are configured (global
   * or private), we reinit MCP so the new agent picks them up immediately.
   */
  async createAgent(def: AgentDefinition): Promise<Agent> {
    const provisioned = await this.ensureAgentBrowserProfile(def);
    this.agentStore.upsert(provisioned);
    // A new agent changes every OTHER agent's compiled path policy (its
    // memory/sessions dirs join their deny-read lists) — drop all cached
    // Agents and workers so the next call rebuilds with fresh policies.
    // Rare + cheap (workers respawn lazily).
    this.agents.clear();
    await this.toolHostManager.stopAll();
    await this.reinitMCPForAgent(provisioned.id);
    const agent = this.createAgentFromDef(provisioned);
    this.agents.set(provisioned.id, agent);
    return agent;
  }

  /**
   * Auto-provision a per-agent profile on cloud browser providers so each
   * new agent starts with its own cookie isolation. Mirrors how
   * `<agentDir>/browser-profiles/` is auto-created for the local provider.
   *
   * Currently only Browser Use needs upfront provisioning (its profiles are
   * UUID-bound and must exist before a session references them). Firecrawl
   * auto-creates profiles by name on first session use (`profile.name` =
   * agent id by default), so no upfront call needed.
   *
   * No-op when: the agent already has a profileId, the workforce isn't on
   * Browser Use, or the API key isn't configured. Failure-tolerant: a
   * failed provision logs a warning and leaves the agent without a profile
   * (sessions stay ephemeral until the user attaches one later via
   * cookie-sync + AGENT.md edit).
   */
  private async ensureAgentBrowserProfile(
    def: AgentDefinition
  ): Promise<AgentDefinition> {
    const provider = this.config.browser.provider;
    if (provider === "browser-use") {
      return this.ensureBrowserUseProfile(def);
    }
    if (provider === "firecrawl") {
      return this.ensureFirecrawlProfile(def);
    }
    if (provider === "browserbase") {
      return this.ensureBrowserbaseContext(def);
    }
    // local doesn't need an upfront / stamped profile — it uses per-agent
    // dirs auto-created at agent build time.
    return def;
  }

  /**
   * Browser Use needs a real API call to provision a profile (UUID-bound).
   * No-op when already set. Failure-tolerant — leaves the agent without a
   * profile so sessions stay ephemeral until the user attaches one later.
   */
  private async ensureBrowserUseProfile(
    def: AgentDefinition
  ): Promise<AgentDefinition> {
    if (def.browser?.browserUse?.profileId) return def;
    const apiKey = process.env.BROWSER_USE_API_KEY;
    if (!apiKey) return def;

    // Profiles live on /api/v2 even though sessions are on /api/v3. Derive
    // from BROWSER_USE_BASE_URL by swapping the version segment so a single
    // env var still controls the endpoint host; an explicit
    // BROWSER_USE_PROFILES_BASE_URL wins for internal/proxied deployments.
    const baseUrl = (
      process.env.BROWSER_USE_PROFILES_BASE_URL ??
      (process.env.BROWSER_USE_BASE_URL ?? "https://api.browser-use.com/api/v3").replace(
        /\/api\/v\d+\/?$/,
        "/api/v2"
      )
    ).replace(/\/+$/, "");
    try {
      const res = await fetch(`${baseUrl}/profiles`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Browser-Use-API-Key": apiKey,
        },
        // userId tags the profile with the agent id so it's findable in the
        // Browser Use dashboard. name surfaces the same identifier in their UI.
        body: JSON.stringify({ userId: def.id, name: def.id }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log.warn(
          { status: res.status, agentId: def.id },
          "browser-use profile auto-create failed; agent will use ephemeral sessions"
        );
        return def;
      }
      const data = (await res.json()) as { id?: string };
      if (!data.id) {
        log.warn(
          { agentId: def.id },
          "browser-use profile auto-create response missing id"
        );
        return def;
      }
      log.info(
        { agentId: def.id, profileId: data.id },
        "browser-use profile auto-provisioned"
      );
      return {
        ...def,
        browser: {
          ...def.browser,
          browserUse: { ...def.browser?.browserUse, profileId: data.id },
        },
      };
    } catch (e) {
      log.warn(
        { err: e, agentId: def.id },
        "browser-use profile auto-create errored"
      );
      return def;
    }
  }

  /**
   * Firecrawl uses name-bound profiles that auto-create on first session
   * reference — no API call needed. We still stamp the default name
   * (agentId) into AGENT.md so the binding is visible on disk and the user
   * can rename it later. Idempotent.
   */
  private async ensureFirecrawlProfile(
    def: AgentDefinition
  ): Promise<AgentDefinition> {
    if (def.browser?.firecrawl?.profileName) return def;
    return {
      ...def,
      browser: {
        ...def.browser,
        firecrawl: { ...def.browser?.firecrawl, profileName: def.id },
      },
    };
  }

  /**
   * Browserbase Contexts are UUID-bound persistent stores (cookies,
   * localStorage, IndexedDB). One per agent — sessions hydrate from the
   * context at start and write deltas back on release. Failure-tolerant.
   */
  private async ensureBrowserbaseContext(
    def: AgentDefinition
  ): Promise<AgentDefinition> {
    if (def.browser?.browserbase?.contextId) return def;
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    if (!apiKey || !projectId) return def;

    const baseUrl = (
      process.env.BROWSERBASE_BASE_URL ?? "https://api.browserbase.com"
    ).replace(/\/+$/, "");
    try {
      const res = await fetch(`${baseUrl}/v1/contexts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BB-API-Key": apiKey,
        },
        body: JSON.stringify({ projectId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log.warn(
          { status: res.status, agentId: def.id },
          "browserbase context auto-create failed; agent will use ephemeral sessions"
        );
        return def;
      }
      const data = (await res.json()) as { id?: string };
      if (!data.id) {
        log.warn(
          { agentId: def.id },
          "browserbase context auto-create response missing id"
        );
        return def;
      }
      log.info(
        { agentId: def.id, contextId: data.id },
        "browserbase context auto-provisioned"
      );
      return {
        ...def,
        browser: {
          ...def.browser,
          browserbase: { ...def.browser?.browserbase, contextId: data.id },
        },
      };
    } catch (e) {
      log.warn(
        { err: e, agentId: def.id },
        "browserbase context auto-create errored"
      );
      return def;
    }
  }

  /**
   * Tear down cloud-side browser identity on agent delete. Called from
   * deleteAgent before the def is removed from disk so the UUID is still
   * readable. Failure-tolerant — a failed cleanup logs a warn but never
   * blocks local deletion.
   *
   * Browser Use: their public API does not expose a delete-profile
   * endpoint (verified 2026-05-22), so profiles linger in their dashboard
   * until the user removes them manually. Firecrawl: name-bound profiles
   * are server-managed; no explicit delete needed.
   */
  private async releaseAgentBrowserIdentity(
    def: AgentDefinition
  ): Promise<void> {
    const provider = this.config.browser.provider;
    if (provider === "browserbase" && def.browser?.browserbase?.contextId) {
      const apiKey = process.env.BROWSERBASE_API_KEY;
      if (!apiKey) return;
      const baseUrl = (
        process.env.BROWSERBASE_BASE_URL ?? "https://api.browserbase.com"
      ).replace(/\/+$/, "");
      const contextId = def.browser.browserbase.contextId;
      try {
        const res = await fetch(`${baseUrl}/v1/contexts/${contextId}`, {
          method: "DELETE",
          headers: { "X-BB-API-Key": apiKey },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          log.warn(
            { status: res.status, agentId: def.id, contextId },
            "browserbase context delete failed; orphan left in dashboard"
          );
        } else {
          log.info(
            { agentId: def.id, contextId },
            "browserbase context released"
          );
        }
      } catch (e) {
        log.warn(
          { err: e, agentId: def.id, contextId },
          "browserbase context delete errored; orphan left in dashboard"
        );
      }
    }
  }

  /**
   * Lazy-provision hook for BrowserManager. If the agent has no profile
   * for the active provider, create one now and persist it back to the
   * agent store so subsequent acquires skip this work. Failure-tolerant —
   * returns the original overrides on any error so the acquire can still
   * proceed (just ephemeral).
   */
  private async ensureBrowserOverridesAtAcquire(
    agentId: string,
    current: AgentBrowserOverrides | undefined
  ): Promise<AgentBrowserOverrides | undefined> {
    const provider = this.config.browser.provider;
    // Already-set guards per provider — cheap shortcut to avoid a store read
    // on every acquire after the first. Unknown / "local" providers don't
    // need provisioning, so fall through to return current.
    if (provider === "browser-use") {
      if (current?.browserUse?.profileId) return current;
    } else if (provider === "firecrawl") {
      if (current?.firecrawl?.profileName) return current;
    } else if (provider === "browserbase") {
      if (current?.browserbase?.contextId) return current;
    } else {
      return current;
    }
    const def = this.agentStore.get(agentId);
    if (!def) return current;
    const provisioned = await this.ensureAgentBrowserProfile(def);
    if (provisioned === def) return current;
    this.agentStore.upsert(provisioned);
    this.agents.delete(agentId);
    return provisioned.browser;
  }

  /**
   * Update an existing agent definition. Reinit MCP if the change touched
   * any MCP-relevant field — otherwise just evict the cached Agent.
   */
  async updateAgent(
    id: string,
    updates: Partial<AgentDefinition>
  ): Promise<AgentDefinition> {
    const existing = this.agentStore.get(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);
    if (existing.managed) throw managedAgentError(id, "edited");

    const updated: AgentDefinition = {
      ...existing,
      ...updates,
      id,
      // Deep-merge model so partial callers (e.g. model picker sending only
      // {provider, model}) don't clobber auth/apiKey/baseUrl/headers.
      model: updates.model
        ? { ...existing.model, ...updates.model }
        : existing.model,
    };
    this.agentStore.upsert(updated);

    const mcpChanged =
      hasOwn(updates, "mcpServers") || hasOwn(updates, "mcpDisabled");

    if (mcpChanged) {
      // reinit restarts the worker itself (stdio MCP children must come
      // up under the new config).
      await this.reinitMCPForAgent(id);
    } else {
      // Tool list / persona / model only — evict the cached Agent and
      // restart the worker: definition changes (e.g. `paths` grants)
      // alter the compiled sandbox profile.
      this.agents.delete(id);
      await this.toolHostManager.stopWorker(id);
    }

    return updated;
  }

  /**
   * Create a team. Member agents' cached Agent instances are evicted so
   * their next chat rebuilds the system prompt with the `## Teams`
   * section (and, later, the recompiled access policy).
   */
  createTeam(team: TeamDefinition): TeamDefinition {
    if (this.teamStore.get(team.id)) {
      throw new Error(`Team already exists: ${team.id}`);
    }
    this.teamStore.upsert(team);
    for (const member of team.members) this.evictAgent(member);
    return this.teamStore.get(team.id)!;
  }

  /**
   * Update a team definition. Evicts the union of old + new members —
   * removed members must lose the section, added members must gain it.
   */
  updateTeam(id: string, updates: Partial<TeamDefinition>): TeamDefinition {
    const existing = this.teamStore.get(id);
    if (!existing) throw new Error(`Team not found: ${id}`);
    const updated: TeamDefinition = { ...existing, ...updates, id };
    this.teamStore.upsert(updated);
    const affected = new Set([...existing.members, ...updated.members]);
    for (const member of affected) this.evictAgent(member);
    return this.teamStore.get(id)!;
  }

  /**
   * Delete an agent. Cascades to:
   *  - All sessions owned by this agent (their messages cascade via FK,
   *    their attachment dirs via SessionStore.delete's FS hook).
   *  - All tasks assigned to or created by this agent.
   *  - The agent's broadcaster ring buffers.
   *  - The MCP client (so stdio subprocesses don't leak).
   *
   * Agents are filesystem-backed (not a DB row) so the FK route isn't
   * available — this is application-level cascade. Without it, deleting
   * an agent leaves orphan sessions whose `agent_id` references a
   * vanished folder; on every daemon restart the scheduler tries to
   * wake them and warns about the missing agent. Same for tasks
   * assigned to the deleted agent — they'd sit forever as zombies.
   */
  async deleteAgent(id: string): Promise<void> {
    const existing = this.agentStore.get(id);
    if (existing?.managed) throw managedAgentError(id, "deleted");
    const mcpClient = this.mcpClients.get(id);
    if (mcpClient) {
      await mcpClient.disconnect();
      this.mcpClients.delete(id);
    }
    // Removing an agent changes every other agent's compiled path policy
    // (deny-read entries for the removed dirs disappear) — clear all,
    // and kill every worker so stale sandbox profiles don't linger.
    this.agents.clear();
    this.deregisterStdioMcp(id);
    await this.toolHostManager.stopAll();

    // Kill the agent's browser session BEFORE agentStore.delete blows away
    // the on-disk profile dir. Per-agent now; orphan Chrome would prevent
    // clean rmdir of <agents/<id>/browser-profile/.
    try {
      await this.browserManager.closeAgent(id);
    } catch (e) {
      log.warn({ err: e, agentId: id }, "deleteAgent: failed to close browser session");
    }

    // Sessions: list cross-agent leaves then filter; SessionStore.list
    // is per-agent so we can use it directly here.
    const sessions = this.sessionStore.list(id);
    for (const s of sessions) {
      try {
        this.broadcaster.forget(s.id);
        this.sessionStore.delete(s.id);
      } catch (e) {
        log.warn(
          { err: e, sessionId: s.id, agentId: id },
          "deleteAgent: failed to drop session"
        );
      }
    }

    // Release cloud-side browser identity (Browserbase context, etc.) so
    // the user's dashboard doesn't accumulate orphans. Must run while the
    // def is still on disk (we need the UUID); failure-tolerant — never
    // blocks local cleanup.
    if (existing) {
      await this.releaseAgentBrowserIdentity(existing);
    }

    // Tasks: anything assigned to or created by this agent. We delete
    // rather than reassign — there's no obvious target, and a future
    // operator can recreate the work after they re-create the agent
    // if needed. Force the cascade to also drop dependents.
    const owned = this.taskStore.list({ assignee: id });
    const created = this.taskStore
      .list({ created_by: id })
      .filter((t) => t.assignee !== id);
    for (const t of [...owned, ...created]) {
      try {
        await this.taskStore.delete(t.id, {
          force: true,
          actor: "system:agent-delete",
        });
      } catch (e) {
        log.warn(
          { err: e, taskId: t.id, agentId: id },
          "deleteAgent: failed to drop task"
        );
      }
    }

    this.agentStore.delete(id);
  }

  /** Drop the cached `Agent` for `id`. The next chat call rebuilds it,
   *  which re-walks resources, re-collects MCP tool names, and rebuilds
   *  the system prompt. Use after any change that affects what
   *  `createAgentFromDef` would produce — including resource mutations.
   */
  evictAgent(id: string): void {
    this.agents.delete(id);
    // Kill the agent's tool-host worker too — the next worker-runtime
    // tool call respawns it under a freshly compiled policy.
    void this.toolHostManager.stopWorker(id);
  }

  /** For events emitted by TaskStore before the new sessionId column
   *  was always populated, derive the session from the task's current
   *  binding so SSE fan-out still routes correctly. New emits in the
   *  store layer pass sessionId explicitly; this is a fallback. */
  private deriveSessionForEvent(event: {
    taskId: string | null;
    sessionId: string | null;
  }): string | null {
    if (event.sessionId) return event.sessionId;
    if (!event.taskId) return null;
    const task = this.taskStore.get(event.taskId);
    return task?.session_id ?? null;
  }

  /**
   * Import a bundled agent template:
   *   1. Install recommended skills via SkillHub (skip already-installed; failures collected, never throw).
   *   2. Add recommended MCP servers to global mcp.json (skip name collisions).
   *   3. Build the AgentDefinition + createAgent (existing path — handles MCP reinit + cache).
   *   4. Copy template resources into <agentDir>/resources/, then evict the cached
   *      Agent so the next chat picks up the resource listing in its prompt.
   *
   * Multi-instance: the same template can be imported repeatedly; the id
   * auto-increments off `default_id_hint`. Each instance gets its own
   * folder, memory, sessions, and tasks queue.
   */
  async importAgentFromTemplate(
    templateId: string,
    opts: { idOverride?: string; nameOverride?: string; overrides?: Partial<AgentDefinition> }
  ): Promise<{ agent: AgentDefinition; manifest: ImportManifest }> {
    const template = this.agentCatalog.get(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }
    const manifest: ImportManifest = {
      agent: { id: "", resourceFiles: [] },
      workforce: { skills: [], mcpServers: [] },
    };

    const deps = await this.installTemplateDependencies(template);
    manifest.workforce.skills = deps.skills;
    manifest.workforce.mcpServers = deps.mcpServers;

    // Stage 2 — materialize the agent folder
    const existingIds = new Set(this.agentStore.list().map((d) => d.id));
    let def: AgentDefinition;
    try {
      def = buildAgentFromTemplate(template, opts, existingIds);
    } catch (err) {
      if (err instanceof TemplateImportError) {
        throw new Error(err.message);
      }
      throw err;
    }
    await this.createAgent(def);

    // Resources go in after createAgent so the agent folder exists.
    manifest.agent.resourceFiles = this.copyTemplateResources(template, def.id);
    manifest.agent.id = def.id;
    // Resources changed after createAgent ran; rebuild prompt on next chat.
    this.evictAgent(def.id);

    return { agent: def, manifest };
  }

  /**
   * Install bundled skills + merge bundled MCP servers for a template.
   * Shared by `importAgentFromTemplate` and `refreshManagedAgents`. The
   * return shape feeds directly into `ImportManifest.workforce`.
   *
   * SkillHub is the single source of truth for "is this installed". An
   * in-process SkillRegistry pre-check would short-circuit the heal path
   * when the registry has a stale view (e.g. skill files removed by hand
   * since boot). Always call install and translate the outcome.
   */
  private async installTemplateDependencies(
    template: AgentTemplate
  ): Promise<{
    skills: ImportManifest["workforce"]["skills"];
    mcpServers: ImportManifest["workforce"]["mcpServers"];
  }> {
    const skills: ImportManifest["workforce"]["skills"] = [];
    const mcpServers: ImportManifest["workforce"]["mcpServers"] = [];

    if (template.bundledSkills.length > 0) {
      const skillsDir = path.isAbsolute(this.config.skills.directory)
        ? this.config.skills.directory
        : path.join(this.config.dataDir, this.config.skills.directory);
      const hub = new SkillHub(skillsDir, this.skillRegistry);
      for (const s of template.bundledSkills) {
        try {
          await hub.install(s.identifier, {
            source: s.source,
            nameOverride: s.name,
          });
          skills.push({ name: s.name, action: "installed" });
        } catch (err) {
          if (err instanceof HubError && err.code === "ALREADY_INSTALLED") {
            skills.push({ name: s.name, action: "kept" });
            continue;
          }
          skills.push({
            name: s.name,
            action: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (template.bundledMcpServers.length > 0) {
      const globalMcp = loadGlobalMcpServers(this.config.dataDir);
      let changed = false;
      for (const m of template.bundledMcpServers) {
        if (Object.prototype.hasOwnProperty.call(globalMcp, m.name)) {
          mcpServers.push({ name: m.name, action: "kept" });
          continue;
        }
        globalMcp[m.name] = m.config;
        changed = true;
        mcpServers.push({ name: m.name, action: "added" });
      }
      if (changed) {
        saveGlobalMcpServers(this.config.dataDir, globalMcp);
        await this.initMCP();
      }
    }

    return { skills, mcpServers };
  }

  /**
   * Copy a template's `resources/` contents into the agent's
   * `<agentDir>/resources/`. Overwrites existing files of the same
   * relPath; leaves any unrelated files alone. Returns the per-file
   * listing for the import manifest.
   */
  private copyTemplateResources(
    template: AgentTemplate,
    agentId: string
  ): Array<{ relPath: string; size: number }> {
    const dir = this.agentStore.agentDir(agentId);
    if (!dir) return [];
    const out: Array<{ relPath: string; size: number }> = [];
    for (const r of template.resources) {
      const dest = path.join(dir, "resources", r.relPath);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(r.absPath, dest);
        out.push({ relPath: r.relPath, size: r.size });
      } catch (err) {
        log.warn(
          { err, relPath: r.relPath, dest },
          "agent-catalog: copy resource failed"
        );
      }
    }
    return out;
  }

  /**
   * Yield every catalog template whose frontmatter sets `managed: true`,
   * paired with its target id (the `default_id_hint` slot). Shared by
   * ensure/refresh so the "managed template" filter lives in one place.
   */
  private *managedTemplates(): Generator<{
    templateId: string;
    template: AgentTemplate;
    targetId: string;
  }> {
    for (const meta of this.agentCatalog.list()) {
      const template = this.agentCatalog.get(meta.id);
      if (!template) continue;
      if (!template.agentFields.managed) continue;
      yield {
        templateId: meta.id,
        template,
        targetId: template.meta.defaultIdHint,
      };
    }
  }

  /**
   * Materialize platform-managed catalog templates (today: Acme) that
   * aren't on disk. Per-template idempotent — occupied slots are left
   * alone; the refresh path handles version drift. Failure-tolerant: a
   * busted install logs and the next template is tried.
   */
  async ensureManagedAgents(): Promise<void> {
    for (const { templateId, targetId } of this.managedTemplates()) {
      if (this.agentStore.get(targetId)) continue;
      try {
        await this.importAgentFromTemplate(templateId, {});
      } catch (e) {
        log.warn({ err: e, templateId }, "failed to materialize managed agent");
      }
    }
  }

  /**
   * Refresh on-disk managed agents from the catalog. Skips (a) missing
   * slots — ensureManagedAgents installs those — and (b) on-disk
   * `managed: false` — user took ownership, respect it. For the rest:
   * overwrite AGENT.md, re-copy resources (template-owned; extras left
   * alone), reinstall bundled skills + MCP (idempotent), evict the
   * cached Agent so the next chat picks up the new persona/tools.
   */
  async refreshManagedAgents(): Promise<void> {
    for (const { templateId, template, targetId } of this.managedTemplates()) {
      const onDisk = this.agentStore.get(targetId);
      if (!onDisk || !onDisk.managed) continue;

      try {
        await this.installTemplateDependencies(template);

        const existingIds = new Set(this.agentStore.list().map((d) => d.id));
        existingIds.delete(targetId);
        const fresh = buildAgentFromTemplate(
          template,
          { idOverride: targetId },
          existingIds
        );
        this.agentStore.upsert(fresh);
        this.copyTemplateResources(template, fresh.id);

        await this.reinitMCPForAgent(fresh.id);
        this.evictAgent(fresh.id);

        log.info({ templateId, agentId: fresh.id }, "refreshed managed agent");
      } catch (e) {
        log.warn({ err: e, templateId }, "failed to refresh managed agent");
      }
    }
  }

  /**
   * Refresh every platform-bundled (`source: builtin`) skill currently
   * installed via SkillHub. `hub.update()` content-hash compares and
   * no-ops if the bundled SKILL.md is unchanged — cheap to call on
   * every version bump. Non-builtin skills are intentionally skipped:
   * the platform-update path shouldn't fetch new versions of skills
   * the user installed from arbitrary GitHub repos.
   */
  async refreshBundledSkills(): Promise<void> {
    const skillsDir = path.isAbsolute(this.config.skills.directory)
      ? this.config.skills.directory
      : path.join(this.config.dataDir, this.config.skills.directory);
    const hub = new SkillHub(skillsDir, this.skillRegistry);
    const builtinEntries = hub.lockfile
      .list()
      .filter((e) => e.source === "builtin");
    await Promise.all(
      builtinEntries.map((entry) =>
        hub.update(entry.name).catch((err) => {
          log.warn({ err, skill: entry.name }, "failed to refresh bundled skill");
        })
      )
    );
  }

  /** Current AGENTS.md content, or undefined when the file is absent. */
  getAgentsMd(): string | undefined {
    return this.agentsMd;
  }

  /** Set AGENTS.md content. Empty/whitespace deletes the file. Evicts
   *  cached Agents so next activation rebuilds the system prompt. */
  setAgentsMd(content: string): void {
    writeAgentsMd(this.config.dataDir, content);
    this.agentsMd = readAgentsMd(this.config.dataDir);
    this.agents.clear();
  }

  /**
   * Re-read `config.yaml` from disk and evict cached Agents so the next
   * chat picks up the new model / behavior / etc. Called by setup paths
   * (web `/api/setup/*` and `/api/keys`) after they write a top-level
   * `model` to config so the bundled Acme agent (which inherits the
   * platform default) reflects the just-saved provider immediately —
   * without forcing the user to restart the daemon.
   *
   * Doesn't reload skills, the agent store, or MCP — those have their
   * own refresh paths.
   */
  reloadConfig(): void {
    this.config = loadConfig(this.config.dataDir);
    this.agents.clear();
  }

  private createAgentFromDef(def: AgentDefinition): Agent {
    // Collect MCP tool names for this agent. `getStatus` now includes
    // disabled/failed/disconnected entries (their tool list is empty),
    // so filter to actively connected servers — explicit > implicit.
    const mcpToolNames: string[] = [];
    const mcpClient = this.mcpClients.get(def.id);
    if (mcpClient) {
      for (const status of mcpClient.getStatus()) {
        if (!status.connected) continue;
        mcpToolNames.push(...status.tools);
      }
    }
    // Worker-run stdio MCP tools (registered as daemon-side proxies).
    const stdioMcp = this.stdioMcp.get(def.id);
    if (stdioMcp) mcpToolNames.push(...stdioMcp.toolNames);

    // Compute skills index for system prompt injection
    let skillsIndex: string | undefined;
    if (def.skills && def.skills.length > 0) {
      // Filter to agent-specified skills only
      const filtered = this.skillRegistry
        .getIndex()
        .filter((s: SkillIndexEntry) => def.skills.includes(s.name));
      if (filtered.length > 0) {
        skillsIndex = filtered
          .map(
            (e: SkillIndexEntry) =>
              `- **${e.name}**: ${e.description}${e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : ""}`
          )
          .join("\n");
      }
    } else if (this.skillRegistry.size > 0) {
      // No filter specified — include all skills
      skillsIndex = this.skillRegistry.getIndexAsString();
    }

    const b = this.config.behavior;
    // Per-agent workspace dir — default cwd for filesystem/shell tools.
    // Idempotent recursive mkdir migrates pre-existing agents on first load.
    const workspaceDir = path.join(this.agentsDir, def.id, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    // Resolve the agent's effective model against the root config
    // before building. Per-agent `model` overrides; absent → root.
    const effectiveModel = this.resolveModel(def);
    // First-run / unconfigured workforce: schema no longer defaults
    // provider+model to a stale anthropic/sonnet string. Fail fast with a
    // user-actionable message instead of letting the AI SDK throw a cryptic
    // "model is required" deep in the stream path.
    if (!effectiveModel.provider || !effectiveModel.model) {
      throw new Error(
        "No model configured. Add an API key or sign in via OAuth in Settings."
      );
    }
    // Look up the agent's model in the bundled registry once at
    // AgentConfig build time. The runtime compressor only sees the
    // resolved contextWindow — it never has to know about the snapshot.
    const metadata = lookupModelMetadata(effectiveModel);
    // User-supplied files under `<agentDir>/resources/`. Walked once at
    // AgentConfig build time; the cached system prompt mirrors that
    // snapshot. Mutations via the HTTP route call `evictAgent` so the
    // next chat rebuilds with fresh listings.
    const resources = this.agentStore
      .listResources(def.id)
      .map((r) => ({ relPath: r.relPath, size: r.size, absPath: r.path }));

    // Non-archived teams this agent belongs to — drives the prompt's
    // `## Teams` section. Snapshot at build time; team mutations evict
    // member agents so the next chat rebuilds.
    const teams = this.teamStore.teamsFor(def.id).map((t) => ({
      id: t.id,
      name: t.name,
      members: t.members,
      charter: t.charter,
      workspaceDir: this.teamStore.workspaceDir(t.id)!,
    }));

    // Compiled filesystem policy — one object drives both the sandbox
    // profile (tool host, later phases) and the prompt's `## Access`
    // section, so the agent's stated rules and the kernel's can't drift.
    const policy = compilePolicy({
      agentId: def.id,
      agentDefs: this.agentStore.list(),
      teams: this.teamStore.list(),
      dataDir: this.config.dataDir,
    });

    const agentConfig: AgentConfig = {
      id: def.id,
      name: def.name,
      model: effectiveModel,
      persona: def.persona,
      // Effective tool set: user-configurable env tools + agent's MCP
      // tools + always-on system tools (skill_view, memory, session_search,
      // task_*). Dedup defensively in case a legacy AGENT.md still lists
      // a system tool explicitly.
      tools: Array.from(
        new Set([...def.tools, ...mcpToolNames, ...SYSTEM_TOOLS])
      ),
      maxSteps: b.maxSteps,
      maxOutputTokens: b.maxOutputTokens,
      skillsIndex,
      compression: {
        thresholdTokens: b.compressionThresholdTokens,
        thresholdPercent: b.compressionThresholdPercent,
        contextWindow: metadata.contextWindow ?? null,
        protectFirstN: b.compressionProtectFirstN,
        tailTokenBudget: b.compressionTailTokenBudget,
        summaryTargetRatio: b.compressionSummaryTargetRatio,
        summarizerInputCharBudget: b.compressionSummarizerInputCharBudget,
        summarizerModel: b.compressionSummarizerModel,
      },
      agentsMd: this.agentsMd,
      teams,
      workspaceDir,
      accessSection:
        describePolicy(policy) +
        (this.toolHostManager.degradeReason
          ? `\n\n> NOTE: OS-level enforcement is currently unavailable on this machine (${this.toolHostManager.degradeReason}). The rules above still apply — follow them.`
          : ""),
      resources,
    };

    return new Agent(agentConfig, {
      sessionStore: this.sessionStore,
      messageStore: this.messageStore,
      toolRegistry,
      attachmentsRoot: this.attachmentsRoot,
      memoryStore: this.memoryStore,
      taskStore: this.taskStore,
      inboxStore: this.inboxStore,
      broadcaster: this.broadcaster,
    });
  }

  // ── MCP OAuth wiring ─────────────────────────────────────────────────────
  //
  // `MCPClient` is provider-agnostic — it doesn't import `@openacme/auth`.
  // The pieces below are AgentManager's OS-side glue: a file-backed token
  // store under `<dataDir>/mcp-tokens/`, a loopback URL for the OAuth
  // callback, and a callback that runs the browser flow via the existing
  // `@openacme/auth` primitives.

  private _mcpTokenStore?: MCPTokenStore;
  private _mcpLoopbackPort = 17331;

  private mcpTokenStore(): MCPTokenStore {
    if (!this._mcpTokenStore) {
      this._mcpTokenStore = new FileMCPTokenStore(
        path.join(this.config.dataDir, "mcp-tokens")
      );
    }
    return this._mcpTokenStore;
  }

  private mcpOAuthRedirectUrl(): string {
    return `http://127.0.0.1:${this._mcpLoopbackPort}/auth/callback`;
  }

  /**
   * Drive the OAuth flow when `MCPClient` hits an `UnauthorizedError`.
   * Prints the URL (so it's never lost on a failed browser open),
   * launches the system browser when not headless, and waits for the
   * loopback callback to resolve with the auth code.
   */
  private mcpOAuthCallback: OAuthCallback = async ({
    serverName,
    authorizationUrl,
    redirectUrl,
  }) => {
    // The MCP SDK omits `state` from the authorization request — OAuth 2.1
    // PKCE alone covers CSRF, and `state` is optional. Pass `expectedState:
    // ""` so the loopback skips state validation and accepts a callback
    // with just `?code=...`. (If a server DOES echo back state we'll
    // accept whatever it sends; PKCE is what binds it to our session.)
    const sdkState = authorizationUrl.searchParams.get("state") ?? "";

    const url = authorizationUrl.toString();
    // Open the system browser when we can. Headless callers (SSH, CI) are
    // expected to drive auth from a separate channel — this code path is
    // synchronous-await on the loopback, so a non-TTY caller has already
    // chosen to wait. We don't print to stdout because the CLI may be
    // running an Ink TUI; the URL is also returned to API callers via the
    // `awaiting_oauth` state on `getStatus()`.
    if (!looksHeadless()) openBrowser(url);

    try {
      const { code } = await awaitLoopbackCallback({
        port: this._mcpLoopbackPort,
        expectedState: sdkState,
        callbackPath: "/auth/callback",
        timeoutMs: 5 * 60_000,
      });
      void redirectUrl;
      return { code };
    } catch {
      return { cancelled: true };
    }
  };

  /**
   * Close all connections.
   */
  async close(): Promise<void> {
    // Order matters: stop the scheduler so no new turns start, then
    // wait for any in-flight turn chains to drain before closing the
    // DB. Without the drain, an autonomous turn still mid-write hits a
    // closed sqlite handle ("The database connection is not open") at
    // exit. Particularly visible in CLI chat where the scheduler runs
    // in-process and a turn may have been kicked just before exit.
    this.dispatcher.stop();
    await this.dispatcher.drain();
    for (const [_, mcpClient] of this.mcpClients) {
      await mcpClient.disconnect();
    }
    closeAllShellSessions();
    await this.toolHostManager.close();
    await this.browserManager.close();
    this.db.close();
  }
}

function hasOwn<T extends object>(obj: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Error thrown when a caller attempts to mutate a platform-managed agent. */
export function managedAgentError(id: string, action: "edited" | "deleted"): Error {
  return new Error(
    `Agent '${id}' is platform-managed and cannot be ${action}. ` +
      `Set managed: false in AGENT.md if you want to take ownership.`
  );
}

/**
 * Structured "what landed where" record returned by `importAgentFromTemplate`.
 * Two-bucket shape: contents of the agent folder vs. workforce-wide installs.
 */
export interface ImportManifest {
  agent: {
    id: string;
    resourceFiles: Array<{ relPath: string; size: number }>;
  };
  workforce: {
    skills: Array<
      | { name: string; action: "installed" | "kept" }
      | { name: string; action: "failed"; error: string }
    >;
    mcpServers: Array<{ name: string; action: "added" | "kept" }>;
  };
}
