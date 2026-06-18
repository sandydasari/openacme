import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plug, RefreshCw, Power, PowerOff, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { API_BASE } from "@/app/lib/api";
import { cn } from "@/app/lib/utils";
import { Button } from "@/app/components/ui/button";

// The MCP server config shape — a Claude-Desktop-compatible superset.
// Validated server-side against MCPServerConfigSchema on save.
export interface MCPServerConfigDto {
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeout?: number;
  connectTimeout?: number;
  allowedTools?: string[];
  enabled?: boolean;
  transport?: "http" | "sse" | "stdio";
}

interface ServerStatus {
  name: string;
  state:
    | "connected"
    | "connecting"
    | "disconnected"
    | "failed"
    | "disabled"
    | "awaiting_oauth";
  connected: boolean;
  toolCount: number;
  tools: string[];
  lastError?: string;
  transport?: "http" | "sse" | "stdio";
}

export type McpScope = "global" | { agentId: string };

function pillClass(state: ServerStatus["state"]): string {
  switch (state) {
    case "connected":
      return "bg-paper text-ink border border-signal-green";
    case "awaiting_oauth":
      return "bg-paper text-warn-ochre border border-warn-ochre";
    case "failed":
      return "bg-paper text-destructive border border-destructive";
    case "connecting":
      return "bg-paper text-signal-blue border border-signal-blue";
    case "disabled":
      return "bg-paper-sunk text-ink-faint border border-paper-rule";
    default:
      return "bg-paper-sunk text-ink-soft border border-paper-rule";
  }
}

const STATE_RANK: Record<ServerStatus["state"], number> = {
  failed: 0,
  awaiting_oauth: 1,
  connecting: 2,
  connected: 3,
  disconnected: 4,
  disabled: 5,
};

interface AgentStatus {
  agentId: string;
  servers?: ServerStatus[];
}

async function getJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * One MCP management surface for both global (`mcp.json`) and per-agent
 * (`AGENT.md` mcpServers) scopes. Editing is the raw JSON object — the same
 * shape Claude Desktop / Cursor / Cline use — validated server-side. Status,
 * reconnect, disconnect and test work the same in both scopes.
 */
