import * as React from "react";
import { cn } from "@/app/lib/utils";

/**
 * ClaudeThinking — Claude Code's "working" line, from the brainless registry
 * (https://brainless.swerdlow.dev), rethemed to the paper/ink tokens.
 *
 * A pulsing sparkle glyph, a whimsical verb, and a live elapsed hint. The
 * verb carries the understated shimmer: a lighter highlight drifts across
 * the accent word (done with background-clip: text so the DOM text stays
 * selectable and announced). The whole line is a polite live region.
 *
 * Deviations from the terminal capture: the fabricated token counter and the
 * "esc to interrupt" hint are dropped — neither is true in the web chat.
 */
// Captured cycle from claude/thinking frames: · ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const VERBS = [
  "Thinking",
  "Levitating",
  "Schlepping",
  "Herding",
  "Percolating",
  "Noodling",
  "Conjuring",
];

export function ClaudeThinking({
  running = true,
  verbs = VERBS,
  className,
}: {
  running?: boolean;
  verbs?: string[];
  className?: string;
}) {
  const prefersReduced = usePrefersReducedMotion();
  const [glyph, setGlyph] = React.useState(0);
  const [verbIdx, setVerbIdx] = React.useState(0);
  const [secs, setSecs] = React.useState(0);

  React.useEffect(() => {
    if (!running || prefersReduced) return;
    const id = setInterval(() => setGlyph((g) => (g + 1) % GLYPHS.length), 110);
    return () => clearInterval(id);
  }, [running, prefersReduced]);

  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  React.useEffect(() => {
    if (!running) return;
    // Verbs change slowly, like the real thing — not every second.
    const id = setInterval(() => setVerbIdx((v) => (v + 1) % verbs.length), 5200);
    return () => clearInterval(id);
  }, [running, verbs.length]);

  if (!running) return null;

  const verb = verbs[verbIdx % verbs.length];

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex items-center gap-2 font-mono text-[13px]", className)}
    >
      <style>{`
        .cw-verb {
          background-image: linear-gradient(
            100deg,
            var(--plot-red) 43%,
            color-mix(in oklch, var(--plot-red), white 40%) 50%,
            var(--plot-red) 57%
          );
          background-size: 200% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          -webkit-text-fill-color: transparent;
          animation: cw-shine 2.8s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .cw-verb {
            animation: none;
            background-image: none;
            color: var(--plot-red);
            -webkit-text-fill-color: var(--plot-red);
          }
        }
        @keyframes cw-shine {
          from { background-position: 100% 0; }
          to   { background-position: -100% 0; }
        }
      `}</style>
      <span aria-hidden className="inline-block w-[1ch] text-plot-red">
        {prefersReduced ? "✳" : GLYPHS[glyph]}
      </span>
      <span className="cw-verb">{verb}…</span>
      <span className="text-ink-faint">({secs}s)</span>
    </div>
  );
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}
