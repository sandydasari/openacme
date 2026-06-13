"use client";

import { useEffect, useRef, useState } from "react";
import { useInView, usePrefersReducedMotion } from "./hooks";

export type TermLine =
  | { kind: "cmd"; text: string }
  | { kind: "out"; text: string; tone?: "dim" | "ok" | "red" };

const TYPE_MS = 28;
const OUT_MS = 90;
const PAUSE_AFTER_CMD = 350;

export function Terminal({
  title = "zsh — ~/acme",
  lines,
}: {
  title?: string;
  lines: TermLine[];
}) {
  const [ref, inView] = useInView<HTMLDivElement>(0.35);
  const reduced = usePrefersReducedMotion();
  // rendered[i] = chars of line i revealed so far (full text once passed)
  const [progress, setProgress] = useState<{ line: number; chars: number }>({
    line: 0,
    chars: 0,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const done = progress.line >= lines.length;

  useEffect(() => {
    if (!inView) return;
    if (reduced) {
      setProgress({ line: lines.length, chars: 0 });
      return;
    }
    if (done) return;
    const current = lines[progress.line];
    if (!current) return;
    if (current.kind === "cmd") {
      if (progress.chars < current.text.length) {
        timer.current = setTimeout(
          () => setProgress((p) => ({ ...p, chars: p.chars + 1 })),
          TYPE_MS,
        );
      } else {
        timer.current = setTimeout(
          () => setProgress((p) => ({ line: p.line + 1, chars: 0 })),
          PAUSE_AFTER_CMD,
        );
      }
    } else {
      timer.current = setTimeout(
        () => setProgress((p) => ({ line: p.line + 1, chars: 0 })),
        OUT_MS,
      );
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [inView, reduced, progress, lines, done]);

  return (
    <div
      ref={ref}
      className="border border-paper-rule bg-code-surface text-left font-mono text-[13px] leading-relaxed"
    >
      <div className="flex items-center justify-between border-b border-paper-rule px-4 py-2">
        <span className="text-[11px] tracking-[0.08em] text-ink-faint uppercase">
          {title}
        </span>
        <span className="text-[11px] tracking-[0.08em] text-ink-faint">
          BASH
        </span>
      </div>
      <div className="min-h-64 px-4 py-4">
        {lines.slice(0, progress.line + 1).map((line, i) => {
          const isCurrent = i === progress.line;
          if (i >= lines.length) return null;
          if (line.kind === "cmd") {
            const text = isCurrent
              ? line.text.slice(0, progress.chars)
              : line.text;
            return (
              <div key={i} className="text-ink">
                <span className="text-ink-faint">$ </span>
                {text}
                {isCurrent && !done && (
                  <span className="ml-px inline-block h-[1.05em] w-[7px] translate-y-[0.15em] bg-plot-red pulse-live" />
                )}
              </div>
            );
          }
          if (isCurrent && progress.chars === 0 && !done && !line.text) {
            return null;
          }
          return (
            <div
              key={i}
              className={
                line.tone === "ok"
                  ? "text-signal-green"
                  : line.tone === "red"
                    ? "text-plot-red"
                    : "text-ink-soft"
              }
            >
              {line.text || " "}
            </div>
          );
        })}
        {done && (
          <div className="text-ink">
            <span className="text-ink-faint">$ </span>
            <span className="ml-px inline-block h-[1.05em] w-[7px] translate-y-[0.15em] bg-plot-red pulse-live" />
          </div>
        )}
      </div>
    </div>
  );
}
