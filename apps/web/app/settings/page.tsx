"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Key,
  Server,
  Cpu,
  Boxes,
  Pencil,
  Plug,
  RefreshCw,
  Trash2,
  Plus,
  FileJson,
  FileText,
  Search,
  Globe2,
  Bell,
} from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { NotificationsTab } from "../components/NotificationsTab";
import { API_BASE } from "../lib/api";
import type { ModelDefaultsView, ModelDefaultsUpdate } from "../lib/types";
import {
  MCPServerForm,
  type MCPServerConfigDto,
  type MCPServerFormValue,
} from "../components/MCPServerForm";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/app/components/ui/radio-group";
import { Textarea } from "@/app/components/ui/textarea";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { Badge } from "@/app/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";

interface ServerConfig {
  dataDir: string;
  // Mirrors `ConfigResponse.model` in @openacme/server/src/app.ts. Workforce
  // default — every agent without its own `model:` block inherits this.
  model: ModelDefaultsView;
  server: { port: number; host: string };
  behavior: { maxSteps: number };
  skills: { directory: string; autoGenerate: boolean };
}

interface Provider {
  id: string;
  name: string;
  requiresApiKey: boolean;
  envVar?: string;
  defaultBaseUrl?: string;
  supportsOAuth?: boolean;
  apiKeyConfigured?: boolean;
  oauthConfigured?: boolean;
  models?: Array<{ id: string; label: string; hint?: string }>;
}

interface McpServerStatus {
  name: string;
  state: "disabled" | "disconnected" | "connecting" | "connected" | "failed" | "awaiting_oauth";
  connected: boolean;
  toolCount: number;
  tools: string[];
  lastError?: string;
  attemptCount: number;
  transport?: "http" | "sse" | "stdio";
}

interface McpStatusPayload {
  agents: { agentId: string; servers: McpServerStatus[] }[];
}

/**
 * Aggregate status across every agent for one server name. A global server
 * shows up in every agent's MCP client; we want one row in the UI.
 */
function aggregateStatus(
  name: string,
  status: McpStatusPayload | null
): McpServerStatus | null {
  if (!status) return null;
  const matches: McpServerStatus[] = [];
  for (const a of status.agents) {
    for (const s of a.servers) {
      if (s.name === name) matches.push(s);
    }
  }
  if (matches.length === 0) return null;
  // Prefer the most-informative entry: connected > awaiting_oauth > failed >
  // connecting > disconnected > disabled.
  const order: McpServerStatus["state"][] = [
    "connected",
    "awaiting_oauth",
    "failed",
    "connecting",
    "disconnected",
    "disabled",
  ];
  matches.sort(
    (a, b) => order.indexOf(a.state) - order.indexOf(b.state)
  );
  return matches[0] ?? null;
}

function statePillClass(state: McpServerStatus["state"]): string {
  switch (state) {
    case "connected":
      // OK role per §2 — daemon up, MCP healthy.
      return "bg-paper text-ink border border-signal-green";
    case "awaiting_oauth":
      // WAIT role — action pending, here ochre rather than amber so
      // it doesn't compete with the in-flow BLOCKED chip.
      return "bg-paper text-warn-ochre border border-warn-ochre";
    case "failed":
      return "bg-paper text-destructive border border-destructive";
    case "connecting":
      // WORKING role per §2 — transient transitional state.
      return "bg-paper text-signal-blue border border-signal-blue";
    case "disabled":
      return "bg-paper-sunk text-ink-faint border border-paper-rule";
    default:
      return "bg-paper-sunk text-ink-soft border border-paper-rule";
  }
}

