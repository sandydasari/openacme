import { cn } from "@/app/lib/utils";

/**
 * ClaudeDiff — Claude Code's inline edit hunk (the ⏺ Update / ⎿ summary + the
 * +/- lines), from the brainless registry (https://brainless.swerdlow.dev),
 * rethemed to the paper/ink tokens. Added/removed rows carry semantic tinted
 * backgrounds and an off-screen "added"/"removed" label so the diff is
 * legible without color.
 */
export type DiffLine = {
  type: "add" | "del" | "ctx";
  n?: number;
  text: string;
};

export function ClaudeDiff({
  file,
  summary,
  lines,
  className,
}: {
  file: string;
  summary?: string;
  lines: DiffLine[];
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 font-mono text-[13px] leading-[1.55]", className)}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span aria-hidden className="shrink-0 text-signal-green">
          ⏺
        </span>
        <span className="text-ink">Update</span>
        <span className="min-w-0 break-all">
          <span className="text-ink-faint">(</span>
          <span className="text-signal-blue">{file}</span>
          <span className="text-ink-faint">)</span>
        </span>
      </div>
      {summary ? (
        <div className="flex min-w-0 items-baseline gap-2 text-ink-soft">
          {/* invisible status glyph spacer: aligns ⎿ under "Update" */}
          <span aria-hidden className="invisible shrink-0">
            ⏺
          </span>
          <span aria-hidden className="shrink-0 text-ink-faint">
            ⎿
          </span>
          <span className="min-w-0 break-words">{summary}</span>
        </div>
      ) : null}

      <pre className="mt-1 min-w-0 overflow-x-auto rounded-none border border-paper-rule bg-paper-sunk py-1.5 pl-2 pr-3">
        {lines.map((l, i) => {
          const mark = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
          return (
            <div
              key={i}
              className={cn(
                "flex min-w-0",
                l.type === "add" && "bg-signal-green/[0.08]",
                l.type === "del" && "bg-destructive/[0.08]"
              )}
            >
              <span className="w-9 shrink-0 select-none pr-2 text-right text-ink-faint">
                {l.n ?? ""}
              </span>
              <span
                className={cn(
                  "w-3 shrink-0 select-none",
                  l.type === "add"
                    ? "text-signal-green"
                    : l.type === "del"
                      ? "text-destructive"
                      : "text-ink-faint"
                )}
              >
                {mark}
              </span>
              <span
                className={cn(
                  "min-w-0 break-all",
                  l.type === "ctx" ? "text-ink-soft" : "text-ink"
                )}
              >
                {l.type !== "ctx" ? (
                  <span className="sr-only">
                    {l.type === "add" ? "added: " : "removed: "}
                  </span>
                ) : null}
                {l.text}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
