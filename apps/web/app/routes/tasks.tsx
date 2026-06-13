import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Kanban, Rows3, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { TabularTick } from "@/app/components/ui/tabular-tick";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { JargonChip } from "@/app/components/ui/jargon-chip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { cn } from "@/app/lib/utils";
import { FilterCombobox } from "../tasks/filter-combobox";
import { TasksBoard } from "../tasks/board";
import { TaskDetailPanel, type AgentOption } from "../tasks/detail";
import { TaskListRow } from "../tasks/row";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  formatRelativeFromIso,
  type Task,
  type TaskStatus,
} from "../tasks/types";

type ViewMode = "board" | "list";
const VIEW_MODE_STORAGE_KEY = "openacme.tasks.viewMode";

export const Route = createFileRoute("/tasks")({
  validateSearch: z.object({ id: z.coerce.string().optional() }),
  component: TasksPage,
});

const POLL_MS = 10_000;

function TasksPage() {
  const navigate = useNavigate();
  const urlId = Route.useSearch().id ?? null;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Task | null>(null);
  const [draft, setDraft] = useState<Task | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmDeleteMode, setConfirmDeleteMode] = useState<
    "simple" | "cascade"
  >("simple");
  // Pending navigation parked behind the discard-unsaved-changes dialog.
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "board";
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === "list" || stored === "board" ? stored : "board";
  });

  // Render-synced mirror of `dirty` for the poll callbacks (set below,
  // once dirty is computed).
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  // Agents move tasks while this page is open — poll the list and refetch
  // on window focus so the board tracks the workforce, not the last reload.
  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal, true);
    void loadAgents(ctrl.signal);
    const tick = window.setInterval(
      () => void load(ctrl.signal, false),
      POLL_MS
    );
    const onFocus = () => void load(ctrl.signal, false);
    window.addEventListener("focus", onFocus);
    return () => {
      ctrl.abort();
      window.clearInterval(tick);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // URL → selection state. /tasks?id=<id> loads that task; /tasks resets.
  useEffect(() => {
    if (urlId) {
      void loadOne(urlId);
    } else {
      setSelected(null);
      setDraft(null);
    }
  }, [urlId]);

  const load = async (signal: AbortSignal | undefined, initial: boolean) => {
    try {
      if (initial) setLoading(true);
      const res = await fetch(`${API_BASE}/api/tasks`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { tasks: Task[] };
      setTasks(json.tasks);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // Poll failures keep stale data on screen; only the first load toasts.
      if (initial) toast.error("Failed to load tasks");
    } finally {
      if (initial) setLoading(false);
    }
  };

  const loadAgents = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/agents`, { signal });
      if (!res.ok) return;
      const list = (await res.json()) as {
        id: string;
        name: string;
        avatar?: string;
      }[];
      setAgents(
        list.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar }))
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // non-fatal: assignee select falls back to current value
    }
  };

  // Abort the in-flight detail fetch on every new one — rapid row
  // switching must not land out-of-order responses under the wrong URL.
  const loadOneCtrlRef = useRef<AbortController | null>(null);
  const loadOne = async (id: string, quiet = false) => {
    loadOneCtrlRef.current?.abort();
    const ctrl = new AbortController();
    loadOneCtrlRef.current = ctrl;
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${id}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { task: Task };
      // A quiet (poll) refresh never clobbers in-progress edits.
      if (quiet && dirtyRef.current) return;
      setSelected(json.task);
      setDraft(json.task);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (!quiet) toast.error("Failed to load task");
    }
  };

  // Keep the open task fresh alongside the list poll (the activity
  // timeline already polls; without this the header could contradict it).
  useEffect(() => {
    if (!urlId) return;
    const tick = window.setInterval(() => {
      if (dirtyRef.current) return;
      void loadOne(urlId, true);
    }, POLL_MS);
    return () => window.clearInterval(tick);
  }, [urlId]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        title: draft.title,
        body: draft.body ?? "",
        status: draft.status,
        assignee: draft.assignee,
        start_at: draft.start_at,
        due_at: draft.due_at,
        recurrence: draft.recurrence,
      };
      // Only send session_id when the user deliberately changed it
      // (unbind). An untouched value would read as an explicit bind and
      // defeat the store's clear-session-on-reassign invariant.
      if (selected && draft.session_id !== selected.session_id) {
        patch.session_id = draft.session_id;
      }
      const res = await fetch(`${API_BASE}/api/tasks/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { task: Task };
      setSelected(json.task);
      setDraft(json.task);
      await load(undefined, false);
      toast.success("Saved");
      if (json.task.status !== draft.status) {
        const note = explainAutoCorrect(json.task, draft.status);
        toast.message(note.title, { description: note.description });
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Drag-end handler for board mode: optimistic move, PATCH status, revert on error.
  const moveStatus = async (id: string, target: TaskStatus) => {
    const before = tasks;
    const current = before.find((t) => t.id === id);
    if (!current) return;
    setTasks(before.map((t) => (t.id === id ? { ...t, status: target } : t)));
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: target }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { task: Task };
      // The store may auto-correct (e.g., back to blocked if deps unmet,
      // or a recurring task re-arming itself after done).
      if (json.task.status !== target) {
        const note = explainAutoCorrect(json.task, target);
        toast.message(note.title, { description: note.description });
      }
      await load(undefined, false);
      // If the moved task was the selected one, refresh detail view too.
      if (selected?.id === id) {
        setSelected(json.task);
        setDraft(json.task);
      }
    } catch (e) {
      setTasks(before);
      toast.error((e as Error).message);
    }
  };

  const remove = async (id: string, force: boolean) => {
    try {
      const res = await fetch(
        `${API_BASE}/api/tasks/${id}${force ? "?force=true" : ""}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        if (err.error === "has_dependents") {
          return false;
        }
        throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
      }
      const wasSelected = selected?.id === id;
      await load(undefined, false);
      toast.success("Deleted");
      setConfirmDelete(null);
      if (wasSelected) void navigate({ to: "/tasks" });
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };

  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.team) set.add(t.team);
    return [...set].sort();
  }, [tasks]);

  const agentName = useMemo(
    () => new Map(agents.map((a) => [a.id, a.name])),
    [agents]
  );

  // Only assignees that actually own a task — the picker tracks the
  // board, not the full roster, so dead options never accumulate.
  const assignees = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) if (t.assignee) set.add(t.assignee);
    return [...set].sort((a, b) =>
      (agentName.get(a) ?? a).localeCompare(agentName.get(b) ?? b)
    );
  }, [tasks, agentName]);

  const filtersActive =
    teamFilter !== "all" ||
    assigneeFilter !== "all" ||
    query.trim() !== "";

  const clearFilters = () => {
    setTeamFilter("all");
    setAssigneeFilter("all");
    setQuery("");
  };

  const visibleTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      if (teamFilter !== "all" && t.team !== teamFilter) return false;
      if (assigneeFilter !== "all" && t.assignee !== assigneeFilter)
        return false;
      if (q) {
        const hay = `${t.title} #${t.id} ${t.assignee} ${t.team ?? ""} ${
          t.body ?? ""
        }`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tasks, teamFilter, assigneeFilter, query]);

  const grouped = useMemo(() => {
    const out = new Map<TaskStatus, Task[]>();
    for (const s of STATUS_ORDER) out.set(s, []);
    for (const t of visibleTasks) {
      out.get(t.status)?.push(t);
    }
    for (const list of out.values()) {
      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    return out;
  }, [visibleTasks]);


  const dirty = !!(
    draft &&
    selected &&
    (draft.title !== selected.title ||
      (draft.body ?? "") !== (selected.body ?? "") ||
      draft.status !== selected.status ||
      draft.assignee !== selected.assignee ||
      (draft.session_id ?? null) !== (selected.session_id ?? null) ||
      (draft.start_at ?? null) !== (selected.start_at ?? null) ||
      (draft.due_at ?? null) !== (selected.due_at ?? null) ||
      JSON.stringify(draft.recurrence) !== JSON.stringify(selected.recurrence))
  );
  dirtyRef.current = dirty;

  // Unsaved edits never silently die: selection changes route through
  // the discard dialog while dirty.
  const guardNav = (go: () => void) => {
    if (dirtyRef.current) setPendingNav(() => go);
    else go();
  };
  const pickTask = (id: string) => {
    if (id === urlId) return;
    guardNav(() => void navigate({ to: "/tasks", search: { id } }));
  };
  const closeDetail = () => {
    guardNav(() => void navigate({ to: "/tasks" }));
  };

  // Cmd/Ctrl+S saves the open task instead of the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (!draft) return;
        e.preventDefault();
        if (dirty && !saving) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-paper-rule px-3 py-2 md:px-6">
          <h1 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
            Tasks
          </h1>

          {!loading && tasks.length > 0 ? (
            <>
              <div className="relative min-w-[9rem] flex-1 md:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search title, body, #id"
                  className="h-7 pl-8 pr-7 text-[13px]"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>

              {assignees.length > 1 && (
                <FilterCombobox
                  value={assigneeFilter}
                  onChange={setAssigneeFilter}
                  allLabel="All assignees"
                  searchPlaceholder="Filter agents"
                  options={assignees.map((a) => ({
                    value: a,
                    label: agentName.get(a) ?? a,
                  }))}
                />
              )}

              {teams.length > 0 && (
                <FilterCombobox
                  value={teamFilter}
                  onChange={setTeamFilter}
                  allLabel="All teams"
                  searchPlaceholder="Filter teams"
                  options={teams.map((t) => ({ value: t, label: t }))}
                />
              )}

              {/* Eats the slack so the count + view toggle pin right while
                  the search caps at max-w-xs. */}
              <div className="flex-1" />

              {filtersActive && (
                <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-ink-faint">
                  <span>
                    {visibleTasks.length} / {tasks.length}
                  </span>
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="inline-flex items-center gap-1 uppercase tracking-[0.08em] text-ink-soft transition-colors hover:text-plot-red"
                  >
                    <X className="size-3" />
                    Clear
                  </button>
                </span>
              )}
            </>
          ) : (
            <div className="flex-1" />
          )}

          <div className="ml-auto inline-flex shrink-0 border border-paper-rule">
            <button
              onClick={() => setViewMode("board")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors",
                viewMode === "board"
                  ? "bg-ink text-paper"
                  : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink"
              )}
            >
              <Kanban className="size-3.5" />
              Board
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 border-l border-paper-rule px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors",
                viewMode === "list"
                  ? "bg-ink text-paper"
                  : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink"
              )}
            >
              <Rows3 className="size-3.5" />
              List
            </button>
          </div>
        </header>

        {loading ? (
          <div className="relative flex flex-1 items-end px-6 py-12 section-enter">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Reading task store
            </span>
            <LoadingHairline />
          </div>
        ) : tasks.length === 0 ? (
          <EmptyTasksState />
        ) : visibleTasks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              No tasks match
            </span>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        ) : (
          <div className="flex flex-1 overflow-hidden">
            {viewMode === "board" ? (
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <TasksBoard
                  tasks={visibleTasks}
                  selectedId={selected?.id ?? null}
                  onPick={pickTask}
                  onMove={(id, target) => void moveStatus(id, target)}
                />
              </div>
            ) : (
              <aside
                className={cn(
                  "flex shrink-0 flex-col overflow-y-auto border-paper-rule md:w-96 md:border-r",
                  selected ? "hidden md:flex" : "flex w-full md:w-96"
                )}
              >
                {STATUS_ORDER.map((status) => {
                  const items = grouped.get(status) ?? [];
                  if (items.length === 0) return null;
                  return (
                    <div key={status}>
                      <div className="flex items-center justify-between border-b border-paper-rule px-4 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                        <span>{STATUS_LABEL[status]}</span>
                        <TabularTick value={items.length} />
                      </div>
                      <div className="flex flex-col">
                        {items.map((t) => (
                          <TaskListRow
                            key={t.id}
                            task={t}
                            isActive={selected?.id === t.id}
                            onPick={() => pickTask(t.id)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </aside>
            )}

            {/* One detail surface for both modes: the routed pane. Board
                opens it as a right-anchored sheet over the columns (the
                board keeps its full width); list keeps it resident. */}
            {viewMode === "list" && (
              <section
                className={cn(
                  "flex flex-1 flex-col overflow-hidden",
                  !selected ? "hidden md:flex" : "flex"
                )}
              >
                {selected && draft && <BackToTasks onClick={closeDetail} />}
                {!selected || !draft ? (
                  <div className="flex flex-1 items-start justify-center px-6 pt-24">
                    <div className="max-w-sm">
                      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                        No selection
                      </div>
                      <h3 className="mt-2 text-base font-semibold text-ink">
                        Pick a task
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                        Each task has a title, status, assignee, schedule, and
                        free-form body. Status changes are gated by
                        dependencies.
                      </p>
                    </div>
                  </div>
                ) : (
                  <TaskDetailPanel
                    selected={selected}
                    draft={draft}
                    saving={saving}
                    dirty={dirty}
                    agents={agents}
                    tasks={tasks}
                    onChange={setDraft}
                    onSave={() => void save()}
                    onDeleteClick={() => setConfirmDelete(selected.id)}
                  />
                )}
              </section>
            )}
          </div>
        )}

        {/* Board mode: detail as a full-height right sheet over the
            columns. Escape / overlay-click route through closeDetail, so
            the dirty guard still applies. Mobile: full takeover above
            the bottom tab bar, like the rest of the app. */}
        <Dialog
          open={viewMode === "board" && !!selected && !!draft}
          onOpenChange={(open) => {
            if (!open) closeDetail();
          }}
        >
          <DialogContent
            showCloseButton={false}
            className="left-0 right-0 top-0 h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom))] w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden border-0 border-l border-paper-rule data-[state=closed]:slide-out-to-right-6 data-[state=open]:slide-in-from-right-6 sm:max-w-none md:left-auto md:h-dvh md:max-h-none md:w-[min(54rem,94vw)]"
          >
            <VisuallyHidden.Root>
              <DialogTitle>{selected?.title ?? "Task"}</DialogTitle>
              <DialogDescription>
                Edit task details: title, status, assignee, schedule,
                recurrence, and body.
              </DialogDescription>
            </VisuallyHidden.Root>
            {selected && draft && (
              <TaskDetailPanel
                selected={selected}
                draft={draft}
                saving={saving}
                dirty={dirty}
                agents={agents}
                tasks={tasks}
                onChange={setDraft}
                onSave={() => void save()}
                onDeleteClick={() => setConfirmDelete(selected.id)}
                onClose={closeDetail}
              />
            )}
          </DialogContent>
        </Dialog>

        <Dialog
          open={!!pendingNav}
          onOpenChange={(open) => {
            if (!open) setPendingNav(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Discard unsaved changes?</DialogTitle>
              <DialogDescription>
                This task has edits that aren&apos;t saved.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingNav(null)}>
                Keep editing
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const go = pendingNav;
                  setPendingNav(null);
                  go?.();
                }}
              >
                Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={!!confirmDelete}
          onOpenChange={(open) => {
            if (!open) {
              setConfirmDelete(null);
              setConfirmDeleteMode("simple");
            }
          }}
        >
          <DialogContent>
            {confirmDeleteMode === "simple" ? (
              <>
                <DialogHeader>
                  <DialogTitle>Delete this task?</DialogTitle>
                  <DialogDescription>
                    Permanent. If other tasks depend on this one, you&apos;ll be
                    asked whether to cascade.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setConfirmDelete(null);
                      setConfirmDeleteMode("simple");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      if (!confirmDelete) return;
                      const ok = await remove(confirmDelete, false);
                      if (!ok) setConfirmDeleteMode("cascade");
                    }}
                  >
                    Delete
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Cascade delete?</DialogTitle>
                  <DialogDescription>
                    Other tasks depend on this one. Cascading removes them
                    all.
                  </DialogDescription>
                </DialogHeader>
                {confirmDelete && (
                  <ol className="my-2 max-h-48 space-y-1.5 overflow-y-auto border-t border-paper-rule pt-3">
                    {tasks
                      .filter((t) => t.depends_on.includes(confirmDelete))
                      .map((t) => (
                        <li
                          key={t.id}
                          className="flex items-baseline gap-2 text-sm"
                        >
                          <span className="font-mono text-[12px] tabular-nums text-ink-faint">
                            {`#${t.id}`}
                          </span>
                          <span className="truncate text-ink">{t.title}</span>
                        </li>
                      ))}
                  </ol>
                )}
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setConfirmDelete(null);
                      setConfirmDeleteMode("simple");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      if (!confirmDelete) return;
                      await remove(confirmDelete, true);
                    }}
                  >
                    Cascade
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}

