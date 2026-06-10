import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from 'zod';
import type { MCPServerConfig, MCPTransport } from "@openacme/config";
import type { ToolRegistry } from "@openacme/tools";
import { buildSafeEnv, sanitizeError, scanDescription } from "./security.js";
import type { MCPTokenStore } from "./token-store.js";

// Timeout defaults in seconds (matching config schema units)
const DEFAULT_TOOL_TIMEOUT_SECONDS = 120;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 60;
const MAX_RECONNECT_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

// MCPClient is silent — no console.log / console.warn anywhere. State that
// matters lives in `getStatus()` (state, lastError, attemptCount) so callers
// can surface it however they want; spamming stdout is the wrong layer.

export type ServerState =
  | "disabled"
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed"
  | "awaiting_oauth";

export type ResolvedTransport = "http" | "sse" | "stdio";

type AnyTransport =
  | StdioClientTransport
  | SSEClientTransport
  | StreamableHTTPClientTransport;

interface ServerRecord {
  config: MCPServerConfig;
  state: ServerState;
  client?: Client;
  transport?: AnyTransport;
  toolNames: string[];
  /** Raw (JSON Schema) tool definitions from the last discovery — kept
   *  so out-of-process consumers (tool-host worker → daemon) can rebuild
   *  registry entries without re-querying the server. */
  toolSchemas?: McpToolSchema[];
  lastError?: string;
  attemptCount: number;
  resolvedTransport?: ResolvedTransport;
}

export interface McpToolSchema {
  /** Bare MCP tool name (no `mcp_<server>__` prefix). */
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface ServerStatus {
  name: string;
  state: ServerState;
  connected: boolean;
  toolCount: number;
  tools: string[];
  lastError?: string;
  attemptCount: number;
  transport?: ResolvedTransport;
}

export interface ConnectResult {
  ok: boolean;
  state: ServerState;
  error?: string;
  tools: string[];
  authRequired?: boolean;
}

/**
 * Caller-supplied OAuth callback. The callback owns the browser flow:
 *   1. Open the `authorizationUrl` in a browser
 *   2. Receive the code on a loopback server (or device-code, or pasted)
 *   3. Resolve with `{ code }` — `MCPClient` then calls
 *      `transport.finishAuth(code)` and reconnects
 *
 * `mcp-client` deliberately does not import `@openacme/auth` — keeping
 * the package provider-agnostic. The caller (AgentManager) wires this
 * to the loopback + PKCE primitives in `@openacme/auth`.
 *
 * The `redirectUrl` is what the loopback expects — pass it back so the
 * SDK's DCR registers the right redirect_uri for this client.
 */
export type OAuthCallback = (ctx: {
  serverName: string;
  authorizationUrl: URL;
  redirectUrl: string;
  transport: StreamableHTTPClientTransport;
}) => Promise<{ code: string } | { cancelled: true }>;

export interface MCPClientOptions {
  onUnauthorized?: OAuthCallback;
  /** Per-server token store. Required for OAuth-protected servers. */
  tokenStore?: MCPTokenStore;
  /** Where the loopback HTTP server listens for the OAuth code. */
  oauthRedirectUrl?: string;
  /** Client name advertised during DCR. Defaults to "OpenAcme". */
  oauthClientName?: string;
}

/**
 * MCPClient — connects to external MCP servers, discovers their tools,
 * and registers them into the agent's tool registry.
 *
 * Public API:
 *   - `connect(servers)` / `disconnect()` — boot/shutdown batch ops.
 *   - `connectServer(name, config?)` / `disconnectServer(name)` — single server.
 *   - `reconnect(name)` — disconnect + reconnect with stored config.
 *   - `testConnection(config)` — dry run; never touches internal state.
 *   - `getStatus()` — every known server, including failed/disabled.
 *
 * State machine — one record per server, retained across connect cycles
 * so the UI can show "this server is failed, here's why":
 *
 *   register → disconnected → connecting → connected
 *                           ↘ failed
 *                           ↘ awaiting_oauth → connected
 *
 *   disabled is set when `config.enabled === false`; never connects.
 */
export class MCPClient {
  private registry: ToolRegistry;
  private servers = new Map<string, ServerRecord>();
  private onUnauthorized?: OAuthCallback;
  private tokenStore?: MCPTokenStore;
  private oauthRedirectUrl?: string;
  private oauthClientName: string;

