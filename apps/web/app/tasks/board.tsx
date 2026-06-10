"use client";

import { useMemo } from "react";
import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Repeat2 } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { TabularTick } from "@/app/components/ui/tabular-tick";
import { ActiveMarker } from "@/app/components/ui/active-marker";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  dueUrgencyClass,
  formatDate,
  formatRelativeFutureFromIso,
  shortRecurrenceLabel,
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
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

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

  const handleDragEnd = (e: DragEndEvent) => {
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
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex flex-1 gap-3 overflow-x-auto p-3">
        {STATUS_ORDER.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={grouped.get(status) ?? []}
            selectedId={selectedId}
            onPick={onPick}
          />
        ))}
      </div>
    </DndContext>
  );
}

function BoardColumn({
  status,
  tasks,
  selectedId,
  onPick,
}: {
  status: TaskStatus;
  tasks: Task[];
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const ids = useMemo(() => tasks.map((t) => t.id), [tasks]);
  const tint = statusTint(status);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-72 shrink-0 flex-col border border-paper-rule bg-paper-sunk transition-colors",
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
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {tasks.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-2 py-6">
              <span className="label-faceplate text-ink-faint">accepts drops</span>
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
        </SortableContext>
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
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Terminal statuses recede so the eye lands on actionable columns first.
  const terminal = task.status === "done" || task.status === "canceled";
  const titleClass = terminal
    ? task.status === "canceled"
      ? "text-ink-faint"
      : "text-ink-soft"
    : "text-ink";

  return (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      onClick={() => onPick(task.id)}
      className={cn(
        "relative border border-paper-rule bg-paper px-3.5 py-2 text-left transition-colors",
        selected ? "bg-paper-sunk text-ink" : "hover:bg-paper-sunk",
        isDragging && "opacity-50"
      )}
      {...attributes}
      {...listeners}
    >
      <ActiveMarker active={selected} />
      <div className="space-y-1">
        <div className={cn("line-clamp-1 text-sm font-medium", titleClass)}>
          {task.title}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-ink-faint">
          <span>@{task.assignee}</span>
          {task.team && <span>#{task.team}</span>}
          {task.due_at && (
            <span className={dueUrgencyClass(task.due_at)}>
              due {formatDate(task.due_at)}
            </span>
          )}
          {task.start_at &&
            (new Date(task.start_at).getTime() > Date.now() ? (
              <span className="text-signal-blue">
                starts {formatRelativeFutureFromIso(task.start_at)}
              </span>
            ) : (
              <span>starts {formatDate(task.start_at)}</span>
            ))}
          {task.depends_on.length > 0 && (
            <span>
              {task.depends_on.length} dep
              {task.depends_on.length === 1 ? "" : "s"}
            </span>
          )}
          {task.comment_count !== undefined && task.comment_count > 0 && (
            <span>
              {task.comment_count} comment
              {task.comment_count === 1 ? "" : "s"}
            </span>
          )}
          {task.recurrence && (
            <span className="inline-flex items-center gap-0.5">
              <Repeat2 className="size-3" />
              {shortRecurrenceLabel(task.recurrence)}
              {task.runs > 0 && ` · ${task.runs}×`}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
