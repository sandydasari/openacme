import { useEffect, useMemo, useState } from "react";
import {
  Users,
  Plus,
  Pencil,
  Archive,
  ArchiveRestore,
  List,
  Network,
} from "lucide-react";
import { toast } from "sonner";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import { usePublishCurrentView } from "@/app/lib/CurrentViewContext";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Badge } from "@/app/components/ui/badge";
import { EmptyState } from "@/app/components/ui/empty-state";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/app/components/ui/tabs";
import { ActiveMarker } from "@/app/components/ui/active-marker";
import { cn } from "@/app/lib/utils";
import { TeamMembersTab } from "../teams/members";
import { TeamTasksTab, useTeamTasks } from "../teams/tasks";
import { TeamCharterTab } from "../teams/charter";
import { TeamCreateForm } from "../teams/create";
import { OrgChart } from "../teams/org-chart";
import { putTeam } from "../teams/api";
import { FileWorkbench } from "../files/FileWorkbench";
import type { AgentInfo, Team } from "../teams/types";

const TEAM_TABS = ["members", "tasks", "charter", "workspace"] as const;
type TeamTab = (typeof TEAM_TABS)[number];

export const Route = createFileRoute("/teams")({
  validateSearch: z.object({
    id: z.coerce.string().optional(),
    tab: z.enum(TEAM_TABS).optional().catch(undefined),
    view: z.enum(["list", "chart"]).optional().catch(undefined),
  }),
  component: TeamsPage,
});

function TeamsPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const urlId = search.id ?? null;
  const tab: TeamTab = search.tab ?? "members";
  const view: "list" | "chart" = search.view ?? "list";

  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

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
          const list = (await agentsRes.json()) as AgentInfo[];
          setAgents(
            list.map((a) => ({
              id: a.id,
              name: a.name,
              role: a.role,
              avatar: a.avatar,
            }))
          );
        }
      } catch {
        // aborted or unreachable — page renders empty states
      }
    })();
    return () => controller.abort();
  }, []);

  const selected = useMemo(
    () => (isCreating ? null : (teams.find((t) => t.id === urlId) ?? null)),
    [teams, urlId, isCreating]
  );

  useEffect(() => {
    setRenaming(false);
  }, [urlId]);

  const teamTasks = useTeamTasks(selected?.id ?? null);

  usePublishCurrentView(
    useMemo(
      () => ({
        page: "/teams",
        entityType: "team" as const,
        entityId: selected?.id ?? null,
        tab,
        content: selected,
      }),
      [selected, tab]
    )
  );

  function startCreate() {
    setIsCreating(true);
    void navigate({ to: "/teams", search: {}, replace: true });
  }

  function setView(next: "list" | "chart") {
    void navigate({
      to: "/teams",
      search: {
        id: urlId ?? undefined,
        tab: search.tab,
        view: next === "list" ? undefined : next,
      },
      replace: true,
    });
  }

  function selectTeam(id: string) {
    setIsCreating(false);
    void navigate({ to: "/teams", search: { id }, replace: true });
  }

  function setTab(next: TeamTab) {
    void navigate({
      to: "/teams",
      search: {
        id: urlId ?? undefined,
        tab: next === "members" ? undefined : next,
      },
      replace: true,
    });
  }

  async function refresh(selectId?: string) {
    const res = await fetch(`${API_BASE}/api/teams`);
    if (res.ok) setTeams((await res.json()) as Team[]);
    if (selectId) {
      setIsCreating(false);
      void navigate({ to: "/teams", search: { id: selectId }, replace: true });
    }
  }

  async function saveName(team: Team) {
    const name = nameDraft.trim();
    if (!name) {
      toast.error("Team needs a name");
      return;
    }
    if (await putTeam(team.id, { name })) {
      setRenaming(false);
      await refresh();
    }
  }

  async function toggleArchived(team: Team) {
    if (await putTeam(team.id, { archived: !team.archived })) {
      toast.success(
        team.archived ? `Restored ${team.name}` : `Archived ${team.name}`
      );
      await refresh();
    }
  }

  const showDetail = isCreating || selected !== null;

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-paper-rule px-3 md:px-6">
          <div className="flex items-center gap-2 md:gap-3">
            <h1 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Teams
            </h1>
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            <div className="flex border border-paper-rule">
              {(
                [
                  ["list", List, "List"],
                  ["chart", Network, "Org chart"],
                ] as const
              ).map(([v, Icon, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors",
                    view === v
                      ? "bg-paper-sunk text-ink"
                      : "text-ink-faint hover:text-ink"
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
            <Button size="sm" onClick={startCreate}>
              <Plus className="size-4" />
              <span className="hidden sm:inline">New team</span>
            </Button>
          </div>
        </header>

        {view === "chart" && !isCreating ? (
          teams.some((t) => !t.archived) ? (
            <div className="relative flex-1 overflow-hidden">
              <OrgChart teams={teams} agents={agents} selectedId={urlId} />
            </div>
          ) : (
            <div className="flex flex-1 items-start justify-center p-4 md:p-6">
              <div className="mt-10 w-full max-w-md border border-dashed border-paper-rule px-4 py-10 text-center">
                <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                  {teams.length > 0 ? "All teams archived" : "No teams yet"}
                </p>
                <p className="mt-1 text-sm text-ink-faint">
                  {teams.length > 0
                    ? "Restore a team to see the org chart."
                    : "The chart appears once your workforce has structure — create a team to start."}
                </p>
              </div>
            </div>
          )
        ) : (
        <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
          <aside
            className={cn(
              "shrink-0 overflow-y-auto border-paper-rule md:w-72 md:border-r",
              showDetail ? "hidden md:block" : "block border-b md:border-b-0"
            )}
          >
            {teams.length === 0 && (
              <EmptyState icon={Users}>
                No teams yet. Create one to give a group of agents a shared
                charter and workspace.
              </EmptyState>
            )}
            {teams.map((team) => {
              const isActive = selected?.id === team.id;
              return (
                <button
                  key={team.id}
                  onClick={() => selectTeam(team.id)}
                  className={cn(
                    "group relative flex w-full items-start gap-3 border-b border-paper-rule/40 px-4 py-3 text-left transition-colors last:border-b-0",
                    isActive
                      ? "bg-paper-sunk text-ink"
                      : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
                  )}
                >
                  <ActiveMarker active={isActive} />
                  <Users className="mt-0.5 size-4 shrink-0 text-ink-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">
                        {team.name}
                      </span>
                      {team.archived && (
                        <Badge variant="secondary" className="shrink-0">
                          archived
                        </Badge>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] tabular-nums text-ink-faint">
                      {team.members.length} member
                      {team.members.length === 1 ? "" : "s"}
                      {team.manager && ` · mgr ${team.manager}`}
                    </div>
                  </div>
                </button>
              );
            })}
          </aside>

          <div
            className={cn(
              "flex-1 overflow-y-auto p-4 md:p-6",
              !showDetail ? "hidden md:block" : ""
            )}
          >
            {showDetail && (
              <button
                type="button"
                onClick={() => {
                  setIsCreating(false);
                  void navigate({ to: "/teams", search: {} });
                }}
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
                  <path d="m15 18-6-6 6-6" />
                </svg>
                Teams
              </button>
            )}

            {isCreating ? (
              <div className="flex flex-col gap-4">
                <h2 className="text-base font-semibold text-ink">New team</h2>
                <TeamCreateForm
                  agents={agents}
                  onCreated={(id) => void refresh(id)}
                />
              </div>
            ) : selected ? (
              <div className="mx-auto flex max-w-6xl flex-col gap-3">
                <div className="flex items-center gap-2">
                  {renaming ? (
                    <>
                      <Input
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveName(selected);
                          if (e.key === "Escape") setRenaming(false);
                        }}
                        autoFocus
                        className="h-8 max-w-xs"
                      />
                      <Button size="sm" onClick={() => void saveName(selected)}>
                        Save
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRenaming(false)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <h2 className="truncate text-base font-semibold text-ink">
                        {selected.name}
                      </h2>
                      <span
                        title="Team id — how tasks and agents address this team. Fixed at creation."
                        className="shrink-0 font-mono text-[12px] text-ink-faint"
                      >
                        {selected.id}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setNameDraft(selected.name);
                          setRenaming(true);
                        }}
                        aria-label="Rename team"
                        title="Rename team"
                        className="p-1 text-ink-faint transition-colors hover:text-ink"
                      >
                        <Pencil className="size-3.5" aria-hidden />
                      </button>
                      {selected.archived && (
                        <Badge variant="secondary">archived</Badge>
                      )}
                    </>
                  )}
                  <div className="ml-auto">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void toggleArchived(selected)}
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
                  </div>
                </div>

                <Tabs value={tab} onValueChange={(v) => setTab(v as TeamTab)}>
                  <TabsList>
                    <TabsTrigger value="members">
                      Members
                      <span className="tabular-nums text-ink-faint">
                        {selected.members.length}
                      </span>
                    </TabsTrigger>
                    <TabsTrigger value="tasks">
                      Tasks
                      {teamTasks.activeCount > 0 && (
                        <span className="tabular-nums text-ink-faint">
                          {teamTasks.activeCount}
                        </span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="charter">Charter</TabsTrigger>
                    <TabsTrigger value="workspace">Workspace</TabsTrigger>
                  </TabsList>
                  <TabsContent value="members">
                    <TeamMembersTab
                      team={selected}
                      agents={agents}
                      onChanged={() => void refresh()}
                    />
                  </TabsContent>
                  <TabsContent value="tasks">
                    <TeamTasksTab data={teamTasks} />
                  </TabsContent>
                  <TabsContent value="charter">
                    <TeamCharterTab
                      team={selected}
                      onChanged={() => void refresh()}
                    />
                  </TabsContent>
                  <TabsContent value="workspace">
                    <FileWorkbench
                      root={{
                        kind: "team",
                        id: selected.id,
                        scope: "workspace",
                      }}
                    />
                  </TabsContent>
                </Tabs>
              </div>
            ) : (
              <div className="mx-auto mt-10 max-w-md border border-dashed border-paper-rule px-4 py-10 text-center">
                <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                  No selection
                </p>
                <p className="mt-1 text-sm text-ink-faint">
                  Pick a team to see its members, work, and charter — or create
                  a new one.
                </p>
              </div>
            )}
          </div>
        </div>
        )}
      </main>
    </div>
  );
}