  constructor(registry: ToolRegistry, opts: MCPClientOptions = {}) {
    this.registry = registry;
    this.onUnauthorized = opts.onUnauthorized;
    this.tokenStore = opts.tokenStore;
    this.oauthRedirectUrl = opts.oauthRedirectUrl;
    this.oauthClientName = opts.oauthClientName ?? "OpenAcme";
  }

  // ── Batch boot/shutdown ──────────────────────────────────────────────────

  /**
   * Connect to all configured MCP servers and register their tools.
   * Per-server retry with backoff; one server's failure doesn't block others.
   *
   * Boot path: defaults to `skipOAuth: true` so an OAuth-required server
   * doesn't block the boot for ~5 minutes waiting on a browser login.
   * The server lands in `awaiting_oauth`; the UI/CLI prompts the user to
   * explicitly authorize, which calls `connectServer` with skipOAuth false.
   */
  async connect(
    servers: Record<string, MCPServerConfig>,
    opts: { skipOAuth?: boolean } = { skipOAuth: true }
  ): Promise<{ connected: string[]; failed: string[] }> {
    // Connect every server in parallel. Each `connectServer` writes its
    // own slot in `this.servers`; there's no shared mutable state. For a
    // mix of stdio (slow npx fetch) + HTTP (fast handshake), the wall
    // time becomes max(...) instead of sum(...).
    const results = await Promise.all(
      Object.entries(servers).map(async ([name, config]) => {
        const result = await this.connectServer(name, config, opts);
        return { name, result };
      })
    );

    const connected: string[] = [];
    const failed: string[] = [];
    for (const { name, result } of results) {
      if (result.ok) connected.push(name);
      else if (result.state !== "disabled") failed.push(name);
    }
    return { connected, failed };
  }

  /**
   * Disconnect ALL servers and deregister their tools.
   * Used at process shutdown — clears all records.
   *
   * For per-server disconnect (retain record so UI can show state), use
   * `disconnectServer(name)`.
   */
  async disconnect(): Promise<void> {
    for (const [, rec] of this.servers) {
      await this.tearDown(rec);
    }
    this.servers.clear();
  }

  // ── Per-server lifecycle ─────────────────────────────────────────────────

