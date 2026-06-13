"use client";

import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "./hooks";

/* Looping simulation of the task lifecycle: a card appears in OPEN,
   the dispatcher wakes the assignee, work happens, the result lands,
   the card moves to DONE. */

const PHASES = [
  { col: 0, note: "task created — assigned to analyst" },
  { col: 0, note: "dispatcher tick — analyst wakes" },
  { col: 1, note: "analyst claimed #14" },
  { col: 1, note: "web_search · browser — 4 sources" },
  { col: 1, note: "result posted as a comment" },
  { col: 2, note: "#14 done — you read it when you're back" },
  { col: 2, note: "" },
] as const;

const STEP_MS = 1700;

const GHOSTS: Record<number, { title: string; who: string }[]> = {
  0: [
    { title: "#16 weekly metrics", who: "analyst · mon 09:00" },
    { title: "#17 customer follow-ups", who: "team · manager triages" },
  ],
  1: [{ title: "#15 fix flaky auth test", who: "engineer" }],
  2: [
    { title: "#12 support themes", who: "analyst" },
    { title: "#11 release notes", who: "writer" },
  ],
};

const COLS = [
  ["Open", "bg-signal-amber"],
  ["In progress", "bg-signal-blue"],
  ["Done", "bg-signal-green"],
] as const;

export function DispatchBoard() {
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = useState(reduced ? PHASES.length - 2 : 0);

  useEffect(() => {
    if (reduced) return;
    const t = setInterval(
      () => setStep((s) => (s + 1) % PHASES.length),
      STEP_MS,
    );
    return () => clearInterval(t);
  }, [reduced]);

  const phase = PHASES[step]!;
  const working = phase.col === 1;
  const done = phase.col === 2;
  const toolLine = step === 3;

  return (
    <div className="border border-paper-rule">
      {/* Column headers */}
      <div className="grid grid-cols-3 border-b border-paper-rule">
        {COLS.map(([c, dot], i) => (
          <div
            key={c}
            className={`flex items-center justify-between px-4 py-2.5 ${i > 0 ? "border-l border-paper-rule" : ""}`}
          >
            <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.14em] text-ink-faint uppercase">
              <span className={`size-1.5 ${dot}`} />
              {c}
            </span>
            <span className="font-mono text-[11px] text-ink-faint tabular-nums">
              {(GHOSTS[i]?.length ?? 0) + (phase.col === i ? 1 : 0)}
            </span>
          </div>
        ))}
      </div>

      {/* Lanes */}
      <div className="relative grid min-h-[270px] grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={`flex flex-col gap-2 p-3 ${i > 0 ? "border-l border-paper-rule" : ""}`}
          >
            {/* hold space so the live card can overlay slot 0 */}
            <div className="invisible">
              <GhostCard title="#14" who="analyst" />
            </div>
            {GHOSTS[i]!.map((g) => (
              <GhostCard key={g.title} title={g.title} who={g.who} />
            ))}
          </div>
        ))}

        {/* The live card */}
        <div
          className="absolute top-3 w-1/3 px-3 transition-[left] duration-300 ease-out"
          style={{ left: `${phase.col * 33.333}%` }}
        >
          <div
            className={`border bg-paper p-3 transition-colors ${
              working ? "border-ink-faint" : "border-paper-rule"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px] font-semibold tracking-tight">
                #14 competitor pricing brief
              </span>
              {done ? (
                <span className="shrink-0 font-mono text-[11px] text-signal-green">
                  ✓
                </span>
              ) : working ? (
                <span className="size-1.5 shrink-0 bg-signal-blue pulse-live" />
              ) : null}
            </div>
            <p className="mt-1.5 font-mono text-[10.5px] tracking-[0.08em] text-ink-faint uppercase">
              analyst
            </p>
            {toolLine && (
              <p className="mt-2 truncate border-t border-paper-rule pt-2 font-mono text-[10.5px] text-ink-soft">
                web_search · browser · memory
              </p>
            )}
            {step === 4 && (
              <p className="mt-2 truncate border-t border-paper-rule pt-2 font-mono text-[10.5px] text-ink-soft">
                ↳ comment: &ldquo;Three plans changed…&rdquo;
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Event line */}
      <div className="flex items-center gap-2.5 border-t border-paper-rule px-4 py-2.5 font-mono text-[11.5px]">
        <span
          className={`size-1.5 shrink-0 ${done ? "bg-signal-green" : "bg-plot-red pulse-live"}`}
        />
        <span key={step} className="monitor-line-in truncate text-ink-soft">
          {phase.note || "queue clear — agents back to idle"}
        </span>
      </div>
    </div>
  );
}

function GhostCard({ title, who }: { title: string; who: string }) {
  return (
    <div className="border border-paper-rule p-3 opacity-55">
      <p className="truncate text-[13px] font-medium tracking-tight">{title}</p>
      <p className="mt-1.5 truncate font-mono text-[10.5px] tracking-[0.08em] text-ink-faint uppercase">
        {who}
      </p>
    </div>
  );
}
