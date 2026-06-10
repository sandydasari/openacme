"use client";

import { useState, useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { API_BASE } from "../lib/api";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Badge } from "@/app/components/ui/badge";
import { Skeleton } from "@/app/components/ui/skeleton";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";

type TapSource = "github" | "claude-marketplace" | "well-known" | "local";

interface Tap {
  source: TapSource;
  repo: string;
  path: string;
  addedAt: string;
}

const SOURCE_LABEL: Record<TapSource, string> = {
  github: "GitHub repo",
  "claude-marketplace": "Claude marketplace",
  "well-known": "Well-known catalog",
  local: "Local directory",
};

const REPO_PLACEHOLDER: Record<TapSource, string> = {
  github: "owner/repo",
  "claude-marketplace": "owner/repo",
  "well-known": "https://example.com",
  local: "/absolute/path/to/skills",
};

const REPO_LABEL: Record<TapSource, string> = {
  github: "Repo",
  "claude-marketplace": "Repo",
  "well-known": "Base URL",
  local: "Path",
};

function validateRepo(source: TapSource, repo: string): string | null {
  const v = repo.trim();
  if (!v) return `${REPO_LABEL[source]} is required`;
  if (source === "github" || source === "claude-marketplace") {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) {
      return "Must be in owner/repo format";
    }
  } else if (source === "well-known") {
    if (!/^https?:\/\//i.test(v)) return "Must be an http(s) URL";
  } else if (source === "local") {
    if (!v.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(v)) {
      return "Must be an absolute path";
    }
  }
  return null;
}

function defaultPathFor(source: TapSource): string {
  return source === "github" ? "skills/" : "";
}

/**
 * One-click "Add" presets. Curated public catalogs the hub knows how to
 * crawl. Nothing is auto-added — the user picks. Users can also add
 * arbitrary repos via the dialog.
 */
const SUGGESTED_TAPS: Array<{ source: TapSource; repo: string; path: string; blurb: string }> = [
  {
    source: "github",
    repo: "anthropics/skills",
    path: "skills/",
    blurb: "Anthropic's official skills library.",
  },
  {
    source: "github",
    repo: "openai/skills",
    path: "skills/",
    blurb: "OpenAI's public agent-skill repo.",
  },
  {
    source: "github",
    repo: "vercel-labs/agent-skills",
    path: "skills/",
    blurb: "Vercel's curated agent-skill collection.",
  },
  {
    source: "claude-marketplace",
    repo: "anthropics/claude-code",
    path: "",
    blurb: "Anthropic's Claude Code marketplace catalog.",
  },
  {
    source: "claude-marketplace",
    repo: "wshobson/agents",
    path: "",
    blurb: "Popular community Claude Code agents marketplace.",
  },
];

/**
 * Catalogs the hub queries by default — no tap needed because the upstream
 * is a singleton hosted JSON endpoint. Shown for discoverability; not
 * configurable today.
 */
const ALWAYS_ON_CATALOGS: Array<{ id: string; label: string; blurb: string }> = [
  {
    id: "lobehub",
    label: "LobeHub",
    blurb: "~14k system-prompt templates synthesized as SKILL.md on install.",
  },
  {
    id: "skills-sh",
    label: "skills.sh",
    blurb: "Community catalog; install files come from the linked GitHub repo.",
  },
  {
    id: "clawhub",
    label: "ClawHub",
    blurb: "Community catalog (skills served as ZIP bundles).",
  },
];

