import { useState, useEffect, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import {
  Plus,
  Search,
  Trash2,
  BookOpen,
  Compass,
  Pipette,
  Save,
  X,
} from "lucide-react";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { ActiveMarker } from "@/app/components/ui/active-marker";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import { usePublishCurrentView } from "@/app/lib/CurrentViewContext";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Badge } from "@/app/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import { Skeleton } from "@/app/components/ui/skeleton";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/app/components/ui/tabs";
import { cn } from "@/app/lib/utils";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { FileWorkbench } from "../files/FileWorkbench";
import { BrowseTab } from "../skills/browse-tab";
import { SourcesTab } from "../skills/sources-tab";

interface SkillIndexEntry {
  name: string;
  description: string;
  tags: string[];
}

interface SkillResource {
  relPath: string;
  size: number;
}

interface Skill {
  name: string;
  description: string;
  tags: string[];
  body: string;
  relatedSkills: string[];
  resources?: SkillResource[];
  dirPath?: string;
}

export const Route = createFileRoute("/skills")({
  validateSearch: z.object({
    name: z.coerce.string().optional(),
    create: z.coerce.string().optional(),
  }),
  component: SkillsPage,
});

function SkillsPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const urlName = search.name ?? null;
  const urlCreate = search.create === "1";

  const [skills, setSkills] = useState<SkillIndexEntry[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"skills" | "browse" | "sources">("skills");

  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    tags: "",
    body: "",
  });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  usePublishCurrentView(
    useMemo(
      () => ({
        page: "/skills",
        entityType: "skill" as const,
        entityId: isCreating ? null : selectedSkill?.name ?? null,
        tab: activeTab,
        content: isCreating ? formData : selectedSkill,
      }),
      [selectedSkill, isCreating, formData, activeTab]
    )
  );

  useEffect(() => {
    const ctrl = new AbortController();
    loadSkills(ctrl.signal);
    return () => ctrl.abort();
  }, []);

  // ?name=<name> selects a skill; ?create=1 opens the create form.
  useEffect(() => {
    if (urlCreate) {
      setIsCreating(true);
      setSelectedSkill(null);
      return;
    }
    if (urlName) {
      setIsCreating(false);
      loadSkillDetail(urlName);
      return;
    }
    setIsCreating(false);
    setSelectedSkill(null);
  }, [urlName, urlCreate]);

  const loadSkills = async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/skills`, { signal });
      if (res.ok) {
        const data = await res.json();
        setSkills(data);
      } else {
        toast.error("Failed to load skills");
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load skills", { description: "Is the server running?" });
    } finally {
      setLoading(false);
    }
  };

  const loadSkillDetail = async (name: string) => {
    setIsCreating(false);
    try {
      const res = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(name)}`);
      if (res.ok) {
        setSelectedSkill(await res.json());
      } else {
        toast.error("Failed to load skill details");
      }
    } catch {
      toast.error("Failed to load skill details");
    }
  };

  const createSkill = async () => {
    if (!formData.name.trim() || !formData.description.trim()) {
      toast.error("Name and description are required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim(),
          tags: formData.tags.split(",").map((t) => t.trim()).filter(Boolean),
          body: formData.body,
        }),
      });
      if (res.ok) {
        toast.success("Skill created");
        const createdName = formData.name.trim();
        setFormData({ name: "", description: "", tags: "", body: "" });
        loadSkills();
        void navigate({ to: "/skills", search: { name: createdName } });
      } else {
        const data = await res.json();
        toast.error("Failed to create skill", { description: data.error });
      }
    } catch {
      toast.error("Failed to create skill");
    } finally {
      setSaving(false);
    }
  };

  const deleteSkill = async (name: string) => {
    setConfirmDelete(null);
    try {
      const res = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Skill deleted");
        loadSkills();
        void navigate({ to: "/skills" });
      } else {
        toast.error("Failed to delete skill");
      }
    } catch {
      toast.error("Failed to delete skill");
    }
  };

  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [skills, searchQuery]);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    skills.forEach((s) => s.tags.forEach((t) => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [skills]);

  const installedNames = useMemo(
    () => new Set(skills.map((s) => s.name)),
    [skills]
  );

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-3 md:px-6">
          <div className="flex items-center gap-2 md:gap-3">
            <h1 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Skills
            </h1>
          </div>
          {activeTab === "skills" && (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void navigate({ to: "/skills", search: { create: "1" } })}>
                <Plus className="size-4" />
                <span className="hidden sm:inline">New skill</span>
              </Button>
            </div>
          )}
        </header>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "skills" | "browse" | "sources")}
          className="flex flex-1 flex-col overflow-hidden"
        >
          {/* Full-bleed bar: the border-b runs edge-to-edge so it meets the
              header rule above and the index rail's border-r below. Triggers
              start at the page gutter. */}
          <TabsList className="h-10 shrink-0 pl-3 md:pl-6">
            <TabsTrigger value="skills">
              <BookOpen className="size-3.5" />
              Installed
            </TabsTrigger>
            <TabsTrigger value="browse">
              <Compass className="size-3.5" />
              Browse
            </TabsTrigger>
            <TabsTrigger value="sources">
              <Pipette className="size-3.5" />
              Sources
            </TabsTrigger>
          </TabsList>

          <TabsContent value="skills" className="flex flex-1 flex-col overflow-hidden m-0 pt-0 md:flex-row">
          {/* On mobile we stack: index, then detail. To avoid showing two
              panes squished side-by-side we hide the index when a skill is
              picked, and the detail offers a back link to return. Desktop
              keeps the side-by-side layout. */}
          <aside
            className={cn(
              "flex shrink-0 flex-col border-paper-rule md:w-80 md:border-r",
              selectedSkill || isCreating
                ? "hidden md:flex"
                : "flex border-b md:border-b-0"
            )}
          >
            <div className="border-b border-paper-rule p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search skills"
                  className="pl-8"
                />
              </div>
              {allTags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {allTags.slice(0, 8).map((tag) => (
                    <button
                      key={tag}
                      onClick={() =>
                        setSearchQuery((s) => (s === tag ? "" : tag))
                      }
                    >
                      <Badge
                        variant={searchQuery === tag ? "signal" : "outline"}
                        className="cursor-pointer"
                      >
                        {tag}
                      </Badge>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {loading && (
                <div className="space-y-2 p-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              )}

              {!loading && filteredSkills.length === 0 && (
                <div className="px-4 py-6 font-mono text-[12px] text-ink-faint">
                  {skills.length === 0
                    ? "No skills loaded."
                    : "No matches."}
                </div>
              )}

              {!loading &&
                filteredSkills.map((skill) => {
                  const isActive = selectedSkill?.name === skill.name;
                  return (
                    <button
                      key={skill.name}
                      onClick={() => void navigate({ to: "/skills", search: { name: skill.name } })}
                      className={cn(
                        "group relative flex w-full flex-col items-start gap-0.5 border-b border-paper-rule/40 px-4 py-2.5 text-left transition-colors last:border-b-0",
                        isActive
                          ? "bg-paper-sunk text-ink"
                          : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
                      )}
                    >
                      <ActiveMarker active={isActive} />
                      <span className="truncate font-mono text-[13px] text-ink w-full">
                        {skill.name}
                      </span>
                      <span className="line-clamp-2 text-[12px] text-ink-faint">
                        {skill.description}
                      </span>
                    </button>
                  );
                })}
            </div>
          </aside>

          <div
            className={cn(
              "flex-1 overflow-y-auto p-4 md:p-6",
              !selectedSkill && !isCreating ? "hidden md:block" : ""
            )}
          >
            {(selectedSkill || isCreating) && (
              <button
                type="button"
                onClick={() => void navigate({ to: "/skills" })}
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
                Back to index
              </button>
            )}
            {isCreating ? (
              <Card className="mx-auto max-w-5xl">
                <CardHeader>
                  <CardTitle>Create skill</CardTitle>
                  <CardDescription>
                    Skills are markdown documents agents can dynamically load.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="grid gap-2">
                    <Label htmlFor="skill-name">Name</Label>
                    <Input
                      id="skill-name"
                      value={formData.name}
                      onChange={(e) =>
                        setFormData({ ...formData, name: e.target.value })
                      }
                      placeholder="my-skill"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="skill-desc">Description</Label>
                    <Input
                      id="skill-desc"
                      value={formData.description}
                      onChange={(e) =>
                        setFormData({ ...formData, description: e.target.value })
                      }
                      placeholder="What this skill does"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="skill-tags">Tags (comma-separated)</Label>
                    <Input
                      id="skill-tags"
                      value={formData.tags}
                      onChange={(e) =>
                        setFormData({ ...formData, tags: e.target.value })
                      }
                      placeholder="automation, testing"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="skill-body">Instructions (Markdown)</Label>
                    <div className="border border-paper-rule bg-paper px-3 py-2 transition-colors focus-within:border-plot-red">
                      <MarkdownEditor
                        value={formData.body}
                        onChange={(body) => setFormData({ ...formData, body })}
                        placeholder="Detailed instructions for the agent…"
                        contentClassName="min-h-[280px]"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" onClick={() => void navigate({ to: "/skills" })}>
                      Cancel
                    </Button>
                    <Button onClick={createSkill} disabled={saving}>
                      {saving && <LoadingHairline inline />}
                      Create skill
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : selectedSkill ? (
              // Ruled sections on the pane, not a floating card — same
              // measure + treatment as the agents + tasks detail panes.
              <SkillDetailPanel
                skill={selectedSkill}
                onDeleteClick={() => setConfirmDelete(selectedSkill.name)}
                onPickRelated={(name) =>
                  void navigate({ to: "/skills", search: { name } })
                }
                onSaved={(updated) => {
                  setSelectedSkill(updated);
                  void loadSkills();
                }}
              />
            ) : skills.length === 0 ? (
              <EmptySkillsState onCreate={() => void navigate({ to: "/skills", search: { create: "1" } })} />
            ) : (
              <NoSkillPicked />
            )}
          </div>
          </TabsContent>

          <TabsContent value="browse" className="flex-1 overflow-y-auto m-0 pt-0">
            <BrowseTab installedNames={installedNames} onInstalled={() => loadSkills()} />
          </TabsContent>

          <TabsContent value="sources" className="flex-1 overflow-y-auto m-0 pt-0">
            <SourcesTab />
          </TabsContent>
        </Tabs>
      </main>

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete skill?</DialogTitle>
            <DialogDescription>
              This will permanently delete <span className="font-mono">{confirmDelete}</span>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && deleteSkill(confirmDelete)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SkillDetailPanel({
  skill,
  onDeleteClick,
  onPickRelated,
  onSaved,
}: {
  skill: Skill;
  onDeleteClick: () => void;
  onPickRelated: (name: string) => void;
  onSaved: (updated: Skill) => void;
}) {
  // View-is-the-editor: every field edits in place; the header Save
  // enables once anything diverges. Name is fixed (folder id).
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    description: skill.description,
    tags: skill.tags,
    body: skill.body,
  });
  useEffect(() => {
    setDraft({
      description: skill.description,
      tags: skill.tags,
      body: skill.body,
    });
  }, [skill.name, skill.description, skill.tags, skill.body]);

  const dirty =
    draft.description !== skill.description ||
    draft.body !== skill.body ||
    draft.tags.join(" ") !== skill.tags.join(" ");

  const saveSkill = async () => {
    setSaving(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/skills/${encodeURIComponent(skill.name)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            description: draft.description.trim(),
            tags: draft.tags,
            body: draft.body,
          }),
        }
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || res.statusText);
      }
      onSaved((await res.json()) as Skill);
      toast.success("Skill updated");
    } catch (err) {
      toast.error("Failed to update skill", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-row items-start justify-between gap-4 pb-2">
        <div className="min-w-0 flex-1">
          <CardTitle className="text-xl">{skill.name}</CardTitle>
          <input
            aria-label="Description"
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
            placeholder="One-line description…"
            className="mt-1.5 w-full border-0 bg-transparent px-0 text-sm text-ink-soft outline-none placeholder:text-ink-faint"
          />
          <TagsEditor
            tags={draft.tags}
            onChange={(tags) => setDraft({ ...draft, tags })}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void saveSkill()}
          >
            {saving ? <LoadingHairline inline /> : <Save className="size-4" />}
            Save
          </Button>
          <Button variant="ghost-destructive" size="sm" onClick={onDeleteClick}>
            <Trash2 className="size-4" />
            Delete
          </Button>
        </div>
      </div>
      <SkillDetailTabs
        skill={skill}
        body={draft.body}
        onBodyChange={(body) => setDraft({ ...draft, body })}
        onPickRelated={onPickRelated}
      />
    </div>
  );
}

/* Chips with inline add — click a chip's × to remove, type + Enter (or
 * comma) to add, Backspace on the empty input removes the last chip. */
function TagsEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [input, setInput] = useState("");

  const commit = () => {
    const t = input.trim().replace(/,+$/, "");
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setInput("");
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <Badge key={tag} variant="outline" className="gap-1 pr-1">
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            className="inline-flex items-center p-0.5 text-ink-faint transition-colors hover:text-plot-red"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !input && tags.length > 0) {
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={tags.length === 0 ? "Add tags…" : "+ tag"}
        className="h-6 w-24 border-0 bg-transparent px-1 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint"
      />
    </div>
  );
}

function SkillDetailTabs({
  skill,
  body,
  onBodyChange,
  onPickRelated,
}: {
  skill: Skill;
  body: string;
  onBodyChange: (body: string) => void;
  onPickRelated: (name: string) => void;
}) {
  return (
    <>
      <Tabs defaultValue="skill" className="mt-1">
        <TabsList>
          <TabsTrigger value="skill">Skill</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="skill">
          <div className="space-y-4">
            <div className="border-t border-paper-rule pt-4">
              <MarkdownEditor
                value={body}
                onChange={onBodyChange}
                placeholder="Detailed instructions for the agent — type / for blocks…"
                contentClassName="min-h-[280px]"
              />
            </div>

            {skill.relatedSkills.length > 0 && (
              <div>
                <Label className="mb-2 block">Related</Label>
                <div className="flex flex-wrap gap-1.5">
                  {skill.relatedSkills.map((name) => (
                    <Button
                      key={name}
                      variant="ghost"
                      size="xs"
                      onClick={() => onPickRelated(name)}
                    >
                      {name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </TabsContent>
        <TabsContent value="files">
          <FileWorkbench
            root={{ kind: "skill", id: skill.name, scope: "files" }}
          />
          {skill.dirPath && (
            <p className="mt-2 font-mono text-[11px] text-ink-faint">
              {skill.dirPath}
            </p>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

function EmptySkillsState({ onCreate }: { onCreate: () => void }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setExpanded(true), 800);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="mx-auto max-w-5xl">
      <SectionEyebrow meta="0 skills">No skills installed</SectionEyebrow>

      <div className="mt-6 border border-paper-rule paper-surface">
        {/* Index-entry form: name · description · tags. This is what
         * the agent's system prompt actually receives — the rest is
         * loaded on demand via the skill_view tool. */}
        <div className="border-b border-paper-rule px-4 py-3 section-enter">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-[13px] text-ink">
              triage-issue
            </span>
            <span className="meta-row">tags: triage, github</span>
          </div>
          <div className="mt-1 text-[13px] leading-snug text-ink-soft">
            Decide whether an incoming issue is a bug, feature request,
            or noise.
          </div>
        </div>

        {/* Expanded body — appears after a delay. The full markdown
         * content the agent loads when it calls skill_view. */}
        {expanded && (
          <div
            className="px-4 py-3 section-enter"
            style={{ animationDelay: "0ms" }}
          >
            <div className="label-faceplate mb-2">Loaded on demand</div>
            <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink m-0 border-0 p-0 bg-transparent">
{`# Triage issue

Read the body. If it's a bug, file under bugs/.
If it's a feature request, file under proposals/.
If it's noise, close with a polite note.

Always link to the relevant commit when possible.`}
            </pre>
          </div>
        )}
      </div>

      <p className="mt-5 text-[13px] leading-relaxed text-ink-soft">
        A skill is a markdown file with frontmatter. The index above is
        what agents see in their system prompt; the body loads only when
        the agent calls{" "}
        <code className="px-1 py-0.5 font-mono text-[12px] text-ink">
          skill_view
        </code>
        . Progressive disclosure keeps context small.
      </p>

      <div className="mt-5">
        <Button onClick={onCreate}>
          <Plus className="size-4" />
          Author your first skill
        </Button>
      </div>
    </div>
  );
}

function NoSkillPicked() {
  // Pick-something prompt + a teaching aside on what a skill IS so the
  // right pane carries weight even when nothing's selected. The format
  // mini-reference doubles as documentation: a reader who lands here
  // without selecting anything learns the SKILL.md contract.
  return (
    <div className="mx-auto max-w-5xl">
      <SectionEyebrow>Select a skill</SectionEyebrow>
      <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-ink-soft">
        Pick a row from the index to view its body and edit frontmatter.
      </p>

      <div className="mt-10">
        <SectionEyebrow>Skill format</SectionEyebrow>
        <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-ink-soft">
          A skill is a SKILL.md file under{" "}
          <code className="font-mono text-[12px] text-ink">
            ~/.openacme/skills/&lt;name&gt;/
          </code>
          . YAML frontmatter for{" "}
          <span className="font-mono text-[12px] text-ink">name</span>,{" "}
          <span className="font-mono text-[12px] text-ink">description</span>,{" "}
          <span className="font-mono text-[12px] text-ink">tags</span>; the body
          is the prose an agent reads on demand.
        </p>
        <pre className="mt-4 overflow-x-auto border border-paper-rule bg-paper-sunk px-4 py-3 font-mono text-[12px] leading-relaxed text-ink">
{`---
name: review-pr
description: Read a GitHub PR and post a critique
tags: [review, github]
---

# How to review a PR
…body the agent reads when this skill loads.`}
        </pre>
      </div>
    </div>
  );
}
