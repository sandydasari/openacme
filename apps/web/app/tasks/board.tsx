import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Repeat2 } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { TabularTick } from "@/app/components/ui/tabular-tick";
import { ActiveMarker } from "@/app/components/ui/active-marker";
import { AgentRef } from "@/app/components/ui/agent-ref";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  dueUrgencyClass,
  formatDate,
  formatRelativeFromIso,
  recurrenceTitle,
  type Task,
  type TaskStatus,
} from "./types";

// Column eyebrow + count tint by status role (DESIGN.md §2).
// open → neutral (ink-soft); in_progress → WORKING (signal-blue);
// blocked → WAIT (signal-amber); done/canceled → terminal recess.
function statusTint(status: TaskStatus): { label: string; dot: string } {
  switch (status) {
    case "in_progress":
      return { label: "text-signal-blue", dot: "bg-signal-blue" };
    case "blocked":
      return { label: "text-signal-amber", dot: "bg-signal-amber" };
    case "done":
      return { label: "text-ink-soft", dot: "bg-ink-soft" };
    case "canceled":
      return { label: "text-ink-faint", dot: "bg-ink-faint" };
    case "open":
    default:
      return { label: "text-ink", dot: "bg-ink" };
  }
}

export interface TasksBoardProps {
  tasks: Task[];
  selectedId: string | null;
  onPick: (id: string) => void;
  onMove: (id: string, target: TaskStatus) => void;
}

export function TasksBoard({ tasks, selectedId, onPick, onMove }: TasksBoardProps) {
  const sensors = useSensors(
    // 6px slop separates a click-to-open from a drag; the old 4px fired
    // drags on near-stationary clicks, which read as the card "sticking".
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  // The id of the card currently being dragged — drives the floating
  // overlay and the source-card placeholder. Null at rest.
  const [activeId, setActiveId] = useState<string | null>(null);

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

  const activeTask = activeId
    ? (tasks.find((t) => t.id === activeId) ?? null)
    : null;

  const handleDragStart = (e: DragStartEvent) => {
    setActiveId(e.active.id as string);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const id = e.active.id as string;
    const target = e.over?.id as string | undefined;
    if (!target) return;
    if (!STATUS_ORDER.includes(target as TaskStatus)) return;
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    if (t.status === target) return;
    onMove(id, target as TaskStatus);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={handleDragEnd}
    >
      {/* Columns stack vertically under md; md–xl keeps fixed-width columns
          with horizontal scroll (five even columns would be ~130px at md);
          at xl+ the columns split the viewport so the board fits one screen. */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3 md:flex-row md:overflow-y-hidden md:overflow-x-auto xl:overflow-hidden">
        {STATUS_ORDER.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={grouped.get(status) ?? []}
            selectedId={selectedId}
            onPick={onPick}
            dragging={activeId !== null}
          />
        ))}
      </div>
      {/* The dragged card rides a portal overlay that tracks the cursor 1:1
          — the source stays put as a dimmed placeholder. No sibling reflow,
          no transform lag on the real card. */}
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div className="rotate-1 cursor-grabbing shadow-[0_8px_24px_-6px_rgba(0,0,0,0.35)]">
            <CardInner task={activeTask} selected={false} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  status,
  tasks,
  selectedId,
  onPick,
  dragging,
}: {
  status: TaskStatus;
  tasks: Task[];
  selectedId: string | null;
  onPick: (id: string) => void;
  dragging: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const tint = statusTint(status);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-full shrink-0 flex-col border border-paper-rule bg-paper-sunk transition-colors md:w-72 xl:w-auto xl:min-w-0 xl:flex-1",
        isOver && "border-plot-red bg-paper"
      )}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-paper-rule bg-paper px-3 py-2">
        <span className="flex items-center gap-2">
          <span aria-hidden className={cn("status-dot", tint.dot)} />
          <span
            className={cn(
              "font-mono text-[11px] uppercase tracking-[0.08em]",
              tint.label
            )}
          >
            {STATUS_LABEL[status]}
          </span>
        </span>
        <TabularTick
          value={tasks.length}
          className={cn("text-[11px]", tint.label)}
        />
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
        {tasks.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-2 py-6">
            {dragging && (
              <span className="label-faceplate text-ink-faint">accepts drops</span>
            )}
          </div>
        ) : (
          tasks.map((t) => (
            <BoardCard
              key={t.id}
              task={t}
              selected={selectedId === t.id}
              onPick={onPick}
            />
          ))
        )}
      </div>
    </div>
  );
}

function BoardCard({
  task,
  selected,
  onPick,
}: {
  task: Task;
  selected: boolean;
  onPick: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });

  // No transform on the source — the DragOverlay owns the motion. The
  // source just recedes to a placeholder so the column slot stays put.
  return (
    <div
      ref={setNodeRef}
      onClick={() => onPick(task.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick(task.id);
        }
      }}
      className={cn(
        "touch-none",
        isDragging && "opacity-40"
      )}
      {...attributes}
      {...listeners}
    >
      <CardInner task={task} selected={selected} />
    </div>
  );
}

// Presentational card body — shared by the in-column card and the drag
// overlay so the floating clone is pixel-identical to its source.
function CardInner({ task, selected }: { task: Task; selected: boolean }) {
  // Terminal statuses recede so the eye lands on actionable columns first.
  const terminal = task.status === "done" || task.status === "canceled";
  const titleClass = terminal
    ? task.status === "canceled"
      ? "text-ink-faint"
      : "text-ink-soft"
    : "text-ink";

  return (
    <div
      className={cn(
        "relative cursor-pointer border border-paper-rule bg-paper px-3.5 py-2 text-left transition-colors",
        selected ? "bg-paper-sunk text-ink" : "hover:bg-paper-sunk"
      )}
    >
      <ActiveMarker active={selected} />
      <div className="space-y-1">
        <div className={cn("line-clamp-2 text-sm font-medium", titleClass)}>
          {task.title}
        </div>
        {/* Card meta stays glanceable: who, urgency, why-not-running.
            Team, past starts, and comment counts live in the detail pane. */}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-ink-faint">
          <span>#{task.id}</span>
          <AgentRef id={task.assignee} />
          {task.due_at && (
            <span
              className={dueUrgencyClass(task.due_at)}
              title={formatDate(task.due_at)}
            >
              due {formatRelativeFromIso(task.due_at)}
            </span>
          )}
          {task.start_at && new Date(task.start_at).getTime() > Date.now() && (
            <span
              className="text-signal-blue"
              title={formatDate(task.start_at)}
            >
              starts {formatRelativeFromIso(task.start_at)}
            </span>
          )}
          {task.status === "blocked" && task.depends_on.length > 0 && (
            <span>
              {task.depends_on.length} dep
              {task.depends_on.length === 1 ? "" : "s"}
            </span>
          )}
          {/* Recurrence at card altitude is a marker, not a schedule:
              icon only, schedule + run count in the tooltip. */}
          {task.recurrence && (
            <span
              title={
                task.runs > 0
                  ? `${recurrenceTitle(task.recurrence)} · ${task.runs} runs`
                  : recurrenceTitle(task.recurrence)
              }
            >
              <Repeat2 className="size-3" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