  /**
   * Connect (or reconnect) a single server. Retries 3x with 1s/2s/4s backoff.
   * Stores the config so subsequent `reconnect(name)` calls work without it.
   *
   * If the server is already connected, returns the current state without
   * reconnecting — call `reconnect(name)` to force a fresh connection.
   *
   * `opts.skipOAuth: true` (the default for boot) means: when the server
   * needs OAuth, mark it `awaiting_oauth` and return without driving the
   * browser flow. Callers wanting the full flow (e.g. an explicit
   * "Authenticate" button) pass `skipOAuth: false`.
   */
  async connectServer(
    name: string,
    config?: MCPServerConfig,
    opts: { skipOAuth?: boolean } = {}
  ): Promise<ConnectResult> {
    const existing = this.servers.get(name);
    const cfg = config ?? existing?.config;
    if (!cfg) {
      return {
        ok: false,
        state: "failed",
        error: `MCP server '${name}': no config provided and none stored`,
        tools: [],
      };
    }

    // Idempotency: if already connected with this exact config, do nothing.
    if (existing?.state === "connected" && !config) {
      return {
        ok: true,
        state: "connected",
        tools: existing.toolNames,
      };
    }

    // Tear down any prior connection cleanly before reconnecting so we don't
    // leak a stdio child or leave stale tool handlers wired to a dead client.
    if (existing && (existing.state === "connected" || existing.state === "connecting")) {
      await this.tearDown(existing);
    }

    const rec: ServerRecord = existing ?? {
      config: cfg,
      state: "disconnected",
      toolNames: [],
      attemptCount: 0,
    };
    rec.config = cfg;
    rec.toolNames = [];
    rec.client = undefined;
    rec.transport = undefined;
    rec.lastError = undefined;

    if (cfg.enabled === false) {
      rec.state = "disabled";
      this.servers.set(name, rec);
      return { ok: false, state: "disabled", tools: [] };
    }

    rec.state = "connecting";
    this.servers.set(name, rec);

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RECONNECT_RETRIES; attempt++) {
      rec.attemptCount = attempt;
      try {
        const { client, transport, resolvedTransport, toolNames } =
          await this.openServer(name, cfg);
        rec.client = client;
        rec.transport = transport;
        rec.resolvedTransport = resolvedTransport;
        rec.toolNames = toolNames;
        rec.state = "connected";
        rec.attemptCount = 0;
        rec.lastError = undefined;
        return {
          ok: true,
          state: "connected",
          tools: toolNames,
        };
      } catch (error) {
        // OAuth-required: try the caller-supplied browser flow. If it
        // completes, retry the connect once. If the caller didn't wire
        // up onUnauthorized, or if `skipOAuth` is set, surface the state
        // and bail — no point retrying without user action.
        if (error instanceof UnauthorizedError) {
          if (opts.skipOAuth) {
            rec.state = "awaiting_oauth";
            rec.lastError = "OAuth authorization required";
            return {
              ok: false,
              state: "awaiting_oauth",
              error: rec.lastError,
              tools: [],
              authRequired: true,
            };
          }
          const handled = await this.tryOAuth(name, cfg, rec);
          if (handled.ok) {
            rec.client = handled.client;
            rec.transport = handled.transport;
            rec.resolvedTransport = handled.resolvedTransport;
            rec.toolNames = handled.toolNames;
            rec.state = "connected";
            rec.attemptCount = 0;
            rec.lastError = undefined;
            return {
              ok: true,
              state: "connected",
              tools: handled.toolNames,
            };
          }
          rec.state = handled.state;
          rec.lastError = handled.error;
          return {
            ok: false,
            state: handled.state,
            error: handled.error,
            tools: [],
            authRequired: handled.state === "awaiting_oauth",
          };
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < MAX_RECONNECT_RETRIES) {
          const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    rec.state = "failed";
    rec.lastError = sanitizeError(lastError?.message ?? "unknown error");
    return {
      ok: false,
      state: "failed",
      error: rec.lastError,
      tools: [],
    };
  }

  /**
   * Disconnect a single server. Deregisters its tools and closes the
   * transport, but **retains the record** so `getStatus()` can show
   * "disconnected" and `reconnect(name)` can use the stored config.
   */
  async disconnectServer(name: string): Promise<void> {
    const rec = this.servers.get(name);
    if (!rec) return;
    await this.tearDown(rec);
    rec.state = "disconnected";
    rec.toolNames = [];
    rec.client = undefined;
    rec.transport = undefined;
    rec.attemptCount = 0;
    rec.lastError = undefined;
  }

  /**
   * Disconnect + reconnect a single server with its stored config.
   * Use after a config edit, or to recover from a transient network blip.
   */
  async reconnect(name: string): Promise<ConnectResult> {
    const rec = this.servers.get(name);
    if (!rec) {
      return {
        ok: false,
        state: "failed",
        error: `MCP server '${name}' is not registered`,
        tools: [],
      };
    }
    await this.disconnectServer(name);
    return this.connectServer(name, rec.config);
  }

  /**
   * Remove a server entirely — disconnects, deregisters its tools, and
   * deletes the record. The server is no longer visible via `getStatus()`.
   */
  async unregisterServer(name: string): Promise<void> {
    const rec = this.servers.get(name);
    if (!rec) return;
    await this.tearDown(rec);
    this.servers.delete(name);
  }

  /**
   * Dry-run a config without registering any tools. Used by the
   * "Test connection" UI button.
   *
   * Builds a transport + Client, connects, lists tools, closes.
   * NEVER touches `this.servers` or `this.registry`.
   */
  async testConnection(
    config: MCPServerConfig
  ): Promise<{ ok: boolean; error?: string; tools: string[]; transport?: ResolvedTransport }> {
    let client: Client | undefined;
    let transport: AnyTransport | undefined;
    try {
      const opened = await this.openTransport("__test__", config);
      client = opened.client;
      transport = opened.transport;
      const response = await client.listTools();
      const toolNames = response.tools.map((t) => t.name);
      return { ok: true, tools: toolNames, transport: opened.resolvedTransport };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: sanitizeError(msg), tools: [] };
    } finally {
      // Always close — a flaky server that throws between connect and close
      // would otherwise leak a stdio child or open HTTP session.
      try {
        await client?.close();
      } catch {
        // best-effort
      }
      void transport; // satisfies tsc; transport closed via client.close()
    }
  }

  // ── Status ───────────────────────────────────────────────────────────────

  /**
   * Snapshot of every known server, including disabled/failed/disconnected.
   * Callers that want only the connected ones should `.filter(s => s.connected)`.
   */
  getStatus(): ServerStatus[] {
    return [...this.servers.entries()].map(([name, rec]) => ({
      name,
      state: rec.state,
      connected: rec.state === "connected",
      toolCount: rec.toolNames.length,
      tools: rec.toolNames,
      lastError: rec.lastError,
      attemptCount: rec.attemptCount,
      transport: rec.resolvedTransport,
    }));
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Drive the OAuth flow when a connect threw `UnauthorizedError`.
   *
   * Sequence:
   *   1. Build a fresh transport with the auth provider attached
   *   2. Initiate auth — this records the authorization URL via
   *      `redirectToAuthorization`, then throws `UnauthorizedError`
   *   3. Hand the URL to the caller's `onUnauthorized` callback —
   *      it opens the browser, runs a loopback, returns `{ code }`
   *   4. `transport.finishAuth(code)` exchanges code → tokens
   *   5. Reconnect with the same transport (now token-bearing) and
   *      discover tools
   */
  private async tryOAuth(
    name: string,
    config: MCPServerConfig,
    rec: ServerRecord
  ): Promise<
    | {
        ok: true;
        client: Client;
        transport: AnyTransport;
        resolvedTransport: ResolvedTransport;
        toolNames: string[];
      }
    | { ok: false; state: ServerState; error: string }
  > {
    if (!this.onUnauthorized || !this.tokenStore || !this.oauthRedirectUrl) {
      return {
        ok: false,
        state: "awaiting_oauth",
        error:
          "OAuth required but no onUnauthorized callback / tokenStore is configured",
      };
    }
    if (!config.url) {
      return {
        ok: false,
        state: "failed",
        error: "OAuth path requires a URL-based server",
      };
    }
    rec.state = "awaiting_oauth";

    // Build a transport with our auth provider so `finishAuth` works
    // against the same provider state.
    const url = new URL(config.url);
    const headers = config.headers;
    const authProvider = this.buildAuthProvider(name)!;
    const explicit = config.transport;
    const useHttp = explicit !== "sse";
    const transport: AnyTransport = useHttp
      ? new StreamableHTTPClientTransport(url, {
          requestInit: { headers },
          authProvider,
        })
      : new SSEClientTransport(url, {
          requestInit: { headers },
          authProvider,
        });
    const client = newClient(name);
    const connectTimeoutSeconds =
      config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;

    // Connect — expected to throw UnauthorizedError after stashing the URL.
    let authorizationUrl: URL | undefined;
    try {
      await connectWithTimeout(client, transport, connectTimeoutSeconds);
      // Server didn't actually need auth this time — odd but fine.
      const toolNames = await this.discoverTools(
        name,
        client,
        config,
        config.timeout ?? DEFAULT_TOOL_TIMEOUT_SECONDS
      );
      return {
        ok: true,
        client,
        transport,
        resolvedTransport: useHttp ? "http" : "sse",
        toolNames,
      };
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          state: "failed",
          error: sanitizeError(
            err instanceof Error ? err.message : String(err)
          ),
        };
      }
      authorizationUrl = (
        authProvider as unknown as MCPOAuthProvider
      ).capturedUrl;
    }

    if (!authorizationUrl) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        state: "failed",
        error: "OAuth provider did not surface an authorization URL",
      };
    }

