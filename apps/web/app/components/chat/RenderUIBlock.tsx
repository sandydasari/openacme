import { useMemo } from "react";
import {
  ClaudeTodoList,
  type Todo,
} from "@/app/components/brainless/claude/claude-todo-list";
import {
  ClaudeDiff,
  type DiffLine,
} from "@/app/components/brainless/claude/claude-diff";
import { ToolBlock, editToFile, type ToolPart } from "@/app/components/ToolBlock";

/*
 * Renders a `tool-render_ui` part with the brainless component the agent
 * picked (todo_list, diff). The tool is presentation-only: everything here
 * comes from the call's INPUT, so blocks render progressively while the
 * arguments stream. Anything unrecognized falls back to the generic ToolBlock.
 */

const TODO_STATUSES = new Set<Todo["status"]>(["done", "active", "todo"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseTodos(v: unknown): Todo[] {
  if (!Array.isArray(v)) return [];
  const todos: Todo[] = [];
  for (const item of v) {
    // Tolerate partial items mid-stream — label lands before status.
    if (!isObj(item) || typeof item.label !== "string" || !item.label) continue;
    const status = TODO_STATUSES.has(item.status as Todo["status"])
      ? (item.status as Todo["status"])
      : "todo";
    todos.push({ label: item.label, status });
  }
  return todos;
}

function diffLines(file: string, oldText: string, newText: string): DiffLine[] {
  const hunk = editToFile(file, oldText, newText).hunks[0];
  if (!hunk) return [];
  return hunk.lines.map((l) => ({
    type: l.type === "+" ? "add" : l.type === "-" ? "del" : "ctx",
    text: l.text,
  }));
}

function Title({ title }: { title?: string }) {
  if (!title) return null;
  return (
    <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
      {title}
    </div>
  );
}

export function RenderUIBlock({ part }: { part: ToolPart }) {
  const input = isObj(part.input) ? part.input : undefined;
  const component = input && typeof input.component === "string"
    ? input.component
    : undefined;

  const todos = useMemo(
    () => (component === "todo_list" ? parseTodos(input?.todos) : []),
    [component, input?.todos]
  );

  const diff = useMemo(() => {
    if (component !== "diff" || typeof input?.file !== "string" || !input.file) {
      return null;
    }
    const oldText = typeof input.old_text === "string" ? input.old_text : "";
    const newText = typeof input.new_text === "string" ? input.new_text : "";
    if (oldText === "" && newText === "") return null;
    const f = editToFile(input.file, oldText, newText);
    return {
      file: input.file,
      summary: [
        f.added > 0 && `${f.added} ${f.added === 1 ? "addition" : "additions"}`,
        f.removed > 0 && `${f.removed} ${f.removed === 1 ? "removal" : "removals"}`,
      ]
        .filter(Boolean)
        .join(", "),
      lines: diffLines(input.file, oldText, newText),
    };
  }, [component, input?.file, input?.old_text, input?.new_text]);

  // Failed calls show as a regular tool block so the error is visible.
  if (part.state === "output-error") return <ToolBlock part={part} />;

  const title = input && typeof input.title === "string" ? input.title : undefined;

  if (component === "todo_list" && todos.length > 0) {
    return (
      <div className="section-enter">
        <Title title={title} />
        <ClaudeTodoList todos={todos} />
      </div>
    );
  }

  if (component === "diff" && diff) {
    return (
      <div className="section-enter">
        <Title title={title} />
        <ClaudeDiff file={diff.file} summary={diff.summary} lines={diff.lines} />
      </div>
    );
  }

  // Arguments still streaming (or an unknown component from a newer server):
  // nothing renderable yet. Completed-but-unrecognized falls back to raw I/O.
  if (part.state === "output-available") return <ToolBlock part={part} />;
  return null;
}
