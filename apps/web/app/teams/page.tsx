"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { Users, Plus, Save, Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";
import { useRouter, useSearchParams } from "next/navigation";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import { Label } from "@/app/components/ui/label";
import { Badge } from "@/app/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { ActiveMarker } from "@/app/components/ui/active-marker";
import { cn } from "@/app/lib/utils";

// mirrored (not imported) — TeamDefinition from @openacme/config
interface Team {
  id: string;
  name: string;
  members: string[];
  archived?: boolean;
  charter: string;
}

interface AgentSummary {
  id: string;
  name: string;
}

interface Draft {
  id: string;
  name: string;
  members: string[];
  charter: string;
}

const EMPTY_DRAFT: Draft = { id: "", name: "", members: [], charter: "" };

export default function TeamsPage() {
  return (
    <Suspense fallback={null}>
      <TeamsPageInner />
    </Suspense>
  );
}

function TeamsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlId = searchParams.get("id");

  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(urlId);
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [teamsRes, agentsRes] = await Promise.all([
          fetch(`${API_BASE}/api/teams`, { signal: controller.signal }),
          fetch(`${API_BASE}/api/agents`, { signal: controller.signal }),
        ]);
        if (teamsRes.ok) setTeams((await teamsRes.json()) as Team[]);
        if (agentsRes.ok) {
          const list = (await agentsRes.json()) as Array<{
            id: string;
            name: string;
          }>;
          setAgents(list.map((a) => ({ id: a.id, name: a.name })));
        }
      } catch {
        // aborted or unreachable — page renders empty states
      }
    })();
    return () => controller.abort();
  }, []);

  const selected = useMemo(
    () => teams.find((t) => t.id === selectedId) ?? null,
    [teams, selectedId]
  );

  useEffect(() => {
    if (isCreating) return;
    if (selected) {
      setDraft({
        id: selected.id,
        name: selected.name,
        members: selected.members,
        charter: selected.charter,
      });
    } else {
      setDraft(EMPTY_DRAFT);
    }
  }, [selected, isCreating]);

  function startCreate() {
    setIsCreating(true);
    setSelectedId(null);
    setDraft(EMPTY_DRAFT);
  }

  function selectTeam(id: string) {
    setIsCreating(false);
    setSelectedId(id);
    router.replace(`/teams?id=${encodeURIComponent(id)}`);
  }

  function toggleMember(agentId: string) {
    setDraft((d) => ({
      ...d,
      members: d.members.includes(agentId)
        ? d.members.filter((m) => m !== agentId)
        : [...d.members, agentId],
    }));
  }

  async function refresh(selectId?: string) {
    const res = await fetch(`${API_BASE}/api/teams`);
    if (res.ok) setTeams((await res.json()) as Team[]);
    if (selectId) {
      setIsCreating(false);
      setSelectedId(selectId);
    }
  }

  async function save() {
    if (!draft.name.trim()) {
      toast.error("Team needs a name");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(),
        members: draft.members,
        charter: draft.charter,
      };
      let res: Response;
      if (isCreating) {
        const id =
          draft.id.trim() ||
          draft.name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        res = await fetch(`${API_BASE}/api/teams`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, id }),
        });
      } else {
        res = await fetch(
          `${API_BASE}/api/teams/${encodeURIComponent(draft.id)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }
        );
      }
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error ?? "Failed to save team");
        return;
      }
      const saved = (await res.json()) as Team;
      toast.success(isCreating ? `Team created: ${saved.name}` : "Team saved");
      await refresh(saved.id);
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(team: Team, archived: boolean) {
    const res = await fetch(
      `${API_BASE}/api/teams/${encodeURIComponent(team.id)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      }
    );
    if (!res.ok) {
      toast.error("Failed to update team");
      return;
    }
    toast.success(archived ? `Archived ${team.name}` : `Restored ${team.name}`);
    await refresh(team.id);
  }

  const showEditor = isCreating || selected !== null;

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-paper-rule px-3 md:px-6">
          <div className="flex items-center gap-2 md:gap-3">
            <h1 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Teams
            </h1>
            <span className="hidden h-3 w-px bg-paper-rule sm:inline" aria-hidden />
            <span className="hidden font-mono text-[12px] text-ink-soft sm:inline">
              {teams.length} configured
            </span>
          </div>
          <Button size="sm" onClick={startCreate}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">New team</span>
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
            <p className="text-sm text-ink-faint">
              A team is a roster, a charter, and a shared workspace. The
              charter is injected into every member&apos;s context; the shared
              workspace is read-write for members and readable by everyone
              else.
            </p>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-[260px_1fr]">
          <div className="flex flex-col gap-2">
            {teams.length === 0 && !isCreating && (
              <Card>
                <CardContent className="py-6 text-sm text-ink-faint">
                  No teams yet. Create one to give a group of agents a shared
                  charter and workspace.
                </CardContent>
              </Card>
            )}
            {teams.map((team) => (
              <button
                key={team.id}
                onClick={() => selectTeam(team.id)}
                className={cn(
                  "relative rounded-md border border-paper-rule bg-paper px-3 py-2 text-left transition-colors hover:bg-paper-sunk",
                  selectedId === team.id && "bg-paper-sunk"
                )}
              >
                <ActiveMarker active={selectedId === team.id} />
                <div className="flex items-center gap-2">
                  <Users className="size-4 shrink-0 text-ink-faint" />
                  <span className="truncate text-sm font-medium">
                    {team.name}
                  </span>
                  {team.archived && (
                    <Badge variant="secondary" className="ml-auto">
                      archived
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-ink-faint">
                  {team.members.length} member
                  {team.members.length === 1 ? "" : "s"}
                </div>
              </button>
            ))}
          </div>

          {showEditor ? (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>
                  {isCreating ? "New team" : `Edit: ${selected?.name ?? ""}`}
                </CardTitle>
                {!isCreating && selected && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setArchived(selected, !selected.archived)}
                  >
                    {selected.archived ? (
                      <>
                        <ArchiveRestore className="size-4" /> Restore
                      </>
                    ) : (
                      <>
                        <Archive className="size-4" /> Archive
                      </>
                    )}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="team-name">Name</Label>
                    <Input
                      id="team-name"
                      value={draft.name}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, name: e.target.value }))
                      }
                      placeholder="Website Redesign"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="team-id">Id</Label>
                    <Input
                      id="team-id"
                      value={draft.id}
                      disabled={!isCreating}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, id: e.target.value }))
                      }
                      placeholder="derived from name"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Members</Label>
                  {agents.length === 0 ? (
                    <p className="text-sm text-ink-faint">
                      No agents yet — create agents first.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {agents.map((agent) => {
                        const isMember = draft.members.includes(agent.id);
                        return (
                          <button
                            key={agent.id}
                            type="button"
                            onClick={() => toggleMember(agent.id)}
                            className={cn(
                              "rounded-full border border-paper-rule px-3 py-1 text-sm transition-colors",
                              isMember
                                ? "bg-ink text-paper"
                                : "bg-paper text-ink-soft hover:bg-paper-sunk"
                            )}
                          >
                            {agent.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="team-charter">Charter</Label>
                  <Textarea
                    id="team-charter"
                    value={draft.charter}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, charter: e.target.value }))
                    }
                    rows={10}
                    placeholder={
                      "What this team is for, how it works, conventions.\n" +
                      "Injected into every member's context — e.g. \"Zoe is the manager and splits incoming work.\""
                    }
                  />
                  <p className="text-xs text-ink-faint">
                    Human-owned: agents can read the charter but never edit it.
                  </p>
                </div>

                <div className="flex justify-end">
                  <Button onClick={save} disabled={saving}>
                    <Save className="size-4" />
                    {isCreating ? "Create team" : "Save changes"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-10 text-center text-sm text-ink-faint">
                Select a team to edit, or create a new one.
              </CardContent>
            </Card>
          )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