    // Hand off to the caller — they own the browser + loopback.
    let result: { code: string } | { cancelled: true };
    try {
      result = await this.onUnauthorized({
        serverName: name,
        authorizationUrl,
        redirectUrl: this.oauthRedirectUrl,
        transport: transport as StreamableHTTPClientTransport,
      });
    } catch (err) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        state: "failed",
        error: sanitizeError(
          err instanceof Error ? err.message : String(err)
        ),
      };
    }

    if ("cancelled" in result) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        state: "failed",
        error: "OAuth cancelled by user",
      };
    }

    // Exchange code → tokens. The transport's `finishAuth(code)` runs
    // the token endpoint round-trip and persists tokens via the auth
    // provider. The transport instance can't be reused for the live
    // connection though — its internal state machine has already gone
    // through a failed start(). Build a fresh transport + client that
    // shares the auth provider so the second connect picks up the saved
    // tokens automatically.
    try {
      await (transport as StreamableHTTPClientTransport).finishAuth(result.code);
      // Discard the now-poisoned transport.
      try {
        await client.close();
      } catch {
        /* ignore */
      }

      const freshTransport: AnyTransport = useHttp
        ? new StreamableHTTPClientTransport(url, {
            requestInit: { headers },
            authProvider,
          })
        : new SSEClientTransport(url, {
            requestInit: { headers },
            authProvider,
          });
      const freshClient = newClient(name);
      await connectWithTimeout(
        freshClient,
        freshTransport,
        connectTimeoutSeconds
      );
      const toolNames = await this.discoverTools(
        name,
        freshClient,
        config,
        config.timeout ?? DEFAULT_TOOL_TIMEOUT_SECONDS
      );
      return {
        ok: true,
        client: freshClient,
        transport: freshTransport,
        resolvedTransport: useHttp ? "http" : "sse",
        toolNames,
      };
    } catch (err) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        state: "failed",
        error: sanitizeError(
          err instanceof Error ? err.message : String(err)
        ),
      };
    }
  }

  /**
   * Open a transport + Client and discover tools. Used by both
   * `connectServer` (which then stores the result) and as a sub-step.
   */
  private async openServer(
    name: string,
    config: MCPServerConfig
  ): Promise<{
    client: Client;
    transport: AnyTransport;
    resolvedTransport: ResolvedTransport;
    toolNames: string[];
  }> {
    const opened = await this.openTransport(name, config);
    const toolTimeoutSeconds = config.timeout ?? DEFAULT_TOOL_TIMEOUT_SECONDS;
    const toolNames = await this.discoverTools(
      name,
      opened.client,
      config,
      toolTimeoutSeconds
    );
    return { ...opened, toolNames };
  }

  /**
   * Build transport + Client, connect with timeout. Handles auto-detect
   * fallback from Streamable HTTP to SSE when the server doesn't speak
   * the new transport.
   */
  private async openTransport(
    name: string,
    config: MCPServerConfig
  ): Promise<{
    client: Client;
    transport: AnyTransport;
    resolvedTransport: ResolvedTransport;
  }> {
    const connectTimeoutSeconds =
      config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
    const kind = pickTransportKind(config);

    if (kind === "stdio") {
      if (!config.command) {
        throw new Error(
          `MCP server '${name}': stdio transport requires 'command'`
        );
      }
      const env = buildSafeEnv(config.env);
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env,
        cwd: config.cwd,
        // MCP servers' own readiness / diagnostic lines on stderr
        // ("Secure MCP Filesystem Server running on stdio", etc.) leak
        // into our terminal if we let them inherit. Discard them — we
        // surface meaningful errors via getStatus().lastError instead.
        stderr: "ignore",
      });
      const client = newClient(name);
      await connectWithTimeout(client, transport, connectTimeoutSeconds);
      return { client, transport, resolvedTransport: "stdio" };
    }

    if (!config.url) {
      throw new Error(
        `MCP server '${name}': URL transport requires 'url'`
      );
    }
    const url = new URL(config.url);
    const headers = config.headers;
    const authProvider = this.buildAuthProvider(name);

    // Explicit override — no auto-detect.
    if (config.transport === "sse") {
      const transport = new SSEClientTransport(url, {
        requestInit: { headers },
        ...(authProvider && { authProvider }),
      });
      const client = newClient(name);
      await connectWithTimeout(client, transport, connectTimeoutSeconds);
      return { client, transport, resolvedTransport: "sse" };
    }
    if (config.transport === "http") {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
        ...(authProvider && { authProvider }),
      });
      const client = newClient(name);
      await connectWithTimeout(client, transport, connectTimeoutSeconds);
      return { client, transport, resolvedTransport: "http" };
    }

    // Auto-detect: try Streamable HTTP first (the new standard), fall back
    // to SSE on a 4xx that signals "this server speaks SSE only".
    try {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
        ...(authProvider && { authProvider }),
      });
      const client = newClient(name);
      await connectWithTimeout(client, transport, connectTimeoutSeconds);
      return { client, transport, resolvedTransport: "http" };
    } catch (err) {
      // OAuth-needed errors are NOT a transport-protocol mismatch — re-throw.
      if (err instanceof UnauthorizedError) throw err;
      if (!isStreamableHttpUnsupported(err)) throw err;
      const transport = new SSEClientTransport(url, {
        requestInit: { headers },
        ...(authProvider && { authProvider }),
      });
      const client = newClient(name);
      await connectWithTimeout(client, transport, connectTimeoutSeconds);
      return { client, transport, resolvedTransport: "sse" };
    }
  }

  /**
   * Build a per-server `OAuthClientProvider` if the caller wired in a
   * token store. No store → no OAuth → connection fails with
   * `UnauthorizedError` for protected servers, which is the correct
   * "not configured" signal.
   */
  private buildAuthProvider(name: string): OAuthClientProvider | undefined {
    if (!this.tokenStore || !this.oauthRedirectUrl) return undefined;
    return new MCPOAuthProvider({
      serverName: name,
      tokenStore: this.tokenStore,
      redirectUrl: this.oauthRedirectUrl,
      clientName: this.oauthClientName,
    });
  }

  /**
   * Tear down a server's runtime: deregister tools, close client. Does
   * NOT clear the record — callers decide whether to retain or delete.
   */
  private async tearDown(rec: ServerRecord): Promise<void> {
    for (const toolName of rec.toolNames) {
      this.registry.deregister(toolName);
    }
    try {
      await rec.client?.close();
    } catch {
      // best-effort; transports own their own subprocess/socket lifecycle
    }
  }

  /**
   * Discover tools from a connected server and register them into the
   * tool registry, honoring `allowedTools` if set.
   */
  private async discoverTools(
    serverName: string,
    client: Client,
    config: MCPServerConfig,
    toolTimeoutSeconds: number
  ): Promise<string[]> {
    const response = await client.listTools();
    const allow = config.allowedTools && config.allowedTools.length > 0
      ? new Set(config.allowedTools)
      : null;
    const toolNames: string[] = [];
    const toolSchemas: McpToolSchema[] = [];

    for (const tool of response.tools) {
      if (allow && !allow.has(tool.name)) continue;
      toolSchemas.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });

      const registryName = `mcp_${serverName}__${tool.name}`;
      const toolset = `mcp-${serverName}`;

      scanDescription(serverName, tool.name, tool.description ?? "");

      const parameters = this.jsonSchemaToZod(tool.inputSchema).describe(
        tool.description ?? `MCP tool: ${tool.name}`
      );

      this.registry.register({
        name: registryName,
        toolset,
        description: tool.description ?? `Tool from MCP server '${serverName}'`,
        parameters,
        emoji: "🔌",
        parallelSafe: true,
        handler: async (args: Record<string, unknown>) => {
          return this.callTool(serverName, tool.name, args, toolTimeoutSeconds);
        },
      });

      toolNames.push(registryName);
    }

    const rec = this.servers.get(serverName);
    if (rec) rec.toolSchemas = toolSchemas;

    return toolNames;
  }

  /** Raw tool schemas from the last discovery for one server. Empty
   *  until the server has connected at least once. */
  getToolSchemas(serverName: string): McpToolSchema[] {
    return this.servers.get(serverName)?.toolSchemas ?? [];
  }

  /**
   * Call a tool on an MCP server. Looks up the live client by name so
   * a tool handler that survives across reconnects keeps working as long
   * as the server is connected.
   */
  private async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutSeconds: number
  ): Promise<string> {
    const rec = this.servers.get(serverName);
    if (!rec || rec.state !== "connected" || !rec.client) {
      return JSON.stringify({
        error: `MCP server '${serverName}' is not connected`,
      });
    }

    try {
      const callPromise = rec.client.callTool({
        name: toolName,
        arguments: args,
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Tool call timeout after ${timeoutSeconds}s`)),
          timeoutSeconds * 1000
        )
      );

      const result = await Promise.race([callPromise, timeoutPromise]);

      if (result.content && Array.isArray(result.content)) {
        const texts = result.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text);
        return texts.join("\n") || JSON.stringify(result);
      }

      return JSON.stringify(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: sanitizeError(msg) });
    }
  }

  // ── JSON Schema → Zod ────────────────────────────────────────────────────

  private jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
    return jsonSchemaToZod(schema);
  }
}

/**
 * Convert an MCP tool's JSON Schema into a Zod schema for the registry.
 * Exported so the daemon can rebuild parameters for tools whose schemas
 * were discovered inside a tool-host worker (raw JSON crosses the RPC
 * boundary; Zod functions can't).
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") {
    return z.record(z.string(), z.unknown());
  }

  const s = schema as Record<string, unknown>;

  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, Record<string, unknown>>;
    const required = new Set(Array.isArray(s.required) ? s.required : []);

    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, propSchema] of Object.entries(props)) {
      let propZod = jsonSchemaPrimitiveToZod(propSchema);
      if (propSchema.description && typeof propSchema.description === "string") {
        propZod = propZod.describe(propSchema.description);
      }
      if (!required.has(key)) {
        propZod = propZod.optional();
      }
      shape[key] = propZod;
    }
    return z.object(shape);
  }

  return z.record(z.string(), z.unknown());
}

function jsonSchemaPrimitiveToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  switch (schema.type) {
    case "string":
      if (Array.isArray(schema.enum)) {
        return z.enum(schema.enum as [string, ...string[]]);
      }
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      if (schema.items && typeof schema.items === "object") {
        return z.array(
          jsonSchemaPrimitiveToZod(schema.items as Record<string, unknown>)
        );
      }
      return z.array(z.unknown());
    case "object":
      return jsonSchemaToZod(schema);
    default:
      return z.unknown();
  }
}

// ── Module-private helpers ─────────────────────────────────────────────────

function newClient(serverName: string): Client {
  return new Client(
    { name: `openacme-${serverName}`, version: "0.0.1" },
    { capabilities: {} }
  );
}

async function connectWithTimeout(
  client: Client,
  transport: AnyTransport,
  seconds: number
): Promise<void> {
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Connection timeout after ${seconds}s`)),
      seconds * 1000
    )
  );
  await Promise.race([connectPromise, timeoutPromise]);
}

