import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import {
  Check,
  Key,
  Server,
  Cpu,
  Boxes,
  Trash2,
  FileText,
  Search,
  Globe2,
  Bell,
  Users,
  Mail,
} from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { NotificationsTab } from "../components/NotificationsTab";
import { MembersTab } from "../components/MembersTab";
import { API_BASE } from "../lib/api";
import { docsUrl } from "../lib/links";
import { usePublishCurrentView } from "@/app/lib/CurrentViewContext";
import type { ModelDefaultsView, ModelDefaultsUpdate } from "../lib/types";
import { McpManager } from "@/app/components/mcp/McpManager";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/app/components/ui/radio-group";
import { Textarea } from "@/app/components/ui/textarea";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { Badge } from "@/app/components/ui/badge";
import {
  GoogleIcon,
  MicrosoftIcon,
  ProviderBrandLogo,
  ToolBrandLogo,
} from "@/app/components/BrandIcons";
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

const SETTINGS_TABS = [
  "api-keys",
  "server",
  "members",
  "providers",
  "mcp",
  "web-search",
  "browser",
  "email",
  "notifications",
  "context",
] as const;

export const Route = createFileRoute("/settings")({
  validateSearch: z.object({
    tab: z.enum(SETTINGS_TABS).optional().catch(undefined),
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate();
  const activeTab = Route.useSearch().tab ?? "api-keys";
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, boolean>>({});
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  // Default-model editor — workforce-wide root config.yaml#model. `draft` is
  // hydrated from the loaded `config.model` and pushed via PUT
  // /api/config/model, which calls reloadConfig server-side so the change
  // applies live (cached Agents evicted) — no restart.
  const [modelDraft, setModelDraft] = useState<ModelDefaultsView | null>(null);
  const [modelSaving, setModelSaving] = useState(false);

  // Subscription paths: state shared by Anthropic Claude Code import + OpenAI
  // ChatGPT OAuth (both surfaced inline with the API-key field, below).
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState(false);
  const [subAction, setSubAction] = useState<string | null>(null);

  // MCP management lives in <McpManager scope="global" /> (self-contained).

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

  interface EmailConfigStatus {
    imap: {
      host?: string;
      port?: number;
      smtpHost?: string;
      smtpPort?: number;
      tls?: boolean;
    } | null;
    google: { clientId: string; configured: boolean };
    microsoft: { clientId: string; tenant: string; configured: boolean };
    redirectUriAuto?: string;
    redirectUriOverride?: string;
  }
  const blankEmailForm = {
    host: "",
    port: "",
    smtpHost: "",
    smtpPort: "",
    googleClientId: "",
    googleClientSecret: "",
    msClientId: "",
    msClientSecret: "",
    msTenant: "",
    redirectUri: "",
  };
  const [emailCfg, setEmailCfg] = useState<EmailConfigStatus | null>(null);
  const [emailForm, setEmailForm] = useState({ ...blankEmailForm });
  const [emailSaving, setEmailSaving] = useState(false);

  // Publish the active settings tab + its draft to the ambient Acme panel.
  usePublishCurrentView(
    useMemo(() => {
      const content =
        activeTab === "providers"
          ? modelDraft
          : activeTab === "mcp"
            ? null
            : activeTab === "context"
              ? { agentsMd: agentsMdDraft }
              : activeTab === "email"
                ? emailForm
                : activeTab === "browser"
                  ? browserCfg
                  : activeTab === "web-search"
                    ? webSearch
                    : null;
      return {
        page: "/settings",
        entityType: "settings" as const,
        entityId: null,
        tab: activeTab,
        content,
      };
    }, [
      activeTab,
      modelDraft,
      agentsMdDraft,
      emailForm,
      browserCfg,
      webSearch,
    ])
  );
  // Redirect URI to register with the OAuth app: the typed override (verbatim)
  // or the bind-derived default, falling back to the current origin pre-load.
  const emailRedirect =
    emailForm.redirectUri.trim() ||
    emailCfg?.redirectUriAuto ||
    (typeof window !== "undefined"
      ? `${window.location.origin}/api/email/oauth/callback`
      : "/api/email/oauth/callback");

  const loadEmail = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/email/config`, { signal });
      if (!res.ok) return;
      const d = (await res.json()) as EmailConfigStatus;
      setEmailCfg(d);
      setEmailForm({
        host: d.imap?.host ?? "",
        port: d.imap?.port?.toString() ?? "",
        smtpHost: d.imap?.smtpHost ?? "",
        smtpPort: d.imap?.smtpPort?.toString() ?? "",
        googleClientId: d.google.clientId,
        googleClientSecret: "",
        msClientId: d.microsoft.clientId,
        msClientSecret: "",
        msTenant: d.microsoft.tenant,
        redirectUri: d.redirectUriOverride ?? "",
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  };

  const saveEmail = async () => {
    setEmailSaving(true);
    try {
      const f = emailForm;
      const res = await fetch(`${API_BASE}/api/email/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imap: {
            host: f.host,
            port: f.port ? Number(f.port) : undefined,
            smtpHost: f.smtpHost,
            smtpPort: f.smtpPort ? Number(f.smtpPort) : undefined,
          },
          google: {
            clientId: f.googleClientId,
            ...(f.googleClientSecret ? { clientSecret: f.googleClientSecret } : {}),
          },
          microsoft: {
            clientId: f.msClientId,
            tenant: f.msTenant,
            ...(f.msClientSecret ? { clientSecret: f.msClientSecret } : {}),
          },
          redirectUri: f.redirectUri.trim(),
        }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error("Failed to save email settings", { description: e.error });
        return;
      }
      toast.success("Email settings saved");
      await loadEmail();
    } catch (e) {
      toast.error("Failed to save email settings", {
        description: (e as Error).message,
      });
    } finally {
      setEmailSaving(false);
    }
  };

  useEffect(() => {
    const ctrl = new AbortController();
    loadConfig(ctrl.signal);
    loadProviders(ctrl.signal);
    loadConfiguredKeys(ctrl.signal);
    loadAgentsMd(ctrl.signal);
    loadWebSearch(ctrl.signal);
    loadBrowser(ctrl.signal);
    loadEmail(ctrl.signal);
    return () => ctrl.abort();
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
      toast.success("Default model saved");
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
      toast.success("Browser settings saved");
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
          value={activeTab}
          onValueChange={(tab) =>
            void navigate({
              to: "/settings",
              search: { tab: tab as (typeof SETTINGS_TABS)[number] },
              replace: true,
            })
          }
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
                  <TabsTrigger value="members" className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium">
                    <Users className="size-3.5" />
                    Members
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
                  <TabsTrigger value="email" className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium">
                    <Mail className="size-3.5" />
                    Email
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
            <div className="mx-auto max-w-5xl">
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
                            <ProviderBrandLogo
                              provider={provider.id}
                              className="size-4 shrink-0"
                            />
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
                <McpManager scope="global" />
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
                                <ToolBrandLogo
                                  id={p.id}
                                  className="size-4 shrink-0"
                                />
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
                              <SelectItem value="local">
                                <span className="flex items-center gap-2">
                                  <Boxes className="size-3.5 shrink-0" />
                                  Local
                                </span>
                              </SelectItem>
                              <SelectItem value="browserbase">
                                <span className="flex items-center gap-2">
                                  <ToolBrandLogo
                                    id="browserbase"
                                    className="size-3.5 shrink-0"
                                  />
                                  Browserbase
                                </span>
                              </SelectItem>
                              <SelectItem value="browser-use">
                                <span className="flex items-center gap-2">
                                  <ToolBrandLogo
                                    id="browser-use"
                                    className="size-3.5 shrink-0"
                                  />
                                  Browser Use
                                </span>
                              </SelectItem>
                              <SelectItem value="firecrawl">
                                <span className="flex items-center gap-2">
                                  <ToolBrandLogo
                                    id="firecrawl"
                                    className="size-3.5 shrink-0"
                                  />
                                  Firecrawl
                                </span>
                              </SelectItem>
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
                      Optional. If set, prepended to every agent&apos;s system prompt
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

              <TabsContent value="email">
                <Card>
                  <CardHeader>
                    <CardTitle>Email</CardTitle>
                    <CardDescription>
                      Workforce-wide defaults. Each agent still binds its own mailbox on
                      its own page.{" "}
                      <a
                        href={docsUrl("/email")}
                        target="_blank"
                        rel="noreferrer"
                        className="text-plot-red underline-offset-2 hover:underline"
                      >
                        Setup guide →
                      </a>
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <section className="space-y-3">
                      <div className="flex items-center gap-2">
                        <Mail className="size-4 text-ink-soft" />
                        <span className="text-sm font-medium text-ink">
                          IMAP / SMTP connection defaults
                        </span>
                      </div>
                      <p className="text-[13px] text-ink-soft">
                        Agents on IMAP inherit these when left blank.
                      </p>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="grid gap-2">
                          <Label>IMAP host</Label>
                          <Input
                            value={emailForm.host}
                            onChange={(e) => setEmailForm((s) => ({ ...s, host: e.target.value }))}
                            placeholder="imap.example.com"
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>IMAP port</Label>
                          <Input
                            value={emailForm.port}
                            onChange={(e) => setEmailForm((s) => ({ ...s, port: e.target.value }))}
                            placeholder="993"
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>SMTP host</Label>
                          <Input
                            value={emailForm.smtpHost}
                            onChange={(e) => setEmailForm((s) => ({ ...s, smtpHost: e.target.value }))}
                            placeholder="smtp.example.com"
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>SMTP port</Label>
                          <Input
                            value={emailForm.smtpPort}
                            onChange={(e) => setEmailForm((s) => ({ ...s, smtpPort: e.target.value }))}
                            placeholder="587"
                          />
                        </div>
                      </div>
                    </section>

                    <section className="space-y-3 border-t border-paper-rule pt-5">
                      <div className="flex items-center gap-2">
                        <GoogleIcon className="size-4" />
                        <span className="text-sm font-medium text-ink">Gmail</span>
                        {emailCfg?.google.configured && (
                          <Badge variant="secondary">Configured</Badge>
                        )}
                      </div>
                      <div className="grid gap-2">
                        <Label>Redirect URI</Label>
                        <div className="flex items-stretch gap-2">
                          <Input
                            value={emailForm.redirectUri}
                            onChange={(e) =>
                              setEmailForm((s) => ({ ...s, redirectUri: e.target.value }))
                            }
                            placeholder={emailCfg?.redirectUriAuto ?? ""}
                            className="flex-1 font-mono text-[12px]"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              void navigator.clipboard.writeText(emailRedirect);
                              toast.success("Redirect URI copied");
                            }}
                          >
                            Copy
                          </Button>
                        </div>
                        <p className="text-[12px] text-ink-faint">
                          Add this exact URI to your OAuth app. Leave blank to use
                          the local address (shown); set it when you reach OpenAcme
                          through a tunnel or reverse proxy. The{" "}
                          <code>/api/email/oauth/callback</code> path stays the same.
                        </p>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="grid gap-2">
                          <Label>Client ID</Label>
                          <Input
                            value={emailForm.googleClientId}
                            onChange={(e) =>
                              setEmailForm((s) => ({ ...s, googleClientId: e.target.value }))
                            }
                            placeholder="…apps.googleusercontent.com"
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>Client secret</Label>
                          <Input
                            type="password"
                            value={emailForm.googleClientSecret}
                            onChange={(e) =>
                              setEmailForm((s) => ({ ...s, googleClientSecret: e.target.value }))
                            }
                            placeholder={
                              emailCfg?.google.configured ? "•••••• (unchanged)" : "GOCSPX-…"
                            }
                          />
                        </div>
                      </div>
                    </section>

                    <section className="space-y-3 border-t border-paper-rule pt-5">
                      <div className="flex items-center gap-2">
                        <MicrosoftIcon className="size-4" />
                        <span className="text-sm font-medium text-ink">
                          Outlook / Microsoft 365
                        </span>
                        {emailCfg?.microsoft.configured && (
                          <Badge variant="secondary">Configured</Badge>
                        )}
                      </div>
                      <p className="text-[13px] text-ink-soft">
                        Your Microsoft Entra app — same redirect URI, under Web.
                      </p>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="grid gap-2">
                          <Label>Client ID</Label>
                          <Input
                            value={emailForm.msClientId}
                            onChange={(e) =>
                              setEmailForm((s) => ({ ...s, msClientId: e.target.value }))
                            }
                            placeholder="application (client) id"
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>Client secret</Label>
                          <Input
                            type="password"
                            value={emailForm.msClientSecret}
                            onChange={(e) =>
                              setEmailForm((s) => ({ ...s, msClientSecret: e.target.value }))
                            }
                            placeholder={
                              emailCfg?.microsoft.configured ? "•••••• (unchanged)" : "client secret"
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>Tenant (optional)</Label>
                          <Input
                            value={emailForm.msTenant}
                            onChange={(e) =>
                              setEmailForm((s) => ({ ...s, msTenant: e.target.value }))
                            }
                            placeholder="common"
                          />
                        </div>
                      </div>
                    </section>

                    <div className="flex justify-end border-t border-paper-rule pt-5">
                      <Button onClick={saveEmail} disabled={emailSaving}>
                        {emailSaving ? "Saving…" : "Save email settings"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="notifications">
                <NotificationsTab />
              </TabsContent>

              <TabsContent value="members">
                <MembersTab />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </main>
    </div>
  );
}