export function SourcesTab() {
  const [taps, setTaps] = useState<Tap[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<{
    source: TapSource;
    repo: string;
    path: string;
  }>({ source: "github", repo: "", path: "skills/" });

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/skills/hub/taps`);
      if (res.ok) {
        setTaps(await res.json());
      } else {
        toast.error("Failed to load taps");
      }
    } catch (e) {
      toast.error("Failed to load taps", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }

  async function add() {
    const validation = validateRepo(form.source, form.repo);
    if (validation) {
      toast.error(validation);
      return;
    }
    setAdding(true);
    try {
      const res = await fetch(`${API_BASE}/api/skills/hub/taps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: form.source,
          repo: form.repo.trim(),
          path: form.path.trim() || defaultPathFor(form.source),
        }),
      });
      if (res.ok) {
        toast.success(`Added tap: ${form.repo}`);
        setDialogOpen(false);
        setForm({ source: "github", repo: "", path: "skills/" });
        void load();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error("Failed to add tap", { description: body.error });
      }
    } catch (e) {
      toast.error("Failed to add tap", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setAdding(false);
    }
  }

  async function addSuggested(s: { source: TapSource; repo: string; path: string }) {
    try {
      const res = await fetch(`${API_BASE}/api/skills/hub/taps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(s),
      });
      if (res.ok) {
        toast.success(`Added tap: ${s.repo}`);
        void load();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error("Failed to add tap", { description: body.error });
      }
    } catch (e) {
      toast.error("Failed to add tap", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function remove(tap: Tap) {
    try {
      const res = await fetch(`${API_BASE}/api/skills/hub/taps`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: tap.source, repo: tap.repo }),
      });
      if (res.ok) {
        toast.success(`Removed tap: ${tap.repo}`);
        void load();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error("Failed to remove tap", { description: body.error });
      }
    } catch (e) {
      toast.error("Failed to remove tap", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 md:px-6">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-ink-soft">
          Taps are catalogs the hub searches when you browse skills — GitHub
          repos, Claude marketplaces, well-known endpoints, or local
          directories.
        </p>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="size-3.5" />
          Add tap
        </Button>
      </div>

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      )}

      {!loading && (
        <>
          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Configured taps
            </div>
            {taps.length === 0 ? (
              <p className="text-center font-mono text-[12px] text-ink-faint py-6">
                No taps. Use a suggestion below or add one manually.
              </p>
            ) : (
              <ul className="border-y border-paper-rule font-mono text-[12px]">
                {taps.map((t) => (
                  <li
                    key={`${t.source}:${t.repo}`}
                    className="flex items-center justify-between gap-3 border-b border-paper-rule/40 last:border-b-0 px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{t.source}</Badge>
                        <span className="truncate text-ink">{t.repo}</span>
                      </div>
                      {t.path && (
                        <div className="mt-0.5 text-ink-faint">
                          path: {t.path}
                        </div>
                      )}
                    </div>
                    <Button
                      variant="ghost-destructive"
                      size="sm"
                      onClick={() => void remove(t)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {(() => {
            const remaining = SUGGESTED_TAPS.filter(
              (s) => !taps.some((t) => t.source === s.source && t.repo === s.repo)
            );
            if (remaining.length === 0) return null;
            return (
              <div>
                <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Suggested
                </div>
                <p className="mb-2 text-[12px] text-ink-faint">
                  Curated catalogs you can add as taps in one click.
                </p>
                <ul className="space-y-1">
                  {remaining.map((s) => (
                    <li
                      key={`${s.source}:${s.repo}`}
                      className="flex items-center justify-between gap-3 border border-dashed border-paper-rule px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 font-mono text-[12px]">
                          <Badge variant="outline">{s.source}</Badge>
                          <span className="truncate text-ink-soft">{s.repo}</span>
                        </div>
                        <p className="mt-0.5 text-[12px] text-ink-faint">{s.blurb}</p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void addSuggested(s)}
                      >
                        <Plus className="size-3.5" />
                        Add
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}

          <div className="border border-paper-rule bg-paper-sunk px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Always-on
            </div>
            <p className="mt-1.5 text-[12px] text-ink-soft">
              These hosted catalogs are queried automatically when you Browse —
              they aren&apos;t taps and don&apos;t need configuration.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ALWAYS_ON_CATALOGS.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1.5 border border-paper-rule bg-paper px-2 py-0.5 font-mono text-[11px] text-ink-soft"
                  title={c.blurb}
                >
                  <span className="text-ink">{c.label}</span>
                  <span className="text-ink-faint">·</span>
                  <span className="text-ink-faint">{c.id}</span>
                </span>
              ))}
            </div>
          </div>
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add tap</DialogTitle>
            <DialogDescription>
              Point the hub at a catalog or directory. Searches across taps
              include this one going forward.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="grid gap-2">
              <Label>Source</Label>
              <Select
                value={form.source}
                onValueChange={(v) => {
                  const source = v as TapSource;
                  setForm({
                    source,
                    repo: "",
                    path: defaultPathFor(source),
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="github">{SOURCE_LABEL.github}</SelectItem>
                  <SelectItem value="claude-marketplace">
                    {SOURCE_LABEL["claude-marketplace"]}
                  </SelectItem>
                  <SelectItem value="well-known">
                    {SOURCE_LABEL["well-known"]}
                  </SelectItem>
                  <SelectItem value="local">{SOURCE_LABEL.local}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tap-repo">{REPO_LABEL[form.source]}</Label>
              <Input
                id="tap-repo"
                value={form.repo}
                onChange={(e) => setForm({ ...form, repo: e.target.value })}
                placeholder={REPO_PLACEHOLDER[form.source]}
              />
            </div>
            {form.source === "github" && (
              <div className="grid gap-2">
                <Label htmlFor="tap-path">Path inside the repo</Label>
                <Input
                  id="tap-path"
                  value={form.path}
                  onChange={(e) => setForm({ ...form, path: e.target.value })}
                  placeholder="skills/"
                />
              </div>
            )}
          </DialogBody>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={add} disabled={adding}>
              {adding && <LoadingHairline inline />}
              Add tap
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