function pickTransportKind(config: MCPServerConfig): MCPTransport {
  if (config.command) return "stdio";
  if (!config.url) {
    throw new Error("MCP server config must specify either 'command' or 'url'");
  }
  // Explicit override wins.
  if (config.transport) return config.transport;
  // Auto-detect default — Streamable HTTP first, fall back to SSE on
  // canonical "I only speak SSE" responses (404/405 from POST /mcp).
  return "http";
}

/**
 * Detect whether a Streamable HTTP connect failure is the canonical
 * "this server doesn't speak Streamable HTTP" signal — 404 or 405 from
 * the POST endpoint. Anything else (5xx, network, OAuth) is a real
 * failure that we don't paper over with a transport fallback.
 *
 * Duck-typed: the SDK's `StreamableHTTPError` exposes `.code`, but the
 * exported class name has churned across SDK versions. Match the shape.
 */
function isStreamableHttpUnsupported(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === 404 || e.code === 405) return true;
  // Some SDK versions stringify the status into the message instead.
  const msg = typeof e.message === "string" ? e.message : "";
  return /\b(404|405)\b/.test(msg) && /(method not allowed|not found)/i.test(msg);
}

/**
 * `OAuthClientProvider` implementation backed by an `MCPTokenStore`.
 *
 * State is partitioned per server name. The `redirectToAuthorization`
 * hook captures the URL for the caller; the SDK still throws
 * `UnauthorizedError`, which is what triggers our OAuth flow.
 *
 * The provider is constructed fresh per `connect` attempt — but the
 * tokens, DCR client info, and PKCE verifier all live in the token
 * store, so they survive across attempts (and process restarts).
 */