export function McpManager({
  scope,
  readOnly = false,
}: {
  scope: McpScope;
  readOnly?: boolean;
}) {
  const isGlobal = scope === "global";
  const agentId = isGlobal ? null : scope.agentId;

  // The agent's own private servers (or the global catalog).
  const [servers, setServers] = useState<Record<string, MCPServerConfigDto>>({});
  // Per-agent only: global servers (for the inherit toggle) + exclusions.
  const [globalServers, setGlobalServers] = useState<Record<string, MCPServerConfigDto>>({});
  const [disabled, setDisabled] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<ServerStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonSaving, setJsonSaving] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      if (isGlobal) {
        const s = await getJson<{ agents?: AgentStatus[] }>("/api/mcp/status");
        // collapse per-agent → best status per server name
        const byName = new Map<string, ServerStatus>();
        for (const a of s.agents ?? []) {
          for (const srv of a.servers ?? []) {
            const prev = byName.get(srv.name);
            if (!prev || STATE_RANK[srv.state] < STATE_RANK[prev.state]) {
              byName.set(srv.name, srv);
            }
          }
        }
        setStatuses([...byName.values()]);
      } else {
        const s = await getJson<{ servers?: ServerStatus[] }>(
          `/api/agents/${agentId}/mcp/status`
        );
        setStatuses(s.servers ?? []);
      }
    } catch {
      /* status is best-effort */
    }
  }, [isGlobal, agentId]);

  const load = useCallback(async () => {
    try {
      type Catalog = { mcpServers?: Record<string, MCPServerConfigDto> };
      if (isGlobal) {
        const g = await getJson<Catalog>("/api/mcp/global");
        setServers(g.mcpServers ?? {});
      } else {
        const [agent, g] = await Promise.all([
          getJson<Catalog & { mcpDisabled?: string[] }>(`/api/agents/${agentId}`),
          getJson<Catalog>("/api/mcp/global"),
        ]);
        setServers(agent.mcpServers ?? {});
        setDisabled(agent.mcpDisabled ?? []);
        setGlobalServers(g.mcpServers ?? {});
      }
      await loadStatus();
    } catch (e) {
      toast.error("Failed to load MCP", { description: (e as Error).message });
    }
  }, [isGlobal, agentId, loadStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  // Light poll so connections come up live (boot/reconnect take a moment).
  const pollRef = useRef(loadStatus);
  pollRef.current = loadStatus;
  useEffect(() => {
    const t = setInterval(() => void pollRef.current(), 4000);
    return () => clearInterval(t);
  }, []);

  const saveUrl = isGlobal ? "/api/mcp/global" : `/api/agents/${agentId}/mcp`;

  const openJson = () => {
    setJsonText(JSON.stringify({ mcpServers: servers }, null, 2));
    setJsonError(null);
    setJsonOpen(true);
  };

  const saveJson = async () => {
    setJsonError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      setJsonError(`JSON parse error: ${(e as Error).message}`);
      return;
    }
    // Tolerate { mcpServers: {...} } or a bare {...} (paste from any client).
    const obj =
      parsed && typeof parsed === "object" && "mcpServers" in (parsed as object)
        ? (parsed as { mcpServers: unknown }).mcpServers
        : parsed;
    setJsonSaving(true);
    try {
      await putServers(obj as Record<string, MCPServerConfigDto>);
      setJsonOpen(false);
      toast.success("MCP servers saved");
      setTimeout(() => void loadStatus(), 500);
    } catch (e) {
      setJsonError((e as Error).message);
    } finally {
      setJsonSaving(false);
    }
  };

  // Persist the scope's server map (global mcp.json or the agent's private set).
  const putServers = async (next: Record<string, MCPServerConfigDto>) => {
    const res = await fetch(`${API_BASE}${saveUrl}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpServers: next }),
    });
    const data = await res.json();
    if (!res.ok) {
      const detail = Array.isArray(data.details) ? `\n${data.details.join("\n")}` : "";
      throw new Error(`${data.error ?? `HTTP ${res.status}`}${detail}`);
    }
    setServers(data.mcpServers ?? {});
  };

  const reconnect = async (name: string) => {
    setBusy(name);
    try {
      if (isGlobal) {
        const s = await getJson<{ agents?: AgentStatus[] }>("/api/mcp/status");
        const targets = (s.agents ?? []).filter((a) =>
          (a.servers ?? []).some((x) => x.name === name)
        );
        await Promise.all(
          targets.map((a) =>
            fetch(
              `${API_BASE}/api/agents/${a.agentId}/mcp/servers/${encodeURIComponent(name)}/reconnect`,
              { method: "POST" }
            )
          )
        );
      } else {
        await fetch(
          `${API_BASE}/api/agents/${agentId}/mcp/servers/${encodeURIComponent(name)}/reconnect`,
          { method: "POST" }
        );
      }
      toast.success(`Reconnecting '${name}'`);
      await loadStatus();
    } catch (e) {
      toast.error("Reconnect failed", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // Power = reversible on/off. Flip `enabled` in the config, then reinit —
  // disabling stops it, enabling brings it back (no dead-end disconnect).
  const toggleEnabled = async (name: string) => {
    const cfg = servers[name];
    if (!cfg) return;
    const turningOn = cfg.enabled === false;
    setBusy(name);
    try {
      await putServers({ ...servers, [name]: { ...cfg, enabled: turningOn } });
      toast.success(`${turningOn ? "Enabled" : "Disabled"} '${name}'`);
      setTimeout(() => void loadStatus(), 500);
    } catch (e) {
      toast.error("Update failed", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const test = async (name: string, cfg: MCPServerConfigDto) => {
    setBusy(name);
    try {
      const res = await fetch(`${API_BASE}/api/mcp/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const r = await res.json();
      if (r.ok) toast.success(`'${name}' OK — ${r.tools?.length ?? 0} tools`);
      else toast.error(`'${name}' failed`, { description: r.error });
    } finally {
      setBusy(null);
    }
  };

  const toggleInherit = async (name: string, exclude: boolean) => {
    const next = exclude
      ? [...new Set([...disabled, name])]
      : disabled.filter((n) => n !== name);
    setDisabled(next);
    try {
      const res = await fetch(`${API_BASE}/api/agents/${agentId}/mcp`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcpDisabled: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTimeout(() => void loadStatus(), 500);
    } catch (e) {
      setDisabled(disabled); // revert
      toast.error("Update failed", { description: (e as Error).message });
    }
  };

  const statusByName = useMemo(() => {
    const m = new Map<string, ServerStatus>();
    for (const s of statuses) m.set(s.name, s);
    return m;
  }, [statuses]);

  const serverNames = Object.keys(servers).sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] text-ink-soft">
          {isGlobal
            ? "Shared across every agent. Same JSON shape as Claude Desktop / Cursor / Cline."
            : "This agent's private MCP servers (added to its inherited globals)."}
        </p>
        {!readOnly && (
          <Button size="sm" variant="outline" onClick={openJson}>
            Edit JSON
          </Button>
        )}
      </div>

      {/* per-agent: inherited globals toggle row */}
      {!isGlobal && Object.keys(globalServers).length > 0 && (
        <div className="border border-paper-rule">
          <div className="border-b border-paper-rule bg-paper-sunk px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Inherited from global
          </div>
          <div className="divide-y divide-paper-rule">
            {Object.keys(globalServers).sort().map((name) => {
              const excluded = disabled.includes(name);
              const st = statusByName.get(name);
              return (
                <label
                  key={name}
                  className="flex items-center gap-2 px-3 py-1.5 text-[12px]"
                >
                  <input
                    type="checkbox"
                    checked={!excluded}
                    disabled={readOnly}
                    onChange={(e) => void toggleInherit(name, !e.target.checked)}
                  />
                  <span className="font-mono text-ink">{name}</span>
                  {st && (
                    <span className={cn("ml-auto px-1.5 py-px font-mono text-[10px]", pillClass(st.state))}>
                      {st.state}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* the scope's own servers, with live status + actions */}
      <div className="border border-paper-rule">
        <div className="border-b border-paper-rule bg-paper-sunk px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          {isGlobal ? "Servers" : "Agent-private servers"}
        </div>
        {serverNames.length === 0 ? (
          <div className="px-3 py-3 text-[12px] text-ink-faint">
            None yet. Click “Edit JSON” to add one.
          </div>
        ) : (
          <div className="divide-y divide-paper-rule">
            {serverNames.map((name) => {
              const cfg = servers[name]!;
              const st = statusByName.get(name);
              const transport = st?.transport ?? (cfg.url ? "http" : "stdio");
              return (
                <div key={name} className="flex items-center gap-2 px-3 py-2">
                  <Plug className="size-3.5 shrink-0 text-ink-faint" />
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[12px] text-ink">{name}</div>
                    <div className="truncate font-mono text-[10px] text-ink-faint">
                      {transport} · {st ? `${st.toolCount} tools` : "—"}
                      {st?.lastError ? ` · ${st.lastError}` : ""}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "ml-auto shrink-0 px-1.5 py-px font-mono text-[10px]",
                      pillClass(st?.state ?? (cfg.enabled === false ? "disabled" : "disconnected"))
                    )}
                  >
                    {st?.state ?? (cfg.enabled === false ? "disabled" : "—")}
                  </span>
                  {!readOnly && (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        title="Test connection"
                        aria-label="Test connection"
                        disabled={busy === name}
                        onClick={() => void test(name, cfg)}
                        className="p-1 text-ink-soft hover:text-plot-red disabled:opacity-40"
                      >
                        <PlugZap className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Reconnect"
                        aria-label="Reconnect"
                        disabled={busy === name}
                        onClick={() => void reconnect(name)}
                        className="p-1 text-ink-soft hover:text-plot-red disabled:opacity-40"
                      >
                        <RefreshCw className={cn("size-3.5", busy === name && "animate-spin")} />
                      </button>
                      {(() => {
                        const off = cfg.enabled === false;
                        const Icon = off ? PowerOff : Power;
                        return (
                          <button
                            type="button"
                            title={off ? "Enable" : "Disable"}
                            aria-label={off ? "Enable" : "Disable"}
                            disabled={busy === name}
                            onClick={() => void toggleEnabled(name)}
                            className={cn(
                              "p-1 disabled:opacity-40",
                              off
                                ? "text-ink-faint hover:text-signal-green"
                                : "text-ink-soft hover:text-destructive"
                            )}
                          >
                            <Icon className="size-3.5" />
                          </button>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* JSON editor dialog */}
      {jsonOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl border border-paper-rule bg-paper shadow-xl">
            <div className="border-b border-paper-rule px-4 py-2 font-mono text-[12px] text-ink">
              Edit MCP servers (JSON)
            </div>
            <div className="p-4">
              <p className="mb-2 text-[11px] text-ink-faint">
                Same JSON shape Claude Desktop, Cursor, and Cline use. Paste a config
                or hand-edit. Validated on save — invalid configs aren’t persisted.
              </p>
              <textarea
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                spellCheck={false}
                className="h-72 w-full resize-none border border-paper-rule bg-code-surface px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
              />
              {jsonError && (
                <pre className="mt-2 whitespace-pre-wrap border border-destructive bg-paper-sunk px-2 py-1 font-mono text-[11px] text-destructive">
                  {jsonError}
                </pre>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-paper-rule px-4 py-2">
              <Button size="sm" variant="ghost" onClick={() => setJsonOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void saveJson()} disabled={jsonSaving}>
                {jsonSaving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
