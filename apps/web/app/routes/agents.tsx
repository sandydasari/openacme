import { Suspense, lazy, useState, useEffect, useMemo, useRef } from "react";
import {
  Plus,
  Trash2,
  Save,
  Check,
  Pencil,
  Boxes,
  ExternalLink,
  BookOpen,
  MessageSquarePlus,
} from "lucide-react";
import { toast } from "sonner";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import { AgentEmailPanel } from "../components/AgentEmailPanel";
import { EmptyState } from "@/app/components/ui/empty-state";
import type { ToolInfo, ProviderInfo, ModelPreset } from "../lib/types";
import {
  MCPServerForm,
  type MCPServerConfigDto,
  type MCPServerFormValue,
} from "../components/MCPServerForm";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { Label } from "@/app/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/app/components/ui/radio-group";
import { Badge } from "@/app/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { ActiveMarker } from "@/app/components/ui/active-marker";
import { AgentAvatar } from "@/app/components/ui/agent-avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import type { EmojiClickData } from "emoji-picker-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { cn } from "@/app/lib/utils";
import { Markdown } from "@/app/components/Markdown";
import { MarkdownEditor } from "@/app/components/MarkdownEditor";
import { FileWorkbench } from "@/app/files/FileWorkbench";
import {
  FilePreviewDialog,
  type FilePreviewTarget,
} from "@/app/files/FilePreviewDialog";
import { useFileLinkResolver } from "@/app/files/useFileLinkResolver";

type CacheTtl = "5m" | "1h";

interface Agent {
  id: string;
  name: string;
  avatar?: string;
  role: string;
  model: {
    provider: string;
    model: string;
    auth?: "api_key" | "oauth";
    cacheTtl?: CacheTtl;
  };
  persona: string;
  tools: string[];
  skills: string[];
  mcpServers?: Record<string, MCPServerConfigDto>;
  mcpDisabled?: string[];
  managed?: boolean;
  email?: { provider: "imap" | "gmail" | "microsoft"; address: string };
}

interface SkillIndexEntry {
  name: string;
  description: string;
  tags?: string[];
}

interface CatalogTemplateMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  defaultIdHint: string;
  counts: { resources: number; skills: number; mcpServers: number };
}

interface CatalogTemplate {
  meta: CatalogTemplateMeta;
  agentFields: {
    name: string;
    avatar?: string;
    role?: string;
    persona: string;
    tools: string[];
    skills: string[];
    model?: {
      provider: string;
      model: string;
      auth?: "api_key" | "oauth";
      cacheTtl?: CacheTtl;
    };
    mcpServers?: Record<string, MCPServerConfigDto>;
    mcpDisabled?: string[];
  };
  resources: Array<{ relPath: string; size: number }>;
  bundledSkills: Array<{ name: string; source: string; identifier: string }>;
  bundledMcpServers: Array<{ name: string; config: MCPServerConfigDto }>;
}

interface CatalogPreview {
  templateId: string;
  assignedId: string;
  agent: {
    name: string;
    resourceFiles: Array<{ relPath: string; size: number }>;
  };
  workforce: {
    skills: Array<{ name: string; source: string; identifier: string }>;
    mcpServers: Array<{ name: string }>;
  };
}

interface FormState {
  id: string;
  name: string;
  avatar: string;
  role: string;
  provider: string;
  model: string;
  auth: "api_key" | "oauth";
  cacheTtl: CacheTtl;
  persona: string;
  tools: string[];
  skills: string[];
  mcpServers: Record<string, MCPServerConfigDto>;
  mcpDisabled: string[];
}

const CUSTOM_MODEL = "__custom__";

const FALLBACK_FORM: FormState = {
  id: "",
  name: "",
  avatar: "",
  role: "",
  provider: "openrouter",
  model: "",
  auth: "api_key",
  cacheTtl: "5m",
  persona: "You are a helpful AI assistant.",
  tools: [],
  skills: [],
  mcpServers: {},
  mcpDisabled: [],
};

// Lazy: emoji data is sizeable and only needed once the picker opens.
const EmojiPicker = lazy(() => import("emoji-picker-react"));

const EMOJI_PICKER_FALLBACK = (
  <div className="p-6 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
    Loading&hellip;
  </div>
);

// Default icon-tab view before the user searches the full set.
const POPULAR_ICONS = [
  "bot",
  "wrench",
  "hammer",
  "code",
  "terminal",
  "palette",
  "pen-line",
  "chart-column",
  "search",
  "book-open",
  "scale",
  "flask-conical",
  "briefcase",
  "megaphone",
  "shield",
  "globe",
  "brain",
  "cog",
  "rocket",
  "lightbulb",
  "database",
  "mail",
  "calendar",
  "users",
].filter((n): n is IconName => (iconNames as readonly string[]).includes(n));

/** Avatar input with an emoji picker + searchable lucide icon picker.
 *  Free-text stays available for anything the pickers don't cover. */
function AvatarField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [iconQuery, setIconQuery] = useState("");
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const q = iconQuery.trim().toLowerCase();
  const shownIcons = q
    ? iconNames.filter((n) => n.includes(q)).slice(0, 64)
    : POPULAR_ICONS;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id="avatar"
          aria-label="Pick avatar"
          className="flex size-9 shrink-0 items-center justify-center border border-paper-rule bg-paper transition-colors hover:border-plot-red"
        >
          <AgentAvatar
            avatar={value.trim() || undefined}
            size="lg"
            className="text-ink-soft"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[324px] overflow-hidden p-0"
      >
        <Tabs defaultValue="emoji">
          <TabsList className="h-9 w-full border-b border-paper-rule pl-2">
            <TabsTrigger value="emoji">Emoji</TabsTrigger>
            <TabsTrigger value="icons">Icons</TabsTrigger>
          </TabsList>
          <TabsContent value="emoji" className="avatar-emoji-picker mt-0">
            <Suspense fallback={EMOJI_PICKER_FALLBACK}>
              <EmojiPicker
                onEmojiClick={(d: EmojiClickData) => pick(d.emoji)}
                width="100%"
                height={320}
                previewConfig={{ showPreview: false }}
                skinTonesDisabled
                lazyLoadEmojis
              />
            </Suspense>
          </TabsContent>
          <TabsContent value="icons" className="mt-0 p-3">
            <input
              type="text"
              value={iconQuery}
              onChange={(e) => setIconQuery(e.target.value)}
              placeholder="Search icons…"
              className="mb-2 w-full border border-paper-rule bg-paper px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-plot-red"
            />
            <div className="grid max-h-56 grid-cols-8 gap-1 overflow-y-auto">
              {shownIcons.length === 0 ? (
                <p className="col-span-8 py-4 text-center font-mono text-[11px] text-ink-faint">
                  No icons match.
                </p>
              ) : (
                shownIcons.map((name) => (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    aria-label={name}
                    onClick={() => pick(`icon:${name}`)}
                    className="flex size-8 items-center justify-center text-ink-soft transition-colors hover:bg-paper-sunk hover:text-ink"
                  >
                    <DynamicIcon name={name} className="size-4" aria-hidden />
                  </button>
                ))
              )}
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

const AGENT_TABS = [
  "overview",
  "tools",
  "skills",
  "mcp",
  "workspace",
  "resources",
] as const;
type AgentTab = (typeof AGENT_TABS)[number];

export const Route = createFileRoute("/agents")({
  validateSearch: z.object({
    id: z.coerce.string().optional(),
    create: z.coerce.string().optional(),
    import: z.coerce.string().optional(),
    tab: z.enum(AGENT_TABS).optional().catch(undefined),
  }),
  component: AgentsPage,
});

function AgentsPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const urlId = search.id ?? null;
  const urlCreate = search.create === "1";
  const urlImportTemplate = search["import"] ?? null;
  const detailTab: AgentTab = search.tab ?? "overview";

  const [agents, setAgents] = useState<Agent[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [globalMcp, setGlobalMcp] = useState<
    Record<string, MCPServerConfigDto>
  >({});
  const [allSkills, setAllSkills] = useState<SkillIndexEntry[]>([]);

  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [formData, setFormData] = useState<FormState>(FALLBACK_FORM);
  // Tracks the urlImportTemplate the form has already been hydrated for, so
  // post-mount refreshes of `agents`/`providers` (which re-fire the URL effect)
  // can't race against the user's in-flight selections and reset the form.
  const importHydratedFor = useRef<string | null>(null);
  const [mcpDialog, setMcpDialog] = useState<
    { mode: "add" } | { mode: "edit"; initial: MCPServerFormValue } | null
  >(null);

  // Catalog state — bundled agent templates the user can import. Two-step
  // creation modal: "choose" picks scratch vs catalog; "catalog" shows the
  // template grid.
  const [creationModal, setCreationModal] = useState<
    "closed" | "choose" | "catalog"
  >("closed");
  const [catalogTemplates, setCatalogTemplates] = useState<
    CatalogTemplateMeta[]
  >([]);
  // Set when in import mode (?import=<id>): the full template + the preview
  // diff so the form can prefill values + render the "will install" summary.
  const [importTemplate, setImportTemplate] = useState<CatalogTemplate | null>(
    null,
  );
  const [importPreview, setImportPreview] = useState<CatalogPreview | null>(
    null,
  );

  // ── Loaders ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const ctrl = new AbortController();
    void loadAll(ctrl.signal);
    return () => ctrl.abort();
  }, []);

  const loadAll = async (signal?: AbortSignal) => {
    try {
      const [agentsRes, toolsRes, providersRes, mcpRes, skillsRes, catalogRes] =
        await Promise.all([
          fetch(`${API_BASE}/api/agents`, { signal }),
          fetch(`${API_BASE}/api/tools`, { signal }),
          fetch(`${API_BASE}/api/models`, { signal }),
          fetch(`${API_BASE}/api/mcp/global`, { signal }),
          fetch(`${API_BASE}/api/skills`, { signal }),
          fetch(`${API_BASE}/api/agents/catalog`, { signal }),
        ]);
      if (agentsRes.ok) setAgents(await agentsRes.json());
      if (toolsRes.ok) {
        const data = (await toolsRes.json()) as { tools: ToolInfo[] };
        setTools(data.tools ?? []);
      }
      if (providersRes.ok) {
        setProviders((await providersRes.json()) as ProviderInfo[]);
      }
      if (mcpRes.ok) {
        const data = (await mcpRes.json()) as {
          mcpServers: Record<string, MCPServerConfigDto>;
        };
        setGlobalMcp(data.mcpServers ?? {});
      }
      if (skillsRes.ok) {
        setAllSkills((await skillsRes.json()) as SkillIndexEntry[]);
      }
      if (catalogRes.ok) {
        setCatalogTemplates((await catalogRes.json()) as CatalogTemplateMeta[]);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load page data", {
        description: "Is the server running?",
      });
    }
  };

  const reloadAgents = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/agents`);
      if (res.ok) setAgents(await res.json());
    } catch {
      /* handled by mount loader's toast */
    }
  };

  // ── Derived ──────────────────────────────────────────────────────────────

  const toolsByToolset = useMemo(() => {
    const map = new Map<string, ToolInfo[]>();
    for (const t of tools) {
      // System tools are always on for every agent — hide from the picker.
      if (t.system) continue;
      const list = map.get(t.toolset) ?? [];
      list.push(t);
      map.set(t.toolset, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools]);

  // ── Form helpers ─────────────────────────────────────────────────────────
  const toggleTool = (name: string) => {
    setFormData((prev) => ({
      ...prev,
      tools: prev.tools.includes(name)
        ? prev.tools.filter((t) => t !== name)
        : [...prev.tools, name],
    }));
  };

  const setToolGroup = (names: string[], checked: boolean) => {
    setFormData((prev) => ({
      ...prev,
      tools: setGroupSelection(prev.tools, names, checked),
    }));
  };

  const buildAgentBody = () => ({
    name: formData.name,
    avatar: formData.avatar.trim() || undefined,
    role: formData.role,
    model: {
      provider: formData.provider,
      model: formData.model,
      auth: formData.auth,
      cacheTtl: formData.cacheTtl,
    },
    persona: formData.persona,
    tools: formData.tools,
    skills: formData.skills,
    mcpServers: formData.mcpServers,
    mcpDisabled: formData.mcpDisabled,
  });

  const toggleSkill = (name: string) => {
    setFormData((prev) => ({
      ...prev,
      skills: prev.skills.includes(name)
        ? prev.skills.filter((s) => s !== name)
        : [...prev.skills, name],
    }));
  };

  // ── MCP form helpers ────────────────────────────────────────────────────

  const toggleGlobalMcpInherit = (name: string) => {
    setFormData((prev) => {
      const disabled = new Set(prev.mcpDisabled);
      if (disabled.has(name)) disabled.delete(name);
      else disabled.add(name);
      return { ...prev, mcpDisabled: [...disabled] };
    });
  };

  const handleMcpSave = (value: MCPServerFormValue) => {
    if (Object.prototype.hasOwnProperty.call(globalMcp, value.name)) {
      toast.error(
        `'${value.name}' is already a global server. ` +
          `Edit it in Settings → MCP, or pick a different name for the agent-private server.`,
      );
      return;
    }
    setFormData((prev) => ({
      ...prev,
      mcpServers: { ...prev.mcpServers, [value.name]: value.config },
    }));
    setMcpDialog(null);
  };

  const handleMcpRemove = (name: string) => {
    setFormData((prev) => {
      const next = { ...prev.mcpServers };
      delete next[name];
      return { ...prev, mcpServers: next };
    });
  };

  const handleMcpTest = async (
    value: MCPServerFormValue,
  ): Promise<{
    ok: boolean;
    error?: string;
    tools?: string[];
    transport?: string;
  }> => {
    const res = await fetch(`${API_BASE}/api/mcp/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value.config),
    });
    return await res.json();
  };

  // ── CRUD ─────────────────────────────────────────────────────────────────
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();

    // Import-from-catalog path: POST /import with the user's edits as
    // overrides. The server auto-installs recommended skills + MCP and
    // copies template resources into the agent folder.
    if (urlImportTemplate && importTemplate) {
      try {
        const res = await fetch(
          `${API_BASE}/api/agents/catalog/${encodeURIComponent(urlImportTemplate)}/import`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              idOverride: formData.id || undefined,
              nameOverride: formData.name || undefined,
              overrides: buildAgentBody(),
            }),
          },
        );
        if (!res.ok) {
          const data = await res.json();
          toast.error("Failed to import agent", { description: data.error });
          return;
        }
        const out = (await res.json()) as {
          agent: Agent;
          manifest: {
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
          };
        };
        const installed = out.manifest.workforce.skills.filter(
          (s) => s.action === "installed",
        ).length;
        const failedSkills = out.manifest.workforce.skills.filter(
          (s) => s.action === "failed",
        );
        const added = out.manifest.workforce.mcpServers.filter(
          (m) => m.action === "added",
        ).length;
        toast.success(`Imported ${out.agent.name} as ${out.agent.id}`, {
          description: [
            `${out.manifest.agent.resourceFiles.length} resource file(s)`,
            installed ? `${installed} skill(s) installed` : null,
            added ? `${added} MCP server(s) added` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        });
        if (failedSkills.length > 0) {
          toast.error(
            `${failedSkills.length} recommended skill(s) failed to install`,
            { description: failedSkills.map((s) => s.name).join(", ") },
          );
        }
        await reloadAgents();
        void navigate({ to: "/agents", search: { id: out.agent.id } });
      } catch (err) {
        toast.error("Failed to import agent", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Scratch path: POST /api/agents
    try {
      const res = await fetch(`${API_BASE}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: formData.id || formData.name.toLowerCase().replace(/\s+/g, "-"),
          ...buildAgentBody(),
        }),
      });
      if (res.ok) {
        const created = (await res.json()) as Agent;
        toast.success("Agent created");
        await reloadAgents();
        void navigate({ to: "/agents", search: { id: created.id } });
      } else {
        const data = await res.json();
        toast.error("Failed to create agent", { description: data.error });
      }
    } catch {
      toast.error("Failed to create agent");
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgent) return;
    try {
      const res = await fetch(`${API_BASE}/api/agents/${selectedAgent.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildAgentBody()),
      });
      if (res.ok) {
        const updated = (await res.json()) as Agent;
        setSelectedAgent(updated);
        setIsEditing(false);
        toast.success("Agent updated");
        reloadAgents();
      } else {
        const data = await res.json();
        toast.error("Failed to update agent", { description: data.error });
      }
    } catch {
      toast.error("Failed to update agent");
    }
  };

  const cancelEdit = () => {
    if (!selectedAgent) return;
    setIsEditing(false);
    // Restore form to the saved agent's state so re-opening the editor
    // doesn't surface in-progress edits the user said "cancel" to.
    setFormData({
      id: selectedAgent.id,
      name: selectedAgent.name,
      avatar: selectedAgent.avatar ?? "",
      role: selectedAgent.role ?? "",
      provider: selectedAgent.model.provider,
      model: selectedAgent.model.model,
      auth: selectedAgent.model.auth ?? "api_key",
      cacheTtl: selectedAgent.model.cacheTtl ?? "5m",
      persona: selectedAgent.persona,
      tools: selectedAgent.tools,
      skills: selectedAgent.skills ?? [],
      mcpServers: selectedAgent.mcpServers ?? {},
      mcpDisabled: selectedAgent.mcpDisabled ?? [],
    });
  };

  const handleDelete = async (id: string) => {
    setConfirmDelete(null);
    try {
      const res = await fetch(`${API_BASE}/api/agents/${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Agent deleted");
        await reloadAgents();
        if (selectedAgent?.id === id) {
          void navigate({ to: "/agents" });
        }
      } else {
        toast.error("Failed to delete agent");
      }
    } catch {
      toast.error("Failed to delete agent");
    }
  };

  // URL → selection state. ?id=<id> selects an agent; ?create=1 starts
  // create-from-scratch; ?import=<templateId> starts catalog-import.
  useEffect(() => {
    if (urlImportTemplate) {
      // Wait for providers to load before seeding defaults — otherwise
      // `provPresets[0]?.id` is undefined and we'd seed model="", then a
      // later re-fire would race the user's selections.
      if (providers.length === 0) return;
      // Hydrate the form once per template. Subsequent re-fires triggered by
      // `agents`/`providers` identity changes must NOT overwrite the user's
      // in-flight edits with template defaults.
      if (importHydratedFor.current === urlImportTemplate) return;
      importHydratedFor.current = urlImportTemplate;
      // Catalog-import flow: fetch the full template + preview, prefill form.
      void (async () => {
        try {
          const [tplRes, prevRes] = await Promise.all([
            fetch(
              `${API_BASE}/api/agents/catalog/${encodeURIComponent(urlImportTemplate)}`,
            ),
            fetch(
              `${API_BASE}/api/agents/catalog/${encodeURIComponent(urlImportTemplate)}/preview`,
            ),
          ]);
          if (!tplRes.ok || !prevRes.ok) {
            toast.error("Template not found");
            void navigate({ to: "/agents", replace: true });
            return;
          }
          const tpl = (await tplRes.json()) as CatalogTemplate;
          const prev = (await prevRes.json()) as CatalogPreview;
          setImportTemplate(tpl);
          setImportPreview(prev);
          setSelectedAgent(null);
          setIsCreating(true);
          setIsEditing(false);
          const provider =
            tpl.agentFields.model?.provider ??
            providers[0]?.id ??
            FALLBACK_FORM.provider;
          const provPresets =
            providers.find((p) => p.id === provider)?.models ?? [];
          const model =
            tpl.agentFields.model?.model ?? provPresets[0]?.id ?? "";
          setFormData({
            id: prev.assignedId,
            name: tpl.agentFields.name,
            avatar: tpl.agentFields.avatar ?? "",
            role: tpl.agentFields.role ?? "",
            provider,
            model,
            auth: tpl.agentFields.model?.auth ?? "api_key",
            cacheTtl: tpl.agentFields.model?.cacheTtl ?? "5m",
            persona: tpl.agentFields.persona,
            tools: tpl.agentFields.tools,
            // Imported agent's skills allowlist starts empty (sees all
            // installed skills); the bundled_skills from the template are
            // installed workforce-wide separately, not gated per-agent.
            skills: [],
            mcpServers: tpl.agentFields.mcpServers ?? {},
            mcpDisabled: tpl.agentFields.mcpDisabled ?? [],
          });
        } catch {
          toast.error("Failed to load template");
          void navigate({ to: "/agents", replace: true });
        }
      })();
      return;
    }
    // Leaving the import flow → drop the cached template + preview so the
    // "will install" block doesn't render on the scratch / edit paths. Also
    // clear the hydration guard so re-entering import mode re-populates.
    importHydratedFor.current = null;
    if (importTemplate || importPreview) {
      setImportTemplate(null);
      setImportPreview(null);
    }
    if (urlCreate) {
      setSelectedAgent(null);
      setIsCreating(true);
      setIsEditing(false);
      const defaultProvider = providers[0]?.id ?? FALLBACK_FORM.provider;
      const defaultModel =
        providers.find((p) => p.id === defaultProvider)?.models[0]?.id ?? "";
      setFormData({
        ...FALLBACK_FORM,
        provider: defaultProvider,
        model: defaultModel,
      });
      return;
    }
    if (urlId) {
      const found = agents.find((a) => a.id === urlId);
      if (found) {
        setSelectedAgent(found);
        setIsCreating(false);
        // View-first: don't auto-open into edit mode. The user clicks the
        // "Edit" button when they want to change something.
        setIsEditing(false);
        setFormData({
          id: found.id,
          name: found.name,
          avatar: found.avatar ?? "",
          role: found.role ?? "",
          provider: found.model.provider,
          model: found.model.model,
          auth: found.model.auth ?? "api_key",
          cacheTtl: found.model.cacheTtl ?? "5m",
          persona: found.persona,
          tools: found.tools,
          skills: found.skills ?? [],
          mcpServers: found.mcpServers ?? {},
          mcpDisabled: found.mcpDisabled ?? [],
        });
      } else if (agents.length > 0) {
        void navigate({ to: "/agents", replace: true });
      }
      return;
    }
    setSelectedAgent(null);
    setIsCreating(false);
    setIsEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlId, urlCreate, urlImportTemplate, agents, providers, navigate]);

  const selectAgent = (agent: Agent) =>
    void navigate({ to: "/agents", search: { id: agent.id } });
  const startCreate = () => {
    // Catalog has at least one template → ask the user; otherwise jump
    // straight to scratch.
    if (catalogTemplates.length > 0) {
      setCreationModal("choose");
    } else {
      void navigate({ to: "/agents", search: { create: "1" } });
    }
  };
  const startScratchFromModal = () => {
    setCreationModal("closed");
    void navigate({ to: "/agents", search: { create: "1" } });
  };
  const startImportFromModal = (templateId: string) => {
    setCreationModal("closed");
    void navigate({ to: "/agents", search: { import: templateId } });
  };

  // View vs edit: existing agents open in a read-only detail view; the
  // user clicks "Edit" to switch into the form. Creating an agent goes
  // straight to the form (there's nothing to view yet).
  const showForm = isCreating || (selectedAgent !== null && isEditing);
  const showView = selectedAgent !== null && !isEditing && !isCreating;

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-paper-rule px-3 md:px-6">
          <div className="flex items-center gap-2 md:gap-3">
            <h1 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Agents
            </h1>
          </div>
          <Button size="sm" onClick={startCreate}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">New agent</span>
          </Button>
        </header>

        <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
          {/* Mobile: when an agent is selected or we're creating, hide the
              roster so the detail/form gets the whole viewport. The detail
              renders a back-to-roster link. Desktop keeps the side rail. */}
          <aside
            className={cn(
              "shrink-0 overflow-y-auto border-paper-rule md:w-72 md:border-r",
              selectedAgent || isCreating
                ? "hidden md:block"
                : "block border-b md:border-b-0",
            )}
          >
            {agents.length === 0 && (
              <EmptyState icon={Boxes}>No agents configured.</EmptyState>
            )}
            {agents.map((agent) => {
              const isActive = selectedAgent?.id === agent.id;
              return (
                <button
                  key={agent.id}
                  onClick={() => selectAgent(agent)}
                  className={cn(
                    "group relative flex w-full items-start gap-3 border-b border-paper-rule/40 px-4 py-3 text-left transition-colors last:border-b-0",
                    isActive
                      ? "bg-paper-sunk text-ink"
                      : "text-ink-soft hover:bg-paper-sunk hover:text-ink",
                  )}
                >
                  <ActiveMarker active={isActive} />
                  <AgentAvatar
                    avatar={agent.avatar}
                    size="lg"
                    className="mt-0.5 text-ink-soft"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">
                      {agent.name}
                    </div>
                    {agent.role ? (
                      <div
                        className="truncate text-[11px] text-ink-faint"
                        title={agent.role}
                      >
                        {agent.role}
                      </div>
                    ) : (
                      <div
                        className="truncate font-mono text-[11px] tabular-nums text-ink-faint"
                        title={`${agent.model.provider}/${agent.model.model}`}
                      >
                        {agent.model.provider}/{agent.model.model}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </aside>

          <div
            className={cn(
              "flex-1 overflow-y-auto p-4 md:p-6",
              !selectedAgent && !isCreating ? "hidden md:block" : "",
            )}
          >
            {(selectedAgent || isCreating) && (
              <button
                type="button"
                onClick={() => void navigate({ to: "/agents" })}
                className="mb-3 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft hover:text-plot-red md:hidden"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Back to roster
              </button>
            )}
            {showView && selectedAgent ? (
              <AgentDetail
                agent={selectedAgent}
                providers={providers}
                globalServers={globalMcp}
                allSkills={allSkills}
                toolGroups={toolsByToolset}
                onAgentUpdated={(updated) => {
                  setSelectedAgent(updated);
                  void reloadAgents();
                }}
                tab={detailTab}
                onTabChange={(next) =>
                  void navigate({
                    to: "/agents",
                    search: {
                      id: selectedAgent.id,
                      tab: next === "overview" ? undefined : next,
                    },
                    replace: true,
                  })
                }
                onDelete={() => setConfirmDelete(selectedAgent.id)}
              />
            ) : showForm ? (
              <form
                onSubmit={isCreating ? handleCreate : handleUpdate}
                className="mx-auto max-w-6xl space-y-4"
              >
                {urlImportTemplate && importTemplate && importPreview && (
                  <ImportPreviewBlock
                    template={importTemplate}
                    preview={importPreview}
                  />
                )}
                <div className="border-b border-paper-rule pb-4">
                  <CardTitle className="text-xl">
                    {urlImportTemplate
                      ? `Import: ${importTemplate?.agentFields.name ?? urlImportTemplate}`
                      : isCreating
                        ? "Create agent"
                        : "Edit agent"}
                  </CardTitle>
                </div>
                <div className="space-y-5 pt-2">
                  <div className="grid grid-cols-[1fr_auto] gap-5">
                    <div className="grid gap-2">
                      <Label htmlFor="name">Name</Label>
                      <Input
                        id="name"
                        value={formData.name}
                        onChange={(e) =>
                          setFormData({ ...formData, name: e.target.value })
                        }
                        placeholder="My Agent"
                        required
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="avatar">Avatar</Label>
                      <AvatarField
                        value={formData.avatar}
                        onChange={(v) =>
                          setFormData({ ...formData, avatar: v })
                        }
                      />
                    </div>
                  </div>

                  {isCreating && (
                    <div className="grid gap-2">
                      <Label htmlFor="id">ID (optional)</Label>
                      <Input
                        id="id"
                        value={formData.id}
                        onChange={(e) =>
                          setFormData({ ...formData, id: e.target.value })
                        }
                        placeholder="my-agent (auto-generated from name)"
                      />
                    </div>
                  )}

                  <ModelConfigFields
                    providers={providers}
                    idPrefix={`agent-${formData.id || "new"}`}
                    value={{
                      provider: formData.provider,
                      model: formData.model,
                      auth: formData.auth,
                      cacheTtl: formData.cacheTtl,
                    }}
                    onChange={(m) => setFormData((prev) => ({ ...prev, ...m }))}
                  />

                  <div className="grid gap-2">
                    <Label htmlFor="role">
                      Role
                      <span className="ml-2 font-normal text-ink-faint">
                        visible to other agents
                      </span>
                    </Label>
                    <Textarea
                      id="role"
                      value={formData.role}
                      onChange={(e) =>
                        setFormData({ ...formData, role: e.target.value })
                      }
                      placeholder="Owns X. Good for Y. Redirects Z to @other-agent."
                      rows={3}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="persona">Persona</Label>
                    <div className="border border-paper-rule bg-paper px-3 py-2 transition-colors focus-within:border-plot-red">
                      <MarkdownEditor
                        value={formData.persona}
                        onChange={(persona) =>
                          setFormData({ ...formData, persona })
                        }
                        placeholder="You are a helpful AI assistant."
                        contentClassName="min-h-[96px]"
                      />
                    </div>
                  </div>

                  {/* Tools / MCP / skills configuration lives on the detail
                        tabs for existing agents — the form carries them only
                        at creation time so a new agent starts configured. */}
                  {isCreating && (
                    <>
                      <ToolPicker
                        groups={toolsByToolset}
                        selected={formData.tools}
                        onToggle={toggleTool}
                        onSetGroup={setToolGroup}
                      />

                      <McpSection
                        globalServers={globalMcp}
                        privateServers={formData.mcpServers}
                        disabled={formData.mcpDisabled}
                        onToggleInherit={toggleGlobalMcpInherit}
                        onAdd={() => setMcpDialog({ mode: "add" })}
                        onEdit={(name, cfg) =>
                          setMcpDialog({
                            mode: "edit",
                            initial: { name, config: cfg },
                          })
                        }
                        onRemove={handleMcpRemove}
                      />

                      {/* The skills picker gates which workforce skills the
                            agent sees in its prompt. Hidden during catalog
                            import — bundled skills install workforce-wide and
                            the imported agent's allowlist stays empty (sees
                            all). */}
                      {!urlImportTemplate && (
                        <SkillsPicker
                          all={allSkills}
                          selected={formData.skills}
                          onToggle={toggleSkill}
                        />
                      )}
                    </>
                  )}

                </div>

                <div className="mt-4 flex items-center justify-between">
                  <div>
                    {selectedAgent && (
                      <Button
                        type="button"
                        variant="ghost-destructive"
                        size="sm"
                        onClick={() => setConfirmDelete(selectedAgent.id)}
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedAgent && isEditing && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={cancelEdit}
                      >
                        Cancel
                      </Button>
                    )}
                    <Button type="submit">
                      <Save className="size-4" />
                      {urlImportTemplate
                        ? "Import"
                        : isCreating
                          ? "Create"
                          : "Save changes"}
                    </Button>
                  </div>
                </div>
              </form>
            ) : agents.length === 0 ? (
              <EmptyWorkforceState onCreate={startCreate} />
            ) : (
              <NoAgentPicked />
            )}
          </div>
        </div>
      </main>

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete agent?</DialogTitle>
            <DialogDescription>
              This will permanently delete the agent{" "}
              <span className="font-mono">{confirmDelete}</span>. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && handleDelete(confirmDelete)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mcpDialog !== null}
        onOpenChange={(open) => !open && setMcpDialog(null)}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {mcpDialog?.mode === "edit"
                ? `Edit '${mcpDialog.initial.name}'`
                : "Add agent-private MCP server"}
            </DialogTitle>
            <DialogDescription>
              Private to this agent only. Names cannot collide with the global
              catalog in Settings → MCP.
            </DialogDescription>
          </DialogHeader>
          {mcpDialog && (
            <DialogBody>
              <MCPServerForm
                initial={
                  mcpDialog.mode === "edit" ? mcpDialog.initial : undefined
                }
                lockName={mcpDialog.mode === "edit"}
                reservedNames={[
                  ...Object.keys(globalMcp),
                  ...(mcpDialog.mode === "add"
                    ? Object.keys(formData.mcpServers)
                    : []),
                ]}
                onSubmit={handleMcpSave}
                onCancel={() => setMcpDialog(null)}
                onTest={handleMcpTest}
              />
            </DialogBody>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={creationModal !== "closed"}
        onOpenChange={(open) => !open && setCreationModal("closed")}
      >
        <DialogContent className="max-w-2xl">
          {creationModal === "choose" ? (
            <>
              <DialogHeader>
                <DialogTitle>New agent</DialogTitle>
                <DialogDescription>
                  Build one from scratch, or start with a bundled template.
                </DialogDescription>
              </DialogHeader>
              <DialogBody className="px-0 py-0">
                <ul className="border-y border-paper-rule">
                  <li>
                    <button
                      type="button"
                      onClick={startScratchFromModal}
                      className="group flex w-full items-start gap-4 border-b border-paper-rule px-5 py-4 text-left transition-colors hover:bg-paper-sunk"
                    >
                      <Plus className="mt-0.5 size-4 shrink-0 text-ink-soft group-hover:text-plot-red" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-sm font-medium text-ink">
                            Start from scratch
                          </span>
                          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                            scratch
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-ink-soft">
                          Empty form. Pick a name, model, persona, and tools
                          yourself.
                        </p>
                      </div>
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      onClick={() => setCreationModal("catalog")}
                      className="group flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-paper-sunk"
                    >
                      <BookOpen className="mt-0.5 size-4 shrink-0 text-ink-soft group-hover:text-plot-red" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-sm font-medium text-ink">
                            Import from catalog
                          </span>
                          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                            {catalogTemplates.length} templates
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-ink-soft">
                          Bundled templates ship with the platform.
                          Auto-installs recommended skills + MCP servers.
                        </p>
                      </div>
                    </button>
                  </li>
                </ul>
              </DialogBody>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setCreationModal("closed")}
                >
                  Cancel
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Import from catalog</DialogTitle>
                <DialogDescription>
                  Pick a template. You can rename and customize after.
                </DialogDescription>
              </DialogHeader>
              <DialogBody className="max-h-[60vh] overflow-y-auto px-0 py-0">
                <ul className="border-y border-paper-rule">
                  {catalogTemplates.map((t, i) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => startImportFromModal(t.id)}
                        className={cn(
                          "flex w-full flex-col gap-2 px-5 py-4 text-left transition-colors hover:bg-paper-sunk",
                          i < catalogTemplates.length - 1 &&
                            "border-b border-paper-rule/40",
                        )}
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-sm font-medium text-ink">
                            {t.name}
                          </span>
                          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                            {t.id}
                          </span>
                        </div>
                        <p className="text-xs text-ink-soft">{t.description}</p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <div className="flex flex-wrap gap-1.5">
                            {t.tags.map((tag) => (
                              <Badge key={tag} variant="secondary">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                          <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                            {t.counts.resources} files · {t.counts.skills}{" "}
                            skills · {t.counts.mcpServers} MCP
                          </span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </DialogBody>
              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => setCreationModal("choose")}
                >
                  Back
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setCreationModal("closed")}
                >
                  Cancel
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── MCP section in the agent editor ─────────────────────────────────────────
function McpSection({
  globalServers,
  privateServers,
  disabled,
  onToggleInherit,
  onAdd,
  onEdit,
  onRemove,
}: {
  globalServers: Record<string, MCPServerConfigDto>;
  privateServers: Record<string, MCPServerConfigDto>;
  disabled: string[];
  onToggleInherit: (name: string) => void;
  onAdd: () => void;
  onEdit: (name: string, cfg: MCPServerConfigDto) => void;
  onRemove: (name: string) => void;
}) {
  const globalEntries = Object.entries(globalServers);
  const privateEntries = Object.entries(privateServers);
  const disabledSet = new Set(disabled);
  return (
    <div className="grid gap-5">
      <div className="flex items-center gap-2">
        <Boxes className="size-4 text-ink-soft" />
        <Label className="m-0">MCP servers</Label>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Inherited from global catalog
          </span>
          <Link
            to="/settings"
            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft hover:text-plot-red"
          >
            Edit catalog
            <ExternalLink className="size-3" />
          </Link>
        </div>
        {globalEntries.length === 0 ? (
          <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
            No global servers configured. Add some in Settings → MCP, or define
            an agent-private server below.
          </p>
        ) : (
          <ul className="grid">
            {globalEntries.map(([name, cfg], idx) => {
              const inherited = !disabledSet.has(name);
              return (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => onToggleInherit(name)}
                    aria-pressed={inherited}
                    className={cn(
                      "group relative flex w-full items-center gap-3 border-paper-rule px-3 py-2 text-left transition-colors",
                      idx === 0 ? "border-t border-b" : "border-b",
                      inherited ? "bg-paper" : "bg-paper-sunk",
                    )}
                  >
                    <ActiveMarker active={inherited} />
                    <div
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center border",
                        inherited
                          ? "border-plot-red bg-plot-red text-paper"
                          : "border-paper-rule bg-paper",
                      )}
                    >
                      {inherited && (
                        <Check className="size-3" strokeWidth={3} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12px] text-ink">
                        {name}
                      </div>
                      <div className="truncate font-mono text-[11px] text-ink-faint">
                        {cfg.command
                          ? `${cfg.command}${cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : ""}`
                          : (cfg.url ?? "")}
                      </div>
                    </div>
                    {!inherited && <Badge variant="outline">Excluded</Badge>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Agent-private servers
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onAdd}>
            <Plus className="size-3.5" />
            Add private
          </Button>
        </div>
        {privateEntries.length === 0 ? (
          <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
            None. Add one only when you need a server scoped to this agent
            (e.g., a Notion MCP only this agent should use).
          </p>
        ) : (
          <ul className="grid">
            {privateEntries.map(([name, cfg], idx) => (
              <li
                key={name}
                className={cn(
                  "flex items-center gap-2 border-paper-rule px-3 py-2",
                  idx === 0 ? "border-t border-b" : "border-b",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px] text-ink">
                    {name}
                  </div>
                  <div className="truncate font-mono text-[11px] text-ink-faint">
                    {cfg.command
                      ? `${cfg.command}${cfg.args && cfg.args.length > 0 ? " " + cfg.args.join(" ") : ""}`
                      : (cfg.url ?? "")}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onEdit(name, cfg)}
                  aria-label="Edit"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onRemove(name)}
                  aria-label="Remove"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Tool picker ─────────────────────────────────────────────────────────────
function ToolPicker({
  groups,
  selected,
  onToggle,
  onSetGroup,
}: {
  groups: [string, ToolInfo[]][];
  selected: string[];
  onToggle: (name: string) => void;
  onSetGroup: (names: string[], checked: boolean) => void;
}) {
  if (groups.length === 0) {
    return (
      <div className="grid gap-2">
        <Label>Tools</Label>
        <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
          No tools registered on the server yet.
        </p>
      </div>
    );
  }
  const total = groups.reduce((acc, [, list]) => acc + list.length, 0);
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <Label>Tools</Label>
        <span className="font-mono text-[11px] tabular-nums text-ink-soft">
          {selected.length} / {total}
        </span>
      </div>
      <div className="space-y-4">
        {groups.map(([toolset, list]) => {
          const selectedInGroup = list.filter((t) =>
            selected.includes(t.name),
          ).length;
          const allSelected = selectedInGroup === list.length;
          return (
            <div key={toolset}>
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  {toolset}
                </span>
                {selectedInGroup > 0 && (
                  <span className="font-mono text-[10px] tabular-nums text-ink-faint">
                    ({selectedInGroup}/{list.length})
                  </span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    onSetGroup(
                      list.map((t) => t.name),
                      !allSelected,
                    )
                  }
                  className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline"
                >
                  {allSelected ? "Clear all" : "Select all"}
                </button>
              </div>
              <div className="grid grid-cols-1 gap-px md:grid-cols-2">
                {list.map((tool) => (
                  <ToolToggle
                    key={tool.name}
                    tool={tool}
                    checked={selected.includes(tool.name)}
                    onClick={() => onToggle(tool.name)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolToggle({
  tool,
  checked,
  onClick,
}: {
  tool: ToolInfo;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={checked}
      className={cn(
        "group relative flex items-start gap-3 border border-paper-rule px-3 py-2 text-left transition-colors",
        checked
          ? "bg-paper text-ink"
          : "bg-paper-sunk text-ink-soft hover:bg-paper hover:text-ink",
      )}
    >
      <ActiveMarker active={checked} />
      <div
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors",
          checked
            ? "border-plot-red bg-plot-red text-paper"
            : "border-paper-rule bg-paper",
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12px] text-ink">
          {tool.name}
        </div>
        <div className="line-clamp-2 text-[11px] text-ink-faint">
          {tool.description}
        </div>
      </div>
    </button>
  );
}

function ImportPreviewBlock({
  preview,
}: {
  template: CatalogTemplate;
  preview: CatalogPreview;
}) {
  const sizeOf = (b: number): string =>
    b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;

  type Row = { kind: string; name: string; detail: string };
  const rows: Row[] = [
    {
      kind: "Agent",
      name: preview.assignedId,
      detail: `~/.openacme/agents/${preview.assignedId}/`,
    },
    ...preview.agent.resourceFiles.map((r) => ({
      kind: "Resource",
      name: r.relPath,
      detail: `${sizeOf(r.size)} · agent's resources/`,
    })),
    ...preview.workforce.skills.map((s) => ({
      kind: "Skill",
      name: s.name,
      detail: "workforce",
    })),
    ...preview.workforce.mcpServers.map((m) => ({
      kind: "MCP",
      name: m.name,
      detail: "workforce",
    })),
  ];

  return (
    <Card className="border-paper-rule">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">This template installs</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 font-mono text-[12px]">
          {rows.map((r, i) => (
            <li
              key={`${r.kind}-${r.name}-${i}`}
              className="grid grid-cols-[5rem_minmax(0,1fr)_auto] items-baseline gap-3"
            >
              <span className="text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                {r.kind}
              </span>
              <span className="truncate text-ink">{r.name}</span>
              <span className="text-ink-faint">{r.detail}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function EmptyWorkforceState({ onCreate }: { onCreate: () => void }) {
  const rowDelay = (i: number) => 80 + i * 120;
  return (
    <div className="mx-auto max-w-6xl">
      <SectionEyebrow meta="0 agents">The workforce is empty</SectionEyebrow>

      <div className="mt-6 border border-dashed border-paper-rule paper-surface opacity-80">
        {/* Faux dossier — visual demonstration of an AGENT.md. Every row
         * is real mono with real metadata shape so the operator reads
         * the format off the page, not off external docs. */}
        <div
          className="border-b border-paper-rule px-4 py-3"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: `${rowDelay(0)}ms`,
          }}
        >
          <div className="label-faceplate mb-2 text-ink-faint">Preview</div>
          <div className="font-mono text-[12px] uppercase tracking-[0.06em] text-ink">
            example-agent
          </div>
          <div className="mt-1 meta-row">your agent · not yet created</div>
        </div>

        <div
          className="border-b border-paper-rule px-4 py-3 meta-row"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: `${rowDelay(1)}ms`,
          }}
        >
          <span className="text-ink-faint">model · </span>
          <span className="text-ink">anthropic/claude-sonnet-4-20250514</span>
        </div>

        <div
          className="border-b border-paper-rule px-4 py-3"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: `${rowDelay(2)}ms`,
          }}
        >
          <div className="label-faceplate mb-1">Persona</div>
          <div className="text-[13px] leading-snug text-ink-soft">
            A short paragraph describing what this coworker does, the tone they
            take, and what they shouldn&apos;t touch.
          </div>
        </div>

        <div
          className="border-b border-paper-rule px-4 py-3 meta-row flex items-center gap-4"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: `${rowDelay(3)}ms`,
          }}
        >
          <span>
            <span className="text-ink-faint">tools · </span>
            <span className="text-ink">12</span>
          </span>
          <span>
            <span className="text-ink-faint">mcp · </span>
            <span className="text-ink">3</span>
          </span>
          <span>
            <span className="text-ink-faint">skills · </span>
            <span className="text-ink">2</span>
          </span>
        </div>

        <div
          className="px-4 py-3 flex items-center gap-2"
          style={{
            animation: "section-enter 320ms var(--ease-out-quart) both",
            animationDelay: `${rowDelay(4)}ms`,
          }}
        >
          <span aria-hidden className="status-dot bg-ink" />
          <span className="label-faceplate">Ready</span>
        </div>
      </div>

      {/* Teaching caption — instrument-register, not marketing. Tells the
       * operator where files live in one sentence. */}
      <div
        className="mt-5 text-[13px] leading-relaxed text-ink-soft"
        style={{
          animation: "section-enter 320ms var(--ease-out-quart) both",
          animationDelay: `${rowDelay(5)}ms`,
        }}
      >
        This is the shape of an agent. Yours will live at{" "}
        <code className="px-1 py-0.5 font-mono text-[12px] text-ink">
          ~/.openacme/agents/&lt;id&gt;/AGENT.md
        </code>{" "}
        — YAML frontmatter for model, tools, and MCP servers, plus prose for the
        persona.
      </div>

      <div
        className="mt-5"
        style={{
          animation: "section-enter 320ms var(--ease-out-quart) both",
          animationDelay: `${rowDelay(6)}ms`,
        }}
      >
        <Button onClick={onCreate}>
          <Plus className="size-4" />
          Create your first agent
        </Button>
      </div>
    </div>
  );
}