// Mobile-only escape hatch back to the list/board when the detail pane
// takes over the full width.
function BackToTasks({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-4 mt-3 inline-flex w-fit items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft hover:text-plot-red md:hidden"
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
      Back to tasks
    </button>
  );
}

function explainAutoCorrect(
  task: Task,
  requested: TaskStatus
): { title: string; description: string } {
  // Marking a recurring task done re-arms it — designed behavior, not
  // a correction, so don't make it read like an error.
  if (task.recurrence && requested === "done" && task.status === "open") {
    const next = task.start_at
      ? formatRelativeFromIso(task.start_at)
      : "pending";
    return {
      title: "Recurring task re-armed",
      description: `Run ${task.runs} complete. Next fire ${next}.`,
    };
  }
  if (task.status === "blocked" && requested === "open") {
    return {
      title: `Auto-corrected to ${STATUS_LABEL[task.status]}`,
      description: "Dependencies aren't all done yet.",
    };
  }
  return {
    title: `Auto-corrected to ${STATUS_LABEL[task.status]}`,
    description: `Server returned status ${task.status} instead of ${requested}.`,
  };
}

// One-pass vocabulary scribe-in: open → in_progress → done, then settle on
// in_progress (the most informative state). Not an eternal loop — §7.4's
// "choreographed motion" anti-pattern targets staggered/multi-curve flourish;
// a single bounded pass through the vocabulary is the §7.3 designed-empty-
// state primitive ("scribes in to demonstrate the format").
const EMPTY_DEMO_STATES: { label: string; dot: string }[] = [
  { label: "OPEN",        dot: "bg-ink" },
  { label: "IN PROGRESS", dot: "bg-plot-red" },
  { label: "DONE",        dot: "bg-ink-soft" },
];
// Settle index = IN PROGRESS (the live state). After the cycle, the demo
// row freezes here so the empty state's primary teaching is "this is what
// active work looks like."
const EMPTY_DEMO_SETTLE_IDX = 1;
const EMPTY_DEMO_STEP_MS = 1500;

