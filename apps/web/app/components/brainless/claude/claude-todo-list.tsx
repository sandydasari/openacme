import { cn } from "@/app/lib/utils";

/**
 * ClaudeTodoList — Claude Code's task list, from the brainless registry
 * (https://brainless.swerdlow.dev), rethemed to the paper/ink tokens.
 *
 * Capture grammar (v2.1.207), with one intentional deviation: icons stay in a
 * single column. Real Claude puts `  ⎿ ` before the first ✔ (space + nbsp),
 * which shoves that check a cell right of a natural `⎿ ` pairing — we use a
 * single space after ⎿ so ✔ / ◼ / ◻ line up.
 *
 *   ⎿ ✔ done     (signal-green + strikethrough)
 *     ◼ active   (plot-red + bold)
 *     ◻ pending  (default ink)
 */
export type Todo = {
  label: string;
  status: "done" | "active" | "todo";
};

const ICON: Record<Todo["status"], string> = {
  done: "✔",
  active: "◼",
  todo: "◻",
};

export function ClaudeTodoList({
  todos,
  className,
}: {
  todos: Todo[];
  className?: string;
}) {
  return (
    <ol className={cn("font-mono text-[13px] leading-[1.6] text-ink", className)}>
      {todos.map((t, i) => (
        <li key={i} className="whitespace-pre">
          {/*
            First row: "  ⎿ " then icon. Later rows: four spaces so the
            icon column lines up under ✔ (no capture-style nbsp jump).
          */}
          <span aria-hidden className="text-ink-faint">
            {i === 0 ? "  ⎿ " : "    "}
          </span>
          <span
            aria-hidden
            className={cn(
              t.status === "done" && "text-signal-green",
              t.status === "active" && "text-plot-red"
            )}
          >
            {ICON[t.status]}{" "}
          </span>
          <span
            className={cn(
              t.status === "done" && "line-through text-ink-faint",
              t.status === "active" && "font-semibold"
            )}
          >
            {t.label}
            <span className="sr-only">
              {" "}
              ({t.status === "done"
                ? "completed"
                : t.status === "active"
                  ? "in progress"
                  : "pending"})
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
