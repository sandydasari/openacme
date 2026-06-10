"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Kanban, Rows3 } from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { TabularTick } from "@/app/components/ui/tabular-tick";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { ActiveMarker } from "@/app/components/ui/active-marker";
import { AgentRef } from "@/app/components/ui/agent-ref";
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
import { TasksBoard } from "./board";
import { TaskDetailPanel, type AgentOption } from "./detail";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  STATUS_VARIANT,
  dueUrgencyClass,
  formatDate,
  formatRelativeFutureFromIso,
  type Task,
  type TaskStatus,
} from "./types";

type ViewMode = "board" | "list";
const VIEW_MODE_STORAGE_KEY = "openacme.tasks.viewMode";

export default function TasksPage() {
  return (
    <Suspense fallback={null}>
      <TasksPageInner />
    </Suspense>
  );
}

function TasksPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlId = searchParams.get("id");
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
  const [viewMode, setViewMode] = useState<ViewMode>("board");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (stored === "list" || stored === "board") setViewMode(stored);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    void loadAgents(ctrl.signal);
    return () => ctrl.abort();
  }, []);

  // URL → selection state. /tasks/<id> loads that task; /tasks resets.
  useEffect(() => {
    if (urlId) {
      void loadOne(urlId);
    } else {
      setSelected(null);
      setDraft(null);
    }
  }, [urlId]);

  const load = async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/api/tasks`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { tasks: Task[] };
      setTasks(json.tasks);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load tasks");
    } finally {
      setLoading(false);
    }
  };

  const loadAgents = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/agents`, { signal });
      if (!res.ok) return;
      const list = (await res.json()) as { id: string; name: string }[];
      setAgents(list.map((a) => ({ id: a.id, name: a.name })));
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // non-fatal: assignee select falls back to current value
    }
  };

  const loadOne = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/tasks/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { task: Task };
      setSelected(json.task);
      setDraft(json.task);
    } catch {
      toast.error("Failed to load task");
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        title: draft.title,
        body: draft.body ?? "",
        status: draft.status,
        assignee: draft.assignee,
        session_id: draft.session_id,
        start_at: draft.start_at,
        due_at: draft.due_at,
        recurrence: draft.recurrence,
      };
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
      await load();
      toast.success("Saved");
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
      // The store may auto-correct (e.g., back to blocked if deps unmet).
      if (json.task.status !== target) {
        toast.message(
          `Auto-corrected to ${STATUS_LABEL[json.task.status]}`,
          { description: explainAutoCorrect(json.task.status, target) }
        );
      }
      await load();
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
      await load();
      toast.success("Deleted");
      setConfirmDelete(null);
      if (wasSelected) router.push("/tasks");
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };

  const grouped = useMemo(() => {
    const out = new Map<TaskStatus, Task[]>();
    for (const s of STATUS_ORDER) out.set(s, []);
    for (const t of tasks) {
      out.get(t.status)?.push(t);
    }
    for (const list of out.values()) {
      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    return out;
  }, [tasks]);


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

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-paper-rule px-3 md:px-6">
          <div className="flex items-center gap-2 md:gap-3">
            <h1 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Tasks
            </h1>
          </div>
          <div className="inline-flex border border-paper-rule">
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
        ) : viewMode === "board" ? (
          <TasksBoard
            tasks={tasks}
            selectedId={selected?.id ?? null}
            onPick={(id) => router.push(`/tasks?id=${id}`)}
            onMove={(id, target) => void moveStatus(id, target)}
          />
        ) : (
          <div className="flex flex-1 overflow-hidden">
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
                    {items.map((t) => {
                      const isActive = selected?.id === t.id;
                      return (
                        <div
                          key={t.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => router.push(`/tasks?id=${t.id}`)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              router.push(`/tasks?id=${t.id}`);
                            }
                          }}
                          className={cn(
                            "group relative flex cursor-pointer flex-col items-start gap-1 border-b border-paper-rule/40 px-4 py-3 text-left transition-colors last:border-b-0",
                            isActive
                              ? "bg-paper-sunk text-ink"
                              : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
                          )}
                        >
                          <ActiveMarker active={isActive} />
                          <div className="flex w-full items-center gap-2">
                            <Badge
                              variant={STATUS_VARIANT[t.status]}
                              className="shrink-0"
                            >
                              {STATUS_LABEL[t.status]}
                            </Badge>
                            <span className="truncate text-sm font-medium text-ink">
                              {t.title}
                            </span>
                          </div>
                          <div className="flex w-full flex-wrap gap-x-3 font-mono text-[11px] tabular-nums text-ink-faint">
                            <AgentRef id={t.assignee} />
                            {t.due_at && (
                              <span className={dueUrgencyClass(t.due_at)}>
                                due {formatDate(t.due_at)}
                              </span>
                            )}
                            {t.start_at &&
                              (new Date(t.start_at).getTime() > Date.now() ? (
                                <span className="text-signal-blue">
                                  starts {formatRelativeFutureFromIso(t.start_at)}
                                </span>
                              ) : (
                                <span>starts {formatDate(t.start_at)}</span>
                              ))}
                            {t.depends_on.length > 0 && (
                              <span>
                                {t.depends_on.length} dep
                                {t.depends_on.length === 1 ? "" : "s"}
                              </span>
                            )}
                            {t.comment_count !== undefined &&
                              t.comment_count > 0 && (
                                <span>
                                  {t.comment_count} comment
                                  {t.comment_count === 1 ? "" : "s"}
                                </span>
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </aside>

          <section
            className={cn(
              "flex flex-1 flex-col overflow-hidden",
              !selected ? "hidden md:flex" : "flex"
            )}
          >
            {selected && draft && (
              <button
                type="button"
                onClick={() => router.push("/tasks")}
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
            )}
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
                    free-form body. Status changes are gated by dependencies.
                  </p>
                </div>
              </div>
            ) : (
              <TaskDetailPanel
                variant="pane"
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
          </div>
        )}

        {/* Board mode opens the task in the modal; list mode shows it in
            the side pane above. */}
        <Dialog
          open={viewMode === "board" && !!selected && !!draft}
          onOpenChange={(open) => {
            if (!open) router.push("/tasks");
          }}
        >
              <DialogContent
                showCloseButton={false}
                // Mobile: full-takeover above the bottom tab bar. The
                // Dialog primitive centers via top-50/left-50 + translate;
                // override to top-0/left-0/no-translate so the dialog
                // pins to the top edge and we can subtract the tab-bar
                // height from the dialog height cleanly. Desktop: revert
                // to the centered floating dialog at 94vh × 72rem max.
                className="overflow-hidden left-0 top-0 translate-x-0 translate-y-0 h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom))] w-screen max-w-none md:left-[50%] md:top-[50%] md:translate-x-[-50%] md:translate-y-[-50%] md:h-[94vh] md:max-h-[94vh] md:w-[min(72rem,96vw)] sm:max-w-none"
              >
                <VisuallyHidden.Root>
                  <DialogTitle>{selected?.title ?? "Task"}</DialogTitle>
                  <DialogDescription>
                    Edit task details — title, status, assignee, schedule,
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
                    onClose={() => router.push("/tasks")}
                  />
                )}
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
                            {t.id.slice(0, 8)}
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

function explainAutoCorrect(actual: TaskStatus, requested: TaskStatus): string {
  if (actual === "blocked" && requested === "open") {
    return "Dependencies aren't all done yet.";
  }
  return `Server returned status ${actual} instead of ${requested}.`;
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