function EmptyTasksState() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let step = 0;
    const tick = () => {
      if (cancelled) return;
      if (step >= EMPTY_DEMO_STATES.length - 1) {
        // Final settle frame.
        setIdx(EMPTY_DEMO_SETTLE_IDX);
        return;
      }
      step += 1;
      setIdx(step);
      window.setTimeout(tick, EMPTY_DEMO_STEP_MS);
    };
    const t = window.setTimeout(tick, EMPTY_DEMO_STEP_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, []);
  const current = EMPTY_DEMO_STATES[idx] ?? EMPTY_DEMO_STATES[EMPTY_DEMO_SETTLE_IDX]!;
  return (
    <div className="mx-auto w-full max-w-2xl px-6 pt-12">
      <SectionEyebrow meta="0 tasks">Empty board</SectionEyebrow>

      <div className="mt-6 border border-dashed border-paper-rule paper-surface px-4 py-4 section-enter opacity-80">
        <div className="label-faceplate mb-3 text-ink-faint">Preview</div>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink truncate">
              Draft the weekly status note
            </div>
            <div className="mt-1 meta-row">@your-agent · filed just now</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span aria-hidden className={cn("status-dot", current.dot)} />
            <span key={idx} className="label-faceplate tick">
              {current.label}
            </span>
          </div>
        </div>
      </div>

      <p className="mt-5 text-[13px] leading-relaxed text-ink-soft">
        <JargonChip
          term="Task"
          explanation={
            <span>
              A unit of work an agent files for itself or another agent.
              Has a title, status, assignee, schedule, and free-form body.
              Status transitions are gated by declared dependencies.
            </span>
          }
        >
          Tasks
        </JargonChip>{" "}
        are how agents track work, for themselves and for you. Each one moves
        between <span className="font-mono text-ink">open</span>,{" "}
        <span className="font-mono text-ink">in_progress</span>, and{" "}
        <span className="font-mono text-ink">done</span>. They appear here as
        agents file them. Ask an agent in chat to{" "}
        <span className="font-mono text-ink">file a task to investigate X</span>{" "}
        to start.
      </p>
    </div>
  );
}