function NoAgentPicked() {
  return (
    <div className="mx-auto max-w-6xl">
      <SectionEyebrow>Select an agent</SectionEyebrow>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
        Pick a row from the roster to view its model, persona, tools, and
        resources.
      </p>
    </div>
  );
}

// ─── Read-only detail view ───────────────────────────────────────────────────
interface AgentDraft {
  name: string;
  avatar: string;
  role: string;
  persona: string;
  provider: string;
  model: string;
  auth: "api_key" | "oauth";
  cacheTtl: CacheTtl;
}

function draftFromAgent(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    avatar: agent.avatar ?? "",
    role: agent.role ?? "",
    persona: agent.persona,
    provider: agent.model.provider,
    model: agent.model.model,
    auth: agent.model.auth ?? "api_key",
    cacheTtl: agent.model.cacheTtl ?? "5m",
  };
}

function AgentDetail({
  agent,
  providers,
  globalServers,
  allSkills,
  toolGroups,
  tab,
  onTabChange,
  onAgentUpdated,
  onDelete,
}: {
  agent: Agent;
  providers: ProviderInfo[];
  globalServers: Record<string, MCPServerConfigDto>;
  allSkills: SkillIndexEntry[];
  toolGroups: [string, ToolInfo[]][];
  tab: AgentTab;
  onTabChange: (tab: AgentTab) => void;
  onAgentUpdated: (updated: Agent) => void;
  onDelete: () => void;
}) {
  // View-is-the-editor: the Overview fields edit a shared draft; this
  // one header Save covers name/avatar/model/role/persona together.
  const [draft, setDraft] = useState<AgentDraft>(() => draftFromAgent(agent));
  useEffect(() => {
    setDraft(draftFromAgent(agent));
  }, [agent]);
  const { saving, save } = useSliceSave(agent, onAgentUpdated);
  const saved = draftFromAgent(agent);
  // Managed locks identity (name/avatar/role/persona) but model stays
  // editable — dirty and the save payload track only what's allowed.
  const dirty = agent.managed
    ? draft.provider !== saved.provider ||
      draft.model !== saved.model ||
      draft.auth !== saved.auth ||
      draft.cacheTtl !== saved.cacheTtl
    : JSON.stringify(draft) !== JSON.stringify(saved);
  // Detail is ruled sections on the pane, not a floating card — one shared
  // measure with the skills + tasks detail panes.
  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-row items-start justify-between gap-4 pb-2">
        <div className="min-w-0 flex-1">
          {/* Notion-style identity: avatar is the emoji picker, the title
              is the name field — no separate Name/Avatar form inputs. */}
          <div className="flex flex-wrap items-center gap-2">
            {agent.managed ? (
              <CardTitle className="text-xl">
                {agent.avatar && (
                  <AgentAvatar
                    avatar={agent.avatar}
                    size="xl"
                    className="mr-2 align-[-2px]"
                  />
                )}
                {agent.name}
              </CardTitle>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <AvatarField
                  value={draft.avatar}
                  onChange={(v) => setDraft({ ...draft, avatar: v })}
                />
                <input
                  aria-label="Agent name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Agent name"
                  className="w-full min-w-0 flex-1 border-0 bg-transparent px-0 text-xl font-semibold leading-snug text-ink outline-none placeholder:text-ink-faint"
                />
              </div>
            )}
            {agent.managed && (
              <Badge variant="outline" className="font-mono text-[11px]">
                Managed by OpenAcme
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] tabular-nums text-ink-faint">
              {agent.id}
            </span>
            <span className="text-ink-faint">·</span>
            <span className="font-mono text-[11px] tabular-nums text-ink-soft">
              {agent.model.provider}/{agent.model.model}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" asChild>
            <Link to="/" search={{ agent: agent.id }}>
              <MessageSquarePlus className="size-4" />
              New chat
            </Link>
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => {
              const model = {
                provider: draft.provider,
                model: draft.model,
                auth: draft.auth,
                cacheTtl: draft.cacheTtl,
              };
              void save(
                agent.managed
                  ? { model }
                  : {
                      name: draft.name,
                      avatar: draft.avatar,
                      role: draft.role,
                      persona: draft.persona,
                      model,
                    },
                "Agent"
              );
            }}
          >
            <Save className="size-4" />
            Save
          </Button>
          {!agent.managed && (
            <Button variant="ghost-destructive" size="sm" onClick={onDelete}>
              <Trash2 className="size-4" />
              Delete
            </Button>
          )}
        </div>
      </div>
      <Tabs
        value={tab}
        onValueChange={(v) => onTabChange(v as AgentTab)}
        className="mt-1"
      >
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tools">
            Tools
            <span className="tabular-nums text-ink-faint">
              {agent.tools.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="mcp">MCP</TabsTrigger>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="resources">Resources</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <AgentOverviewTab
            agent={agent}
            providers={providers}
            draft={draft}
            onDraftChange={setDraft}
          />
        </TabsContent>
        <TabsContent value="tools">
          <AgentToolsTab
            agent={agent}
            groups={toolGroups}
            onSaved={onAgentUpdated}
          />
        </TabsContent>
        <TabsContent value="skills">
          <AgentSkillsTab
            agent={agent}
            allSkills={allSkills}
            onSaved={onAgentUpdated}
          />
        </TabsContent>
        <TabsContent value="mcp">
          <AgentMcpTab
            agent={agent}
            globalServers={globalServers}
            onSaved={onAgentUpdated}
          />
        </TabsContent>
        <TabsContent value="workspace">
          <FileWorkbench
            root={{ kind: "agent", id: agent.id, scope: "workspace" }}
          />
        </TabsContent>
        <TabsContent value="resources">
          <FileWorkbench
            root={{ kind: "agent", id: agent.id, scope: "resources" }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AgentOverviewTab({
  agent,
  providers,
  draft,
  onDraftChange,
}: {
  agent: Agent;
  providers: ProviderInfo[];
  draft: AgentDraft;
  onDraftChange: (next: AgentDraft) => void;
}) {
  // Persona prose references files ("use template.json") — linkify the
  // spans that resolve under the agent's roots, same as chat.
  const linkOwner = useMemo(
    () => ({ kind: "agent", id: agent.id }) as const,
    [agent.id],
  );
  const linkSources = useMemo(
    () => [{ id: agent.id, text: agent.persona }],
    [agent.id, agent.persona],
  );
  const fileLinks = useFileLinkResolver(linkOwner, linkSources);
  const [previewTarget, setPreviewTarget] =
    useState<FilePreviewTarget | null>(null);

  // Same field set + order as the create form — view and edit are one
  // surface; the header Save commits the shared draft. max-w keeps
  // persona prose at a readable measure on wide panes.
  return (
    <>
      <div className="max-w-4xl space-y-5 py-5">
        <ModelConfigFields
          providers={providers}
          idPrefix={`ov-${agent.id}`}
          value={{
            provider: draft.provider,
            model: draft.model,
            auth: draft.auth,
            cacheTtl: draft.cacheTtl,
          }}
          onChange={(m) => onDraftChange({ ...draft, ...m })}
        />

        {!agent.managed && <AgentEmailPanel agentId={agent.id} />}

        <div className="grid gap-2">
          <Label htmlFor="ov-role">
            Role
            <span className="ml-2 font-normal text-ink-faint">
              visible to other agents
            </span>
            {agent.managed && <ManagedFieldHint />}
          </Label>
          {/* Prose fields read as document, not form — chrome only while
              focused (underline), never a full box. */}
          <textarea
            id="ov-role"
            value={draft.role}
            disabled={agent.managed}
            onChange={(e) => onDraftChange({ ...draft, role: e.target.value })}
            rows={3}
            placeholder="Owns X. Good for Y. Redirects Z to @other-agent."
            className="field-sizing-content w-full resize-none border-0 border-b border-transparent bg-transparent px-0 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-b-plot-red disabled:cursor-default disabled:text-ink-soft"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="ov-persona">
            Persona
            {agent.managed && <ManagedFieldHint />}
          </Label>
          {agent.managed ? (
            <div className="min-w-0 break-words text-[13px] leading-relaxed text-ink-soft">
              <Markdown fileLinks={fileLinks} onOpenFile={setPreviewTarget}>
                {agent.persona}
              </Markdown>
            </div>
          ) : (
            <MarkdownEditor
              value={draft.persona}
              onChange={(persona) => onDraftChange({ ...draft, persona })}
              placeholder="You are… — type / for blocks"
              contentClassName="min-h-[240px]"
            />
          )}
        </div>
      </div>
      <FilePreviewDialog
        target={previewTarget}
        onClose={() => setPreviewTarget(null)}
      />
    </>
  );
}

/** Inline "platform-owned" marker on locked fields of managed agents. */
function ManagedFieldHint() {
  return (
    <span className="ml-2 font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-ink-faint">
      managed
    </span>
  );
}

interface ModelConfigValue {
  provider: string;
  model: string;
  auth: "api_key" | "oauth";
  cacheTtl: CacheTtl;
}

/** Provider / model / auth / cache-TTL pickers — one surface shared by the
 *  create form and the always-editable agent Overview, so viewing and
 *  editing an agent never look different. */
function ModelConfigFields({
  providers,
  value,
  onChange,
  idPrefix,
}: {
  providers: ProviderInfo[];
  value: ModelConfigValue;
  onChange: (next: ModelConfigValue) => void;
  idPrefix: string;
}) {
  const currentProvider = providers.find((p) => p.id === value.provider);
  const presets: ModelPreset[] = currentProvider?.models ?? [];
  // Derived, not latched: `providers` loads async, so a mount-time
  // snapshot would strand a preset model in custom mode. Explicit custom
  // is only the user's "Custom model id…" pick.
  const [explicitCustom, setExplicitCustom] = useState(false);
  const inPresets = presets.some((m) => m.id === value.model);
  const customMode =
    explicitCustom ||
    presets.length === 0 ||
    (!inPresets && value.model !== "");

  // Mirrors the OpenRouter Claude detection in @openacme/llm-provider.
  const isClaudeModel =
    value.provider === "anthropic" ||
    (value.provider === "openrouter" &&
      (value.model.toLowerCase().startsWith("anthropic/") ||
        value.model.toLowerCase().includes("claude")));

  const onProviderChange = (provider: string) => {
    const nextProvider = providers.find((p) => p.id === provider);
    const newPresets = nextProvider?.models ?? [];
    const stillValid = newPresets.some((m) => m.id === value.model);
    const supportsOAuth = nextProvider?.supportsOAuth === true;
    onChange({
      ...value,
      provider,
      model: stillValid ? value.model : (newPresets[0]?.id ?? ""),
      auth: value.auth === "oauth" && !supportsOAuth ? "api_key" : value.auth,
    });
    if (stillValid || newPresets.length > 0) setExplicitCustom(false);
  };

  const onModelSelect = (picked: string) => {
    // Radix fires onValueChange("") when the current value drops out of
    // the option set mid-update; our items never carry "" so ignore it.
    if (!picked) return;
    if (picked === CUSTOM_MODEL) {
      onChange({ ...value, model: "" });
      setExplicitCustom(true);
    } else {
      onChange({ ...value, model: picked });
      setExplicitCustom(false);
    }
  };

  const modelSelectValue = customMode
    ? CUSTOM_MODEL
    : value.model || (presets[0]?.id ?? CUSTOM_MODEL);

  const supportsOAuth = currentProvider?.supportsOAuth === true;
  const apiKeyConfigured = currentProvider?.apiKeyConfigured === true;
  const oauthConfigured = currentProvider?.oauthConfigured === true;

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-provider`}>Provider</Label>
        <Select value={value.provider} onValueChange={onProviderChange}>
          <SelectTrigger id={`${idPrefix}-provider`}>
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
        <Label htmlFor={`${idPrefix}-model`}>Model</Label>
        {presets.length > 0 && (
          <Select value={modelSelectValue} onValueChange={onModelSelect}>
            <SelectTrigger id={`${idPrefix}-model`}>
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {presets.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <div className="flex flex-col items-start">
                    <span>{m.label}</span>
                    {m.hint && (
                      <span className="text-[10px] text-ink-soft">
                        {m.hint}
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_MODEL}>
                <span className="text-ink-soft">Custom model id…</span>
              </SelectItem>
            </SelectContent>
          </Select>
        )}
        {(customMode || presets.length === 0) && (
          <Input
            id={`${idPrefix}-model-custom`}
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
            placeholder="Enter model id"
            className="font-mono text-xs"
            required
          />
        )}
      </div>

      {/* Authentication — OAuth hidden when the selected provider doesn't
          support it; sign-in itself lives in Settings. */}
      {currentProvider && (
        <div className="grid gap-2 md:col-span-2">
          <Label>Authentication</Label>
          <RadioGroup
            value={value.auth}
            onValueChange={(v) =>
              onChange({ ...value, auth: v as "api_key" | "oauth" })
            }
          >
            <label
              htmlFor={`${idPrefix}-auth-api_key`}
              className="flex items-start gap-2 text-sm cursor-pointer"
            >
              <RadioGroupItem
                value="api_key"
                id={`${idPrefix}-auth-api_key`}
                className="mt-1"
              />
              <span className="flex-1">
                <span>API key</span>
                <span className="ml-2 font-mono text-[11px] text-ink-faint">
                  {apiKeyConfigured
                    ? "configured"
                    : currentProvider.envVar
                      ? `not configured (set ${currentProvider.envVar})`
                      : "no key needed"}
                </span>
              </span>
            </label>
            {supportsOAuth && (
              <label
                htmlFor={`${idPrefix}-auth-oauth`}
                className="flex items-start gap-2 text-sm cursor-pointer"
              >
                <RadioGroupItem
                  value="oauth"
                  id={`${idPrefix}-auth-oauth`}
                  className="mt-1"
                />
                <span className="flex-1">
                  <span>OAuth subscription</span>
                  <span className="ml-2 font-mono text-[11px] text-ink-faint">
                    {oauthConfigured ? "signed in" : "not signed in"}
                  </span>
                  {!oauthConfigured && (
                    <a
                      href="/settings"
                      className="ml-2 text-[11px] text-plot-red underline hover:no-underline"
                    >
                      Set up in Settings
                    </a>
                  )}
                </span>
              </label>
            )}
          </RadioGroup>
        </div>
      )}

      {isClaudeModel && (
        <div className="grid gap-2 md:col-span-2">
          <Label htmlFor={`${idPrefix}-cacheTtl`}>Prompt cache TTL</Label>
          <Select
            value={value.cacheTtl}
            onValueChange={(v) => onChange({ ...value, cacheTtl: v as CacheTtl })}
          >
            <SelectTrigger id={`${idPrefix}-cacheTtl`} className="md:max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5m">5 minutes (default)</SelectItem>
              <SelectItem value="1h">1 hour</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

/** Save/discard affordance shared by the per-slice config tabs. Renders
 *  nothing until the local draft diverges from the saved agent. */
function ConfigSaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!dirty) return null;
  return (
    <div className="mt-4 flex items-center gap-2 border-t border-paper-rule pt-3">
      <Button size="sm" disabled={saving} onClick={onSave}>
        <Save className="size-4" />
        Save changes
      </Button>
      <Button size="sm" variant="ghost" disabled={saving} onClick={onDiscard}>
        Discard
      </Button>
    </div>
  );
}

async function putAgentSlice(
  agentId: string,
  slice: Record<string, unknown>
): Promise<Agent> {
  const res = await fetch(
    `${API_BASE}/api/agents/${encodeURIComponent(agentId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slice),
    }
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || res.statusText);
  }
  return (await res.json()) as Agent;
}

function useSliceSave(
  agent: Agent,
  onSaved: (updated: Agent) => void
): {
  saving: boolean;
  save: (slice: Record<string, unknown>, label: string) => Promise<boolean>;
} {
  const [saving, setSaving] = useState(false);
  const save = async (slice: Record<string, unknown>, label: string) => {
    setSaving(true);
    try {
      const updated = await putAgentSlice(agent.id, slice);
      onSaved(updated);
      toast.success(`${label} updated`);
      return true;
    } catch (err) {
      toast.error(`Failed to update ${label.toLowerCase()}`, {
        description: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { saving, save };
}

function setGroupSelection(
  current: string[],
  names: string[],
  checked: boolean,
): string[] {
  if (!checked) return current.filter((t) => !names.includes(t));
  return [...current, ...names.filter((n) => !current.includes(n))];
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function AgentToolsTab({
  agent,
  groups,
  onSaved,
}: {
  agent: Agent;
  groups: [string, ToolInfo[]][];
  onSaved: (updated: Agent) => void;
}) {
  const [selected, setSelected] = useState<string[]>(agent.tools);
  useEffect(() => {
    setSelected(agent.tools);
  }, [agent.id, agent.tools]);
  const { saving, save } = useSliceSave(agent, onSaved);

  if (agent.managed) {
    return (
      <div className="py-2">
        <p className="mb-3 font-mono text-[12px] text-ink-faint">
          Platform-managed — tools are owned by the bundled template.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {agent.tools.map((t) => (
            <Badge key={t} variant="outline" className="font-mono text-[11px]">
              {t}
            </Badge>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="py-2">
      <ToolPicker
        groups={groups}
        selected={selected}
        onToggle={(name) =>
          setSelected((prev) =>
            prev.includes(name)
              ? prev.filter((t) => t !== name)
              : [...prev, name]
          )
        }
        onSetGroup={(names, checked) =>
          setSelected((prev) => setGroupSelection(prev, names, checked))
        }
      />
      <ConfigSaveBar
        dirty={!sameStringSet(selected, agent.tools)}
        saving={saving}
        onSave={() => void save({ tools: selected }, "Tools")}
        onDiscard={() => setSelected(agent.tools)}
      />
    </div>
  );
}

function AgentSkillsTab({
  agent,
  allSkills,
  onSaved,
}: {
  agent: Agent;
  allSkills: SkillIndexEntry[];
  onSaved: (updated: Agent) => void;
}) {
  const savedSkills = useMemo(() => agent.skills ?? [], [agent.skills]);
  const [selected, setSelected] = useState<string[]>(savedSkills);
  useEffect(() => {
    setSelected(savedSkills);
  }, [agent.id, savedSkills]);
  const { saving, save } = useSliceSave(agent, onSaved);

  if (agent.managed) {
    return (
      <div className="py-2">
        <p className="mb-3 font-mono text-[12px] text-ink-faint">
          Platform-managed — the skill allowlist is owned by the bundled
          template.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {savedSkills.length === 0 ? (
            <p className="font-mono text-[12px] text-ink-faint">
              All workforce skills visible.
            </p>
          ) : (
            savedSkills.map((s) => (
              <Badge key={s} variant="outline" className="font-mono text-[11px]">
                {s}
              </Badge>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="py-2">
      <SkillsPicker
        all={allSkills}
        selected={selected}
        onToggle={(name) =>
          setSelected((prev) =>
            prev.includes(name)
              ? prev.filter((s) => s !== name)
              : [...prev, name]
          )
        }
      />
      <ConfigSaveBar
        dirty={!sameStringSet(selected, savedSkills)}
        saving={saving}
        onSave={() => void save({ skills: selected }, "Skills")}
        onDiscard={() => setSelected(savedSkills)}
      />
    </div>
  );
}

function AgentMcpTab({
  agent,
  globalServers,
  onSaved,
}: {
  agent: Agent;
  globalServers: Record<string, MCPServerConfigDto>;
  onSaved: (updated: Agent) => void;
}) {
  const savedServers = useMemo(
    () => agent.mcpServers ?? {},
    [agent.mcpServers]
  );
  const savedDisabled = useMemo(
    () => agent.mcpDisabled ?? [],
    [agent.mcpDisabled]
  );
  const [servers, setServers] =
    useState<Record<string, MCPServerConfigDto>>(savedServers);
  const [disabled, setDisabled] = useState<string[]>(savedDisabled);
  const [dialog, setDialog] = useState<
    { mode: "add" } | { mode: "edit"; initial: MCPServerFormValue } | null
  >(null);
  useEffect(() => {
    setServers(savedServers);
    setDisabled(savedDisabled);
  }, [agent.id, savedServers, savedDisabled]);
  const { saving, save } = useSliceSave(agent, onSaved);

  const dirty =
    !sameStringSet(disabled, savedDisabled) ||
    JSON.stringify(servers) !== JSON.stringify(savedServers);

  const handleTest = async (
    value: MCPServerFormValue
  ): Promise<{
    ok: boolean;
    error?: string;
    tools?: string[];
    transport?: string;
  }> => {
    const res = await fetch(`${API_BASE}/api/mcp/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value.config),
    });
    return (await res.json()) as {
      ok: boolean;
      error?: string;
      tools?: string[];
      transport?: string;
    };
  };

  if (agent.managed) {
    return (
      <div className="py-2">
        <p className="font-mono text-[12px] text-ink-faint">
          Platform-managed — MCP servers are owned by the bundled template.
        </p>
      </div>
    );
  }

  return (
    <div className="py-2">
      <McpSection
        globalServers={globalServers}
        privateServers={servers}
        disabled={disabled}
        onToggleInherit={(name) =>
          setDisabled((prev) =>
            prev.includes(name)
              ? prev.filter((n) => n !== name)
              : [...prev, name]
          )
        }
        onAdd={() => setDialog({ mode: "add" })}
        onEdit={(name, cfg) =>
          setDialog({ mode: "edit", initial: { name, config: cfg } })
        }
        onRemove={(name) =>
          setServers((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
          })
        }
      />
      <ConfigSaveBar
        dirty={dirty}
        saving={saving}
        onSave={() =>
          void save({ mcpServers: servers, mcpDisabled: disabled }, "MCP")
        }
        onDiscard={() => {
          setServers(savedServers);
          setDisabled(savedDisabled);
        }}
      />

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === "edit"
                ? `Edit '${dialog.initial.name}'`
                : "Add agent-private MCP server"}
            </DialogTitle>
            <DialogDescription>
              Private to this agent only. Names cannot collide with the global
              catalog in Settings → MCP.
            </DialogDescription>
          </DialogHeader>
          {dialog && (
            <DialogBody>
              <MCPServerForm
                initial={dialog.mode === "edit" ? dialog.initial : undefined}
                lockName={dialog.mode === "edit"}
                reservedNames={[
                  ...Object.keys(globalServers),
                  ...(dialog.mode === "add" ? Object.keys(servers) : []),
                ]}
                onSubmit={(value) => {
                  setServers((prev) => ({
                    ...prev,
                    [value.name]: value.config,
                  }));
                  setDialog(null);
                }}
                onCancel={() => setDialog(null)}
                onTest={handleTest}
              />
            </DialogBody>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Skills picker (form) ─────────────────────────────────────────────────────
function SkillsPicker({
  all,
  selected,
  onToggle,
}: {
  all: SkillIndexEntry[];
  selected: string[];
  onToggle: (name: string) => void;
}) {
  if (all.length === 0) {
    return (
      <div className="grid gap-2">
        <Label className="flex items-center gap-2">
          <BookOpen className="size-3.5 text-ink-soft" />
          Skills
        </Label>
        <p className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink-soft">
          No skills installed.{" "}
          <Link to="/skills" className="text-plot-red hover:underline">
            Add some
          </Link>{" "}
          and they&apos;ll appear here.
        </p>
      </div>
    );
  }
  // Selected empty == inherit-all. Surface that explicitly so the picker
  // doesn't look broken when the agent's set is "unconfigured" but
  // every skill still applies.
  const inheritAll = selected.length === 0;
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2">
          <BookOpen className="size-3.5 text-ink-soft" />
          Skills
        </Label>
        <span className="font-mono text-[11px] tabular-nums text-ink-soft">
          {inheritAll
            ? `all (${all.length})`
            : `${selected.length} / ${all.length}`}
        </span>
      </div>
      {inheritAll && (
        <p className="font-mono text-[11px] text-ink-faint">
          Empty selection means the agent sees every installed skill. Pick one
          or more to scope it down.
        </p>
      )}
      <div className="grid grid-cols-1 gap-px md:grid-cols-2">
        {all.map((skill) => {
          const checked = selected.includes(skill.name);
          return (
            <button
              key={skill.name}
              type="button"
              onClick={() => onToggle(skill.name)}
              aria-pressed={checked}
              className={cn(
                "group relative flex items-start gap-3 border border-paper-rule px-3 py-2 text-left transition-colors",
                checked
                  ? "bg-paper text-ink"
                  : "bg-paper-sunk text-ink-soft hover:bg-paper hover:text-ink",
              )}
            >
              <ActiveMarker active={checked} />
              <div
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors",
                  checked
                    ? "border-plot-red bg-plot-red text-paper"
                    : "border-paper-rule bg-paper",
                )}
              >
                {checked && <Check className="size-3" strokeWidth={3} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12px] text-ink">
                  {skill.name}
                </div>
                <div className="line-clamp-2 text-[11px] text-ink-faint">
                  {skill.description}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