class MCPOAuthProvider implements OAuthClientProvider {
  capturedUrl?: URL;
  private serverName: string;
  private tokenStore: MCPTokenStore;
  private redirectUrlValue: string;
  private clientName: string;

  constructor(opts: {
    serverName: string;
    tokenStore: MCPTokenStore;
    redirectUrl: string;
    clientName: string;
  }) {
    this.serverName = opts.serverName;
    this.tokenStore = opts.tokenStore;
    this.redirectUrlValue = opts.redirectUrl;
    this.clientName = opts.clientName;
  }

  get redirectUrl(): string {
    return this.redirectUrlValue;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirectUrlValue],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client; no shared secret. PKCE is the security mechanism.
      token_endpoint_auth_method: "none",
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return this.tokenStore.getClientInfo(this.serverName);
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.tokenStore.saveClientInfo(this.serverName, info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.tokenStore.getTokens(this.serverName);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.tokenStore.saveTokens(this.serverName, tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.capturedUrl = authorizationUrl;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.tokenStore.saveCodeVerifier(this.serverName, verifier);
  }

  async codeVerifier(): Promise<string> {
    const v = await this.tokenStore.getCodeVerifier(this.serverName);
    if (!v) {
      throw new Error(
        `No PKCE verifier stored for MCP server '${this.serverName}'`
      );
    }
    return v;
  }
}