export default function SettingsPage() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, boolean>>({});
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  // Default-model editor — workforce-wide root config.yaml#model. `draft` is
  // hydrated from the loaded `config.model` and pushed via PUT
  // /api/config/model. Takes effect on next daemon restart (in-memory
  // AgentManager snapshot doesn't refresh) — surfaced as inline hint.
  const [modelDraft, setModelDraft] = useState<ModelDefaultsView | null>(null);
  const [modelSaving, setModelSaving] = useState(false);

  // Subscription paths: state shared by Anthropic Claude Code import + OpenAI
  // ChatGPT OAuth (both surfaced inline with the API-key field, below).
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState(false);
  const [subAction, setSubAction] = useState<string | null>(null);

  // MCP state — global catalog + aggregated per-server status across agents.
  const [mcpServers, setMcpServers] = useState<Record<string, MCPServerConfigDto>>({});
  const [mcpStatus, setMcpStatus] = useState<McpStatusPayload | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpDialog, setMcpDialog] = useState<
    | { mode: "add" }
    | { mode: "edit"; initial: MCPServerFormValue }
    | null
  >(null);
  const [mcpRefreshing, setMcpRefreshing] = useState<string | null>(null);
  // Raw-JSON editor state — for users who'd rather paste/edit verbatim
  // than use the dialog form. Saves to PUT /api/mcp/global which validates.
  const [mcpJsonOpen, setMcpJsonOpen] = useState(false);
  const [mcpJsonText, setMcpJsonText] = useState("");
  const [mcpJsonError, setMcpJsonError] = useState<string | null>(null);
  const [mcpJsonSaving, setMcpJsonSaving] = useState(false);

  // AGENTS.md — shared context for every agent. null = file absent.
  const [agentsMd, setAgentsMd] = useState<string | null>(null);
  const [agentsMdDraft, setAgentsMdDraft] = useState("");
  const [agentsMdSaving, setAgentsMdSaving] = useState(false);

  // Web search — Tavily / Exa / Brave keys + active-provider override.
  interface WebSearchStatus {
    providers: string[];
    configured: Record<string, boolean>;
    override: string | null;
    active: string;
  }
  const [webSearch, setWebSearch] = useState<WebSearchStatus | null>(null);
  const [webKeyInputs, setWebKeyInputs] = useState<Record<string, string>>({});
  const [webSaving, setWebSaving] = useState<string | null>(null);
  const [webOverrideSaving, setWebOverrideSaving] = useState(false);

  // Browser — provider selection + per-cloud creds + local-only knobs.
  interface BrowserStatus {
    providers: string[];
    localBrowsers: string[];
    active: string;
    localBrowser: string;
    executablePath: string;
    headless: boolean;
    noSandbox: boolean;
    configured: Record<string, boolean>;
    localBrowserReady?: Record<string, boolean>;
    localBrowserFetching?: Record<string, boolean>;
  }
  const [browserCfg, setBrowserCfg] = useState<BrowserStatus | null>(null);
  const [browserExePath, setBrowserExePath] = useState("");
  const [browserShowCustom, setBrowserShowCustom] = useState(false);
  const [browserAdvancedOpen, setBrowserAdvancedOpen] = useState(false);
  const [browserKeyInputs, setBrowserKeyInputs] = useState<Record<string, string>>({});
  const [browserProjectIdInput, setBrowserProjectIdInput] = useState("");
  const [browserSaving, setBrowserSaving] = useState<string | null>(null);
  const [browserPendingRestart, setBrowserPendingRestart] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    loadConfig(ctrl.signal);
    loadProviders(ctrl.signal);
    loadConfiguredKeys(ctrl.signal);
    loadMcp(ctrl.signal);
    loadAgentsMd(ctrl.signal);
    loadWebSearch(ctrl.signal);
    loadBrowser(ctrl.signal);
    return () => ctrl.abort();
    // loadMcp is useCallback-stabilized; intentionally run-once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll /api/browser while a local-browser binary is downloading so the
  // status banner clears as soon as it finishes. Quietly idle otherwise.
  useEffect(() => {
    const fetching = browserCfg?.localBrowserFetching;
    if (!fetching) return;
    const anyFetching = Object.values(fetching).some(Boolean);
    if (!anyFetching) return;
    const id = setInterval(() => {
      loadBrowser().catch(() => {});
    }, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserCfg?.localBrowserFetching]);

  // Poll MCP status while the MCP tab is visible — connection states change
  // as servers reconnect or hit OAuth flows. 4s is fast enough that the UI
  // feels live without hammering the server.
  useEffect(() => {
    const id = setInterval(() => {
      loadMcpStatus().catch(() => {});
    }, 4000);
    return () => clearInterval(id);
    // loadMcpStatus is useCallback-stabilized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadConfig = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/config`, { signal });
      if (res.ok) {
        const cfg = (await res.json()) as ServerConfig;
        setConfig(cfg);
        setModelDraft(cfg.model);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load server config");
    }
  };

  const saveModelDefaults = async (next: ModelDefaultsUpdate) => {
    setModelSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/config/model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(err?.error ?? "Failed to save default model");
        return;
      }
      toast.success("Default model saved (restart to apply)");
      // Re-fetch so the editor reflects disk truth (handles server-side
      // schema-strip of fields like apiKey that we never persist).
      await loadConfig();
    } finally {
      setModelSaving(false);
    }
  };

  const loadProviders = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/models`, { signal });
      if (res.ok) setProviders(await res.json());
    } catch {
      // /api/models may not exist on older servers — fail silently
    }
  };

  const loadConfiguredKeys = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/keys`, { signal });
      if (res.ok) {
        const data = await res.json();
        setConfiguredKeys(data.configured || {});
      }
    } catch {
      // /api/keys may not exist on older servers — fail silently
    }
  };

  // Probe whether the daemon can offer Claude Code keychain import. Cheap
  // file-existence check on the server, no Touch-ID prompt.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/setup/claude-code-available`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.available === "boolean") {
          setClaudeCodeAvailable(data.available);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ChatGPT OAuth — long-polls until the daemon's loopback callback completes.
  const signInWithOpenAI = async () => {
    setSubAction("openai");
    toast.message("Opened your browser to sign in", {
      description: "Complete the flow there. This panel will update when done.",
    });
    try {
      const r = await fetch(`${API_BASE}/api/setup/oauth-start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai" }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        error?: string;
        email?: string | null;
      };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success(
        data.email ? `Signed in as ${data.email}` : "ChatGPT subscription linked"
      );
      setConfiguredKeys((prev) => ({ ...prev, openai: true }));
      // Refetch providers so the auth picker's "not signed in" flips.
      void loadProviders();
    } catch (e) {
      toast.error("Sign-in failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubAction(null);
    }
  };

  // Anthropic — import the credentials Claude Code already wrote on this
  // machine. On macOS the OS prompts for Touch ID to unlock the keychain.
  const importClaudeCode = async () => {
    setSubAction("anthropic");
    try {
      const r = await fetch(
        `${API_BASE}/api/setup/anthropic-claude-code-import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ importNow: true }),
        }
      );
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success("Imported from Claude Code");
      setConfiguredKeys((prev) => ({ ...prev, anthropic: true }));
      void loadProviders();
    } catch (e) {
      toast.error("Import failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubAction(null);
    }
  };

  const loadAgentsMd = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/agents-md`, { signal });
      if (!res.ok) return;
      const data = (await res.json()) as { content: string | null };
      setAgentsMd(data.content);
      setAgentsMdDraft(data.content ?? "");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // Fail silently; older servers may not have this endpoint.
    }
  };

  const saveAgentsMd = async () => {
    setAgentsMdSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/agents-md`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: agentsMdDraft }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to save AGENTS.md");
        return;
      }
      const data = (await res.json()) as { content: string | null };
      setAgentsMd(data.content);
      setAgentsMdDraft(data.content ?? "");
      toast.success(
        data.content === null ? "AGENTS.md cleared" : "AGENTS.md saved"
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAgentsMdSaving(false);
    }
  };

  const saveApiKey = async (provider: string) => {
    const apiKey = apiKeyInputs[provider];
    if (!apiKey?.trim()) {
      toast.error("Please enter an API key");
      return;
    }
    setSaving(provider);
    try {
      const res = await fetch(`${API_BASE}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
      });
      if (res.ok) {
        toast.success(`${provider} key saved`);
        setApiKeyInputs({ ...apiKeyInputs, [provider]: "" });
        setConfiguredKeys({ ...configuredKeys, [provider]: true });
        void loadProviders();
      } else {
        const data = await res.json();
        toast.error("Failed to save API key", { description: data.error });
      }
    } catch {
      toast.error("Failed to save API key");
    } finally {
      setSaving(null);
    }
  };

  // ── Web search ──

  const loadWebSearch = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/web`, { signal });
      if (res.ok) setWebSearch(await res.json());
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // older servers may not have this endpoint — fail silently
    }
  };

  const saveWebKey = async (provider: string) => {
    const apiKey = webKeyInputs[provider];
    if (!apiKey?.trim()) {
      toast.error("Please enter an API key");
      return;
    }
    setWebSaving(provider);
    try {
      const res = await fetch(`${API_BASE}/api/web/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
      });
      if (res.ok) {
        toast.success(`${provider} key saved`);
        setWebKeyInputs({ ...webKeyInputs, [provider]: "" });
        await loadWebSearch();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to save key", { description: data.error });
      }
    } catch (e) {
      toast.error("Failed to save key", { description: (e as Error).message });
    } finally {
      setWebSaving(null);
    }
  };

  const removeWebKey = async (provider: string) => {
    if (!confirm(`Remove the ${provider} API key?`)) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/web/keys/${encodeURIComponent(provider)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to remove key", { description: data.error });
        return;
      }
      toast.success(`${provider} key removed`);
      await loadWebSearch();
    } catch (e) {
      toast.error("Failed to remove key", { description: (e as Error).message });
    }
  };

  const saveWebOverride = async (next: string) => {
    setWebOverrideSaving(true);
    try {
      const provider = next === "auto" ? null : next;
      const res = await fetch(`${API_BASE}/api/web/provider`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to update provider", { description: data.error });
        return;
      }
      toast.success(
        provider ? `Provider set to ${provider}` : "Provider set to auto"
      );
      await loadWebSearch();
    } catch (e) {
      toast.error("Failed to update provider", {
        description: (e as Error).message,
      });
    } finally {
      setWebOverrideSaving(false);
    }
  };

  // ── Browser ──

  const loadBrowser = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/browser`, { signal });
      if (res.ok) {
        const data = (await res.json()) as BrowserStatus;
        setBrowserCfg(data);
        setBrowserExePath(data.executablePath ?? "");
        setBrowserShowCustom(!!data.executablePath);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // older servers may not have this endpoint — fail silently
    }
  };

  const saveBrowserConfig = async (patch: Record<string, unknown>, label: string) => {
    setBrowserSaving(label);
    try {
      const res = await fetch(`${API_BASE}/api/browser/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to save browser settings", { description: data.error });
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data?.needsRestart) setBrowserPendingRestart(true);
      toast.success("Browser settings saved — restart the daemon to apply");
      await loadBrowser();
    } catch (e) {
      toast.error("Failed to save browser settings", {
        description: (e as Error).message,
      });
    } finally {
      setBrowserSaving(null);
    }
  };

  const saveBrowserKey = async (provider: string) => {
    const apiKey = browserKeyInputs[provider];
    if (!apiKey?.trim()) {
      toast.error("Please enter an API key");
      return;
    }
    const payload: Record<string, string> = { provider, apiKey: apiKey.trim() };
    if (provider === "browserbase") {
      if (!browserProjectIdInput.trim()) {
        toast.error("Browserbase also needs a project ID");
        return;
      }
      payload.projectId = browserProjectIdInput.trim();
    }
    setBrowserSaving(`key:${provider}`);
    try {
      const res = await fetch(`${API_BASE}/api/browser/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        toast.success(`${provider} key saved`);
        setBrowserKeyInputs({ ...browserKeyInputs, [provider]: "" });
        if (provider === "browserbase") setBrowserProjectIdInput("");
        await loadBrowser();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to save key", { description: data.error });
      }
    } catch (e) {
      toast.error("Failed to save key", { description: (e as Error).message });
    } finally {
      setBrowserSaving(null);
    }
  };

  const removeBrowserKey = async (provider: string) => {
    if (!confirm(`Remove the ${provider} credentials?`)) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/browser/keys/${encodeURIComponent(provider)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to remove key", { description: data.error });
        return;
      }
      toast.success(`${provider} credentials removed`);
      await loadBrowser();
    } catch (e) {
      toast.error("Failed to remove key", { description: (e as Error).message });
    }
  };

  // ── MCP ──

  const loadMcp = useCallback(async (signal?: AbortSignal) => {
    setMcpLoading(true);
    try {
      const [g, s] = await Promise.all([
        fetch(`${API_BASE}/api/mcp/global`, { signal }).then((r) => r.json()),
        fetch(`${API_BASE}/api/mcp/status`, { signal }).then((r) => r.json()),
      ]);
      setMcpServers(g.mcpServers ?? {});
      setMcpStatus(s as McpStatusPayload);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load MCP servers");
    } finally {
      setMcpLoading(false);
    }
  }, []);

  const loadMcpStatus = useCallback(async () => {
    const res = await fetch(`${API_BASE}/api/mcp/status`);
    if (res.ok) setMcpStatus((await res.json()) as McpStatusPayload);
  }, []);

  const saveGlobalServers = async (
    next: Record<string, MCPServerConfigDto>
  ) => {
    const res = await fetch(`${API_BASE}/api/mcp/global`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpServers: next }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    return ((await res.json()).mcpServers ?? {}) as Record<string, MCPServerConfigDto>;
  };

  const handleMcpSubmit = async (value: MCPServerFormValue) => {
    const next: Record<string, MCPServerConfigDto> = { ...mcpServers };
    next[value.name] = value.config;
    try {
      const saved = await saveGlobalServers(next);
      setMcpServers(saved);
      setMcpDialog(null);
      toast.success(`Saved '${value.name}'`);
      await loadMcpStatus();
    } catch (e) {
      toast.error("Save failed", { description: (e as Error).message });
    }
  };

  const handleMcpDelete = async (name: string) => {
    if (!confirm(`Remove MCP server '${name}'? This affects every agent.`)) return;
    const next: Record<string, MCPServerConfigDto> = { ...mcpServers };
    delete next[name];
    try {
      const saved = await saveGlobalServers(next);
      setMcpServers(saved);
      toast.success(`Removed '${name}'`);
      await loadMcpStatus();
    } catch (e) {
      toast.error("Delete failed", { description: (e as Error).message });
    }
  };

  const handleMcpToggleEnabled = async (name: string) => {
    const cur = mcpServers[name];
    if (!cur) return;
    const next: Record<string, MCPServerConfigDto> = {
      ...mcpServers,
      [name]: { ...cur, enabled: cur.enabled === false ? true : false },
    };
    try {
      const saved = await saveGlobalServers(next);
      setMcpServers(saved);
      await loadMcpStatus();
    } catch (e) {
      toast.error("Update failed", { description: (e as Error).message });
    }
  };

  const handleMcpReconnect = async (name: string) => {
    if (!mcpStatus) return;
    setMcpRefreshing(name);
    try {
      // Reconnect on every agent that has this server.
      const targets = mcpStatus.agents.filter((a) =>
        a.servers.some((s) => s.name === name)
      );
      await Promise.all(
        targets.map((a) =>
          fetch(`${API_BASE}/api/agents/${a.agentId}/mcp/servers/${encodeURIComponent(name)}/reconnect`, {
            method: "POST",
          })
        )
      );
      toast.success(`Reconnecting '${name}'`);
      await loadMcpStatus();
    } catch (e) {
      toast.error("Reconnect failed", { description: (e as Error).message });
    } finally {
      setMcpRefreshing(null);
    }
  };

  const handleMcpTest = async (
    value: MCPServerFormValue
  ): Promise<{ ok: boolean; error?: string; tools?: string[]; transport?: string }> => {
    const res = await fetch(`${API_BASE}/api/mcp/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value.config),
    });
    return await res.json();
  };

  const openMcpJsonEditor = () => {
    setMcpJsonText(
      JSON.stringify({ mcpServers: mcpServers }, null, 2)
    );
    setMcpJsonError(null);
    setMcpJsonOpen(true);
  };

  const saveMcpJson = async () => {
    setMcpJsonError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(mcpJsonText);
    } catch (e) {
      setMcpJsonError(`JSON parse error: ${(e as Error).message}`);
      return;
    }
    // Tolerate either { mcpServers: {...} } or { ...directly... }, matching
    // what people commonly paste from Claude Desktop / Cursor.
    const body: { mcpServers: unknown } =
      parsed &&
      typeof parsed === "object" &&
      "mcpServers" in (parsed as Record<string, unknown>)
        ? (parsed as { mcpServers: unknown })
        : { mcpServers: parsed };

    setMcpJsonSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/mcp/global`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = Array.isArray(data.details)
          ? `\n${data.details.join("\n")}`
          : "";
        setMcpJsonError(`${data.error ?? `HTTP ${res.status}`}${detail}`);
        return;
      }
      setMcpServers(data.mcpServers ?? {});
      setMcpJsonOpen(false);
      toast.success("Saved mcp.json");
      await loadMcpStatus();
    } catch (e) {
      setMcpJsonError((e as Error).message);
    } finally {
      setMcpJsonSaving(false);
    }
  };

  const providersNeedingKeys = providers.filter((p) => p.requiresApiKey && p.envVar);

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-paper-rule px-3 md:px-6">
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Settings
            </h1>
          </div>
        </header>

        <Tabs
          defaultValue="api-keys"
          orientation="vertical"
          className="flex flex-1 flex-col overflow-hidden md:flex-row"
        >
          {/* Section rail: vertical list on desktop (the primitive's 2px
              plot-red left marker = the sidebar active treatment),
              horizontal scroll row on mobile. The !-overrides beat the
              primitive's vertical-orientation w-fit/h-fit/flex-col. */}
              <TabsList className="flex-nowrap overflow-x-auto max-md:!w-full max-md:!flex-row md:!h-full md:!w-56 md:shrink-0 md:items-stretch md:overflow-x-hidden md:overflow-y-auto md:border-b-0 md:border-r md:py-2">
                  <TabsTrigger value="api-keys" className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium">
                    <Key className="size-3.5" />
                    API Keys
                  </TabsTrigger>
                  <TabsTrigger value="server" className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium">
                    <Server className="size-3.5" />
                    Server
                  </TabsTrigger>
                  <TabsTrigger value="providers" className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium">
                    <Cpu className="size-3.5" />
                    Providers
                  </TabsTrigger>
                  <TabsTrigger value="mcp" className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium">
                    <Boxes className="size-3.5" />
                    MCP
                  </TabsTrigger>
                  <TabsTrigger value="web-search" className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium">
                    <Search className="size-3.5" />
                    Web Search
                  </TabsTrigger>
                  <TabsTrigger value="browser" className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium">
                    <Globe2 className="size-3.5" />
                    Browser
                  </TabsTrigger>
                  <TabsTrigger value="notifications" className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium">
                    <Bell className="size-3.5" />
                    Notifications
                  </TabsTrigger>
                  <TabsTrigger value="context" className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium">
                    <FileText className="size-3.5" />
                    Context
                  </TabsTrigger>
                </TabsList>

          <div className="flex-1 overflow-y-auto px-3 pb-6 pt-1 md:px-6">
            <div className="mx-auto max-w-3xl">
              <TabsContent value="api-keys">
                <Card>
                  <CardHeader>
                    <CardTitle>API Keys</CardTitle>
                    <CardDescription>
                      Saved to{" "}
                      <code className="border border-paper-rule bg-paper-sunk px-1 py-0.5 font-mono text-[11px] text-ink">
                        {config?.dataDir || "~/.openacme"}/.env
                      </code>{" "}
                      on the server. Both the CLI and web app use the same keys.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {providersNeedingKeys.length === 0 && (
                      <p className="font-mono text-[12px] text-ink-faint">
                        Loading providers…
                      </p>
                    )}
                    {providersNeedingKeys.map((provider) => {
                      const subscriptionLabel =
                        provider.id === "openai"
                          ? "Sign in with ChatGPT"
                          : provider.id === "anthropic" && claudeCodeAvailable
                            ? "Import from Claude Code"
                            : null;
                      const subHandler =
                        provider.id === "openai"
                          ? signInWithOpenAI
                          : provider.id === "anthropic"
                            ? importClaudeCode
                            : null;
                      const subBusy = subAction === provider.id;
                      return (
                        <div key={provider.id} className="grid gap-2">
                          <div className="flex items-center gap-2">
                            <Label htmlFor={`key-${provider.id}`}>
                              {provider.name}
                            </Label>
                            <span className="font-mono text-[10px] text-ink-soft">
                              {provider.envVar}
                            </span>
                            {configuredKeys[provider.id] && (
                              <Badge variant="secondary" className="ml-auto gap-1">
                                <Check className="size-3" />
                                Configured
                              </Badge>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <Input
                              id={`key-${provider.id}`}
                              type="password"
                              value={apiKeyInputs[provider.id] || ""}
                              onChange={(e) =>
                                setApiKeyInputs({
                                  ...apiKeyInputs,
                                  [provider.id]: e.target.value,
                                })
                              }
                              placeholder={
                                configuredKeys[provider.id]
                                  ? "Enter new key to update"
                                  : `Enter ${provider.envVar}`
                              }
                            />
                            <Button
                              onClick={() => saveApiKey(provider.id)}
                              disabled={
                                saving === provider.id ||
                                !apiKeyInputs[provider.id]?.trim()
                              }
                            >
                              {saving === provider.id && (
                                <LoadingHairline inline />
                              )}
                              Save
                            </Button>
                          </div>
                          {subscriptionLabel && subHandler && (
                            <div className="flex items-center justify-between gap-3 pt-1 font-mono text-[11px] text-ink-faint">
                              <span>
                                {provider.id === "anthropic"
                                  ? "Or use Claude Code keychain (Touch ID may prompt)"
                                  : "Or use your existing subscription"}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={subHandler}
                                disabled={subBusy}
                              >
                                {subBusy && <LoadingHairline inline />}
                                {subscriptionLabel}
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="server">
                <Card>
                  <CardHeader>
                    <CardTitle>Server configuration</CardTitle>
                    <CardDescription>
                      Read from{" "}
                      <code className="border border-paper-rule bg-paper-sunk px-1 py-0.5 font-mono text-[11px] text-ink">
                        config.yaml
                      </code>
                      . Edit the file to change these.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {config ? (
                      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 font-mono text-[12px] tabular-nums">
                        <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Data dir
                        </dt>
                        <dd className="text-ink-soft break-all">
                          {config.dataDir}
                        </dd>
                        <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Server
                        </dt>
                        <dd className="text-ink-soft">
                          {config.server.host}:{config.server.port}
                        </dd>
                        <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Max steps
                        </dt>
                        <dd className="text-ink-soft">
                          {config.behavior.maxSteps}
                        </dd>
                        <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Skills dir
                        </dt>
                        <dd className="text-ink-soft break-all">
                          {config.skills.directory}
                        </dd>
                      </dl>
                    ) : (
                      <p className="font-mono text-[12px] text-ink-faint">Loading…</p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="providers" className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Default model</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {modelDraft === null ? (
                      <p className="font-mono text-[12px] text-ink-faint">
                        Loading…
                      </p>
                    ) : (
                      <div className="space-y-5">
                        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                          <div className="grid gap-2">
                            <Label htmlFor="default-provider">Provider</Label>
                            <Select
                              value={modelDraft.provider ?? ""}
                              onValueChange={(v) => {
                                const nextProvider = providers.find(
                                  (p) => p.id === v
                                );
                                const newPresets = nextProvider?.models ?? [];
                                const stillValid = newPresets.some(
                                  (m) => m.id === modelDraft.model
                                );
                                // Auto-fallback to api_key if the user's prior
                                // OAuth selection isn't available on the new
                                // provider — saving an unsupported mode would
                                // fail at first turn.
                                const oauthOk =
                                  modelDraft.auth !== "oauth" ||
                                  nextProvider?.supportsOAuth === true;
                                setModelDraft({
                                  ...modelDraft,
                                  provider: v,
                                  model: stillValid
                                    ? modelDraft.model
                                    : newPresets[0]?.id ?? "",
                                  auth: oauthOk ? modelDraft.auth : "api_key",
                                });
                              }}
                            >
                              <SelectTrigger id="default-provider">
                                <SelectValue placeholder="Select a provider" />
                              </SelectTrigger>
                              <SelectContent>
                                {providers.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {p.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="grid gap-2">
                            <Label htmlFor="default-model">Model</Label>
                            {(() => {
                              const presets =
                                providers.find(
                                  (p) => p.id === modelDraft.provider
                                )?.models ?? [];
                              if (presets.length === 0) {
                                return (
                                  <Input
                                    id="default-model"
                                    value={modelDraft.model ?? ""}
                                    onChange={(e) =>
                                      setModelDraft({
                                        ...modelDraft,
                                        model: e.target.value,
                                      })
                                    }
                                    placeholder="Enter model id"
                                    className="font-mono text-xs"
                                  />
                                );
                              }
                              return (
                                <Select
                                  value={modelDraft.model ?? ""}
                                  onValueChange={(v) =>
                                    setModelDraft({ ...modelDraft, model: v })
                                  }
                                >
                                  <SelectTrigger id="default-model">
                                    <SelectValue placeholder="Select a model" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {presets.map((m) => (
                                      <SelectItem key={m.id} value={m.id}>
                                        {m.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              );
                            })()}
                          </div>
                        </div>

                        {/* Authentication — radio group; OAuth hidden when
                            the provider doesn't support it. Inline action
                            offers to sign in / set up the missing side. */}
                        {(() => {
                          const p = providers.find(
                            (x) => x.id === modelDraft.provider
                          );
                          if (!p) return null;
                          const supportsOAuth = p.supportsOAuth === true;
                          const apiKeyConfigured = p.apiKeyConfigured === true;
                          const oauthConfigured = p.oauthConfigured === true;
                          const auth = modelDraft.auth;
                          const subBusy = subAction === p.id;
                          const oauthAction =
                            p.id === "openai"
                              ? signInWithOpenAI
                              : p.id === "anthropic"
                                ? importClaudeCode
                                : null;
                          const oauthActionLabel =
                            p.id === "openai"
                              ? "Sign in with ChatGPT"
                              : p.id === "anthropic"
                                ? "Import from Claude Code"
                                : "Sign in";
                          return (
                            <div className="grid gap-2">
                              <Label>Authentication</Label>
                              <RadioGroup
                                value={auth}
                                onValueChange={(v) =>
                                  setModelDraft({
                                    ...modelDraft,
                                    auth: v as "api_key" | "oauth",
                                  })
                                }
                              >
                                <label
                                  htmlFor="default-auth-api_key"
                                  className="flex items-start gap-2 text-sm cursor-pointer"
                                >
                                  <RadioGroupItem
                                    value="api_key"
                                    id="default-auth-api_key"
                                    className="mt-1"
                                  />
                                  <span className="flex-1">
                                    <span className="text-ink">API key</span>
                                    <span className="ml-2 font-mono text-[11px] text-ink-faint">
                                      {apiKeyConfigured
                                        ? "configured"
                                        : p.envVar
                                          ? `not configured (set ${p.envVar})`
                                          : "no key needed"}
                                    </span>
                                  </span>
                                </label>
                                {supportsOAuth && (
                                  <label
                                    htmlFor="default-auth-oauth"
                                    className="flex items-start gap-2 text-sm cursor-pointer"
                                  >
                                    <RadioGroupItem
                                      value="oauth"
                                      id="default-auth-oauth"
                                      className="mt-1"
                                    />
                                    <span className="flex-1">
                                      <span className="text-ink">
                                        OAuth subscription
                                      </span>
                                      <span className="ml-2 font-mono text-[11px] text-ink-faint">
                                        {oauthConfigured
                                          ? "signed in"
                                          : "not signed in"}
                                      </span>
                                      {!oauthConfigured && oauthAction && (
                                        <button
                                          type="button"
                                          className="ml-2 text-[11px] text-plot-red underline hover:no-underline disabled:opacity-50"
                                          disabled={subBusy}
                                          onClick={(e) => {
                                            e.preventDefault();
                                            void oauthAction();
                                          }}
                                        >
                                          {subBusy ? "…" : oauthActionLabel}
                                        </button>
                                      )}
                                    </span>
                                  </label>
                                )}
                              </RadioGroup>
                            </div>
                          );
                        })()}

                        {/* Cache TTL — Anthropic-only. Same gating as the per-agent form. */}
                        {(() => {
                          const m = (modelDraft.model ?? "").toLowerCase();
                          const isClaude =
                            modelDraft.provider === "anthropic" ||
                            (modelDraft.provider === "openrouter" &&
                              (m.startsWith("anthropic/") ||
                                m.includes("claude")));
                          if (!isClaude) return null;
                          return (
                            <div className="grid gap-2">
                              <Label htmlFor="default-cache-ttl">
                                Prompt cache TTL
                              </Label>
                              <Select
                                value={modelDraft.cacheTtl}
                                onValueChange={(v) =>
                                  setModelDraft({
                                    ...modelDraft,
                                    cacheTtl: v as "5m" | "1h",
                                  })
                                }
                              >
                                <SelectTrigger
                                  id="default-cache-ttl"
                                  className="md:max-w-xs"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="5m">
                                    5 minutes (default)
                                  </SelectItem>
                                  <SelectItem value="1h">1 hour</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          );
                        })()}

                        <div className="flex items-center gap-3">
                          <Button
                            type="button"
                            disabled={
                              modelSaving ||
                              !modelDraft.provider ||
                              !modelDraft.model
                            }
                            onClick={() =>
                              saveModelDefaults({
                                provider: modelDraft.provider,
                                model: modelDraft.model,
                                cacheTtl: modelDraft.cacheTtl,
                                auth: modelDraft.auth,
                              })
                            }
                          >
                            {modelSaving ? "Saving…" : "Save default model"}
                          </Button>
                          <span className="text-[11px] text-ink-faint">
                            Restart the daemon for changes to take effect on
                            running agents.
                          </span>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Available providers</CardTitle>
                    <CardDescription>
                      Models the platform can talk to. Configure API keys above.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {providers.length === 0 ? (
                      <p className="font-mono text-[12px] text-ink-faint">Loading…</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-px bg-paper-rule sm:grid-cols-3">
                        {providers.map((provider) => (
                          <div
                            key={provider.id}
                            className="bg-paper p-3"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-ink">
                                {provider.name}
                              </span>
                              {configuredKeys[provider.id] && (
                                <Check className="size-3.5 text-plot-red" />
                              )}
                            </div>
                            <div className="mt-1 font-mono text-[11px] text-ink-faint">
                              {provider.requiresApiKey
                                ? provider.envVar
                                : "no key needed"}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="mcp">
                <Card>
                  <CardHeader className="flex flex-row items-start justify-between gap-2">
                    <div>
                      <CardTitle>MCP servers</CardTitle>
                      <CardDescription>
                        Defined in{" "}
                        <code className="font-mono text-ink">
                          {config?.dataDir ?? "~/.openacme"}/mcp.json
                        </code>
                        . Inherited by every agent. Per-agent exclusions and
                        agent-private servers live on each agent.
                      </CardDescription>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={openMcpJsonEditor}
                        title="Edit raw mcp.json"
                      >
                        <FileJson className="size-4" />
                        Edit JSON
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setMcpDialog({ mode: "add" })}
                      >
                        <Plus className="size-4" />
                        Add server
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {mcpLoading && Object.keys(mcpServers).length === 0 ? (
                      <p className="font-mono text-[12px] text-ink-faint">Loading…</p>
                    ) : Object.keys(mcpServers).length === 0 ? (
                      <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
                        No MCP servers configured yet. Click &ldquo;Add
                        server&rdquo; to start.
                      </p>
                    ) : (
                      <ul className="border-y border-paper-rule">
                        {Object.entries(mcpServers).map(([name, cfg]) => {
                          const status = aggregateStatus(name, mcpStatus);
                          const state =
                            cfg.enabled === false
                              ? ("disabled" as const)
                              : status?.state ?? ("disconnected" as const);
                          const transport =
                            status?.transport ?? cfg.transport ?? (cfg.command ? "stdio" : undefined);
                          return (
                            <li
                              key={name}
                              className="flex flex-col gap-2 border-b border-paper-rule/40 last:border-b-0 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono text-sm text-ink">
                                    {name}
                                  </span>
                                  <span
                                    className={`px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] ${statePillClass(state)}`}
                                  >
                                    {state}
                                  </span>
                                  {transport && (
                                    <Badge variant="outline">
                                      {transport}
                                    </Badge>
                                  )}
                                  {status && status.toolCount > 0 && (
                                    <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                                      {status.toolCount} tools
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
                                  {cfg.command
                                    ? `${cfg.command}${cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : ""}`
                                    : cfg.url ?? ""}
                                </div>
                                {status?.lastError && (
                                  <div className="mt-1 font-mono text-[11px] text-destructive line-clamp-2">
                                    {status.lastError}
                                  </div>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleMcpReconnect(name)}
                                  disabled={mcpRefreshing === name || cfg.enabled === false}
                                  title="Reconnect"
                                >
                                  {mcpRefreshing === name ? (
                                    <LoadingHairline inline />
                                  ) : (
                                    <RefreshCw className="size-4" />
                                  )}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleMcpToggleEnabled(name)}
                                  title={cfg.enabled === false ? "Enable" : "Disable"}
                                >
                                  <Plug className="size-4" />
                                  {cfg.enabled === false ? "Enable" : "Disable"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    setMcpDialog({
                                      mode: "edit",
                                      initial: { name, config: cfg },
                                    })
                                  }
                                  title="Edit"
                                >
                                  <Pencil className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleMcpDelete(name)}
                                  title="Delete"
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </CardContent>
                </Card>

                <Dialog
                  open={mcpDialog !== null}
                  onOpenChange={(open) => {
                    if (!open) setMcpDialog(null);
                  }}
                >
                  <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle>
                        {mcpDialog?.mode === "edit"
                          ? `Edit '${mcpDialog.initial.name}'`
                          : "Add MCP server"}
                      </DialogTitle>
                      <DialogDescription>
                        Same JSON shape Claude Desktop / Cursor / Cline use —
                        you can paste configs from those apps directly.
                      </DialogDescription>
                    </DialogHeader>
                    {mcpDialog && (
                      <DialogBody>
                        <MCPServerForm
                          initial={
                            mcpDialog.mode === "edit"
                              ? mcpDialog.initial
                              : undefined
                          }
                          lockName={mcpDialog.mode === "edit"}
                          reservedNames={
                            mcpDialog.mode === "add"
                              ? Object.keys(mcpServers)
                              : []
                          }
                          onSubmit={handleMcpSubmit}
                          onCancel={() => setMcpDialog(null)}
                          onTest={handleMcpTest}
                        />
                      </DialogBody>
                    )}
                  </DialogContent>
                </Dialog>

                <Dialog
                  open={mcpJsonOpen}
                  onOpenChange={(open) => {
                    if (!open) setMcpJsonOpen(false);
                  }}
                >
                  <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle>Edit mcp.json</DialogTitle>
                      <DialogDescription>
                        Same JSON shape Claude Desktop, Cursor, and Cline use.
                        Paste a config from any of those, or hand-edit. Validated
                        on save — invalid configs aren&apos;t persisted.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogBody className="grid gap-3">
                      <Textarea
                        value={mcpJsonText}
                        onChange={(e) => {
                          setMcpJsonText(e.target.value);
                          setMcpJsonError(null);
                        }}
                        rows={20}
                        spellCheck={false}
                        className="font-mono text-[12px]"
                      />
                      {mcpJsonError && (
                        <pre className="whitespace-pre-wrap border border-destructive bg-paper-sunk p-3 font-mono text-[12px] text-destructive">
                          {mcpJsonError}
                        </pre>
                      )}
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => setMcpJsonOpen(false)}
                        >
                          Cancel
                        </Button>
                        <Button onClick={saveMcpJson} disabled={mcpJsonSaving}>
                          {mcpJsonSaving && (
                            <LoadingHairline inline />
                          )}
                          Save
                        </Button>
                      </div>
                    </DialogBody>
                  </DialogContent>
                </Dialog>
              </TabsContent>

              <TabsContent value="web-search">
                <Card>
                  <CardHeader>
                    <CardTitle>Web search</CardTitle>
                    <CardDescription>
                      Provider used by the web search tool. Add a key to use a higher-limit provider or switch.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {!webSearch ? (
                      <p className="font-mono text-[12px] text-ink-faint">
                        Loading…
                      </p>
                    ) : (
                      <>
                        <div className="grid gap-2">
                          <Label>Active provider</Label>
                          <div className="flex items-center gap-3">
                            <Select
                              value={webSearch.override ?? "auto"}
                              onValueChange={saveWebOverride}
                              disabled={webOverrideSaving}
                            >
                              <SelectTrigger className="w-48">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="auto">
                                  Auto ({webSearch.active})
                                </SelectItem>
                                <SelectItem value="tavily">Tavily</SelectItem>
                                <SelectItem value="exa">Exa</SelectItem>
                                <SelectItem value="brave">Brave</SelectItem>
                              </SelectContent>
                            </Select>
                            <span className="font-mono text-[11px] text-ink-faint">
                              OPENACME_SEARCH_PROVIDER
                            </span>
                          </div>
                          <p className="font-mono text-[11px] text-ink-faint">
                            Auto picks the first configured provider in order:
                            Tavily → Brave → Exa.
                          </p>
                        </div>

                        {[
                          {
                            id: "tavily",
                            name: "Tavily",
                            envVar: "TAVILY_API_KEY",
                            blurb: "1000 free searches/month — tavily.com",
                          },
                          {
                            id: "exa",
                            name: "Exa",
                            envVar: "EXA_API_KEY",
                            blurb:
                              "1000 free searches/month — exa.ai · key optional (free tier is unauthenticated, 150/day)",
                          },
                          {
                            id: "brave",
                            name: "Brave",
                            envVar: "BRAVE_API_KEY",
                            blurb: "brave.com/search/api",
                          },
                        ].map((p) => {
                          const isConfigured = !!webSearch.configured[p.id];
                          return (
                            <div key={p.id} className="grid gap-2">
                              <div className="flex items-center gap-2">
                                <Label htmlFor={`web-key-${p.id}`}>
                                  {p.name}
                                </Label>
                                <span className="font-mono text-[10px] text-ink-soft">
                                  {p.envVar}
                                </span>
                                {isConfigured && (
                                  <Badge
                                    variant="secondary"
                                    className="ml-auto gap-1"
                                  >
                                    <Check className="size-3" />
                                    Configured
                                  </Badge>
                                )}
                              </div>
                              <div className="flex gap-2">
                                <Input
                                  id={`web-key-${p.id}`}
                                  type="password"
                                  value={webKeyInputs[p.id] || ""}
                                  onChange={(e) =>
                                    setWebKeyInputs({
                                      ...webKeyInputs,
                                      [p.id]: e.target.value,
                                    })
                                  }
                                  placeholder={
                                    isConfigured
                                      ? "Enter new key to update"
                                      : `Enter ${p.envVar}`
                                  }
                                />
                                <Button
                                  onClick={() => saveWebKey(p.id)}
                                  disabled={
                                    webSaving === p.id ||
                                    !webKeyInputs[p.id]?.trim()
                                  }
                                >
                                  {webSaving === p.id && (
                                    <LoadingHairline inline />
                                  )}
                                  Save
                                </Button>
                                {isConfigured && (
                                  <Button
                                    variant="ghost"
                                    onClick={() => removeWebKey(p.id)}
                                    title="Remove key"
                                  >
                                    <Trash2 className="size-4" />
                                  </Button>
                                )}
                              </div>
                              <p className="font-mono text-[11px] text-ink-faint">
                                {p.blurb}
                              </p>
                            </div>
                          );
                        })}
                      </>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="browser">
                <Card>
                  <CardHeader>
                    <CardTitle>Browser</CardTitle>
                    <CardDescription>
                      One browser session per agent.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {!browserCfg ? (
                      <p className="font-mono text-[12px] text-ink-faint">Loading…</p>
                    ) : (
                      <>
                        {browserPendingRestart && (
                          <div className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[11px] text-ink">
                            Restart OpenAcme to apply the new browser settings.
                          </div>
                        )}

                        <div className="grid gap-2">
                          <Label>Provider</Label>
                          <Select
                            value={browserCfg.active}
                            onValueChange={(v) =>
                              saveBrowserConfig({ provider: v }, "provider")
                            }
                            disabled={browserSaving === "provider"}
                          >
                            <SelectTrigger className="w-56">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="local">Local</SelectItem>
                              <SelectItem value="browserbase">Browserbase</SelectItem>
                              <SelectItem value="browser-use">Browser Use</SelectItem>
                              <SelectItem value="firecrawl">Firecrawl</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {browserCfg.active === "local" && (
                          <div className="space-y-4 border border-paper-rule bg-paper-sunk/40 p-4">
                            <div className="grid gap-2">
                              <Label>Browser</Label>
                              <Select
                                value={browserShowCustom ? "custom" : browserCfg.localBrowser}
                                onValueChange={(v) => {
                                  if (v === "custom") {
                                    setBrowserShowCustom(true);
                                    return;
                                  }
                                  setBrowserShowCustom(false);
                                  saveBrowserConfig(
                                    { localBrowser: v, executablePath: "" },
                                    "localBrowser"
                                  );
                                }}
                                disabled={browserSaving === "localBrowser"}
                              >
                                <SelectTrigger className="w-72">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="chromium">Chromium</SelectItem>
                                  <SelectItem value="camoufox">Camoufox (stealth)</SelectItem>
                                  <SelectItem value="custom">Custom binary…</SelectItem>
                                </SelectContent>
                              </Select>
                              {!browserShowCustom &&
                                browserCfg.localBrowserFetching?.[browserCfg.localBrowser] && (
                                  <p className="font-mono text-[11px] text-ink-faint">
                                    Downloading {browserCfg.localBrowser}…
                                  </p>
                                )}
                              {!browserShowCustom &&
                                browserCfg.localBrowserReady?.[browserCfg.localBrowser] === false &&
                                !browserCfg.localBrowserFetching?.[browserCfg.localBrowser] && (
                                  <p className="font-mono text-[11px] text-ink-faint">
                                    Will download on first use.
                                  </p>
                                )}
                            </div>

                            {browserShowCustom && (
                              <div className="grid gap-2">
                                <Label htmlFor="browser-exe">Path to a Chromium-family binary</Label>
                                <div className="flex gap-2">
                                  <Input
                                    id="browser-exe"
                                    type="text"
                                    placeholder="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
                                    value={browserExePath}
                                    onChange={(e) => setBrowserExePath(e.target.value)}
                                    className="flex-1"
                                  />
                                  <Button
                                    onClick={() =>
                                      saveBrowserConfig(
                                        { executablePath: browserExePath },
                                        "exe"
                                      )
                                    }
                                    disabled={browserSaving === "exe"}
                                  >
                                    {browserSaving === "exe" && (
                                      <LoadingHairline inline />
                                    )}
                                    Save
                                  </Button>
                                </div>
                              </div>
                            )}

                            <div className="flex items-center gap-2">
                              <input
                                id="browser-headless"
                                type="checkbox"
                                checked={browserCfg.headless}
                                onChange={(e) =>
                                  saveBrowserConfig(
                                    { headless: e.target.checked },
                                    "headless"
                                  )
                                }
                                disabled={browserSaving === "headless"}
                              />
                              <Label htmlFor="browser-headless">Headless</Label>
                              <span className="font-mono text-[11px] text-ink-faint">
                                Don&apos;t show a window. Off so you can log in per agent.
                              </span>
                            </div>

                            <div className="pt-2">
                              <button
                                type="button"
                                onClick={() => setBrowserAdvancedOpen(!browserAdvancedOpen)}
                                className="font-mono text-[11px] text-ink-faint hover:text-ink"
                              >
                                {browserAdvancedOpen ? "Hide advanced" : "Advanced"}
                              </button>
                              {browserAdvancedOpen && (
                                <div className="mt-3 flex items-center gap-2">
                                  <input
                                    id="browser-nosandbox"
                                    type="checkbox"
                                    checked={browserCfg.noSandbox}
                                    onChange={(e) =>
                                      saveBrowserConfig(
                                        { noSandbox: e.target.checked },
                                        "nosandbox"
                                      )
                                    }
                                    disabled={browserSaving === "nosandbox"}
                                  />
                                  <Label htmlFor="browser-nosandbox">No sandbox</Label>
                                  <span className="font-mono text-[11px] text-ink-faint">
                                    Only when running as root in Docker.
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {browserCfg.active !== "local" &&
                          [
                            {
                              id: "browserbase",
                              name: "Browserbase",
                              envVar: "BROWSERBASE_API_KEY",
                              needsProjectId: true,
                              blurb: "browserbase.com — paid tier unlocks proxies + advanced stealth",
                            },
                            {
                              id: "browser-use",
                              name: "Browser Use",
                              envVar: "BROWSER_USE_API_KEY",
                              needsProjectId: false,
                              blurb: "browser-use.com — best stealth pass rate (2026 benchmark)",
                            },
                            {
                              id: "firecrawl",
                              name: "Firecrawl",
                              envVar: "FIRECRAWL_API_KEY",
                              needsProjectId: false,
                              blurb: "firecrawl.dev",
                            },
                          ]
                            .filter((p) => p.id === browserCfg.active)
                            .map((p) => {
                              const isConfigured = !!browserCfg.configured[p.id];
                              return (
                                <div
                                  key={p.id}
                                  className="space-y-3 border border-paper-rule bg-paper-sunk/40 p-4"
                                >
                                  <div className="flex items-center gap-2">
                                    <Label htmlFor={`browser-key-${p.id}`}>
                                      {p.name} API key
                                    </Label>
                                    <span className="font-mono text-[10px] text-ink-soft">
                                      {p.envVar}
                                    </span>
                                    {isConfigured && (
                                      <Badge variant="secondary" className="ml-auto gap-1">
                                        <Check className="size-3" />
                                        Configured
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="flex gap-2">
                                    <Input
                                      id={`browser-key-${p.id}`}
                                      type="password"
                                      placeholder={isConfigured ? "•••••••• (set; paste a new value to replace)" : "Paste API key"}
                                      value={browserKeyInputs[p.id] ?? ""}
                                      onChange={(e) =>
                                        setBrowserKeyInputs({
                                          ...browserKeyInputs,
                                          [p.id]: e.target.value,
                                        })
                                      }
                                      className="flex-1"
                                    />
                                    <Button
                                      onClick={() => saveBrowserKey(p.id)}
                                      disabled={browserSaving === `key:${p.id}`}
                                    >
                                      {browserSaving === `key:${p.id}` && (
                                        <LoadingHairline inline />
                                      )}
                                      Save
                                    </Button>
                                    {isConfigured && (
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => removeBrowserKey(p.id)}
                                        title="Remove credentials"
                                      >
                                        <Trash2 className="size-4" />
                                      </Button>
                                    )}
                                  </div>
                                  {p.needsProjectId && (
                                    <div className="flex gap-2">
                                      <Input
                                        type="text"
                                        placeholder="Project ID (BROWSERBASE_PROJECT_ID)"
                                        value={browserProjectIdInput}
                                        onChange={(e) => setBrowserProjectIdInput(e.target.value)}
                                        className="flex-1"
                                      />
                                    </div>
                                  )}
                                  <p className="font-mono text-[11px] text-ink-faint">
                                    {p.blurb}
                                  </p>
                                </div>
                              );
                            })}
                      </>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="context">
                <Card>
                  <CardHeader>
                    <CardTitle>Shared context (AGENTS.md)</CardTitle>
                    <CardDescription>
                      Optional. If set, prepended to every agent's system prompt
                      after its persona. Leave blank to remove the file. Saves
                      to{" "}
                      <code className="border border-paper-rule bg-paper-sunk px-1 py-0.5 font-mono text-[11px] text-ink">
                        {config?.dataDir || "~/.openacme"}/AGENTS.md
                      </code>
                      .
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Textarea
                      value={agentsMdDraft}
                      onChange={(e) => setAgentsMdDraft(e.target.value)}
                      placeholder="Describe what this setup is, what it's for, anything every agent should know…"
                      rows={14}
                      className="font-mono text-[12px]"
                    />
                    <div className="flex items-center justify-between">
                      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                        {agentsMd === null ? "Not set" : "Saved"} ·{" "}
                        {agentsMdDraft.length} chars
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => setAgentsMdDraft(agentsMd ?? "")}
                          disabled={
                            agentsMdSaving || agentsMdDraft === (agentsMd ?? "")
                          }
                        >
                          Reset
                        </Button>
                        <Button
                          onClick={saveAgentsMd}
                          disabled={
                            agentsMdSaving || agentsMdDraft === (agentsMd ?? "")
                          }
                        >
                          {agentsMdSaving && <LoadingHairline inline />}
                          Save
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="notifications">
                <NotificationsTab />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </main>
    </div>
  );
}
