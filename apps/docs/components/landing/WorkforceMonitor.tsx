"use client";

import { useEffect, useState } from "react";
import { PixelAvatar } from "./PixelAvatar";
import { usePrefersReducedMotion } from "./hooks";

type AgentId = "manager" | "analyst" | "writer" | "engineer";
type Status = "idle" | "working" | "done";

type Ev = {
  agent: AgentId;
  text: string;
  tone?: "ok" | "soft" | "sys";
  set?: Partial<Record<AgentId, Status>>;
};

const AGENTS: { id: AgentId; role: string }[] = [
  { id: "manager", role: "Triage & routing" },
  { id: "analyst", role: "Research & briefs" },
  { id: "writer", role: "Drafts & posts" },
  { id: "engineer", role: "Code & CI" },
];

const SCRIPT: Ev[] = [
  {
    agent: "analyst",
    text: "claimed #12 — summarize last week's support threads",
    set: { analyst: "working" },
  },
  { agent: "engineer", text: "shell: pnpm test — 42 passed", tone: "soft" },
  {
    agent: "writer",
    text: "claimed #14 — draft the launch post",
    set: { writer: "working" },
  },
  { agent: "analyst", text: "commented on #12 — themes attached", tone: "soft" },
  {
    agent: "manager",
    text: "reassigned #15 → engineer",
    tone: "sys",
    set: { engineer: "working" },
  },
  { agent: "analyst", text: "#12 done", tone: "ok", set: { analyst: "done" } },
  { agent: "writer", text: "browser: reviewing the docs pages", tone: "soft" },
  { agent: "engineer", text: "claimed #15 — fix the flaky auth test", tone: "soft" },
  {
    agent: "writer",
    text: "commented on #14 — draft ready for review",
    tone: "soft",
  },
  {
    agent: "manager",
    text: "created #16 — weekly metrics (recurring)",
    tone: "sys",
    set: { analyst: "idle" },
  },
  { agent: "writer", text: "#14 done", tone: "ok", set: { writer: "done" } },
  {
    agent: "engineer",
    text: "#15 done",
    tone: "ok",
    set: { engineer: "done", writer: "idle" },
  },
];

const STATUS: Record<Status, { dot: string; label: string }> = {
  idle: { dot: "bg-paper-rule", label: "idle" },
  working: { dot: "bg-signal-blue pulse-live", label: "working" },
  done: { dot: "bg-signal-green", label: "done" },
};

function clock(step: number) {
  const total = 34862 + step * 9;
  const hh = Math.floor(total / 3600) % 24;
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, "0")).join(":");
}

const VISIBLE = 6;
const REST_TICKS = 4; // quiet beats before the loop restarts

export function WorkforceMonitor({ className = "" }: { className?: string }) {
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = useState(reduced ? SCRIPT.length : 0);

  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setStep((s) => s + 1), 1500);
    return () => clearInterval(t);
  }, [reduced]);

  const cycle = step % (SCRIPT.length + REST_TICKS);
  const played = reduced
    ? SCRIPT.length
    : Math.min(cycle === 0 && step > 0 ? SCRIPT.length : cycle, SCRIPT.length);
  const feed = SCRIPT.slice(Math.max(0, played - VISIBLE), played);
  const statuses: Record<AgentId, Status> = {
    manager: "idle",
    analyst: "idle",
    writer: "idle",
    engineer: "idle",
  };
  for (const ev of SCRIPT.slice(0, played)) Object.assign(statuses, ev.set);

  return (
    <div
      className={`flex flex-col border border-paper-rule bg-paper text-left ${className}`}
      aria-label="Simulated workforce activity"
    >
      <div className="flex items-center justify-between border-b border-paper-rule px-4 py-2.5">
        <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.14em] text-ink-soft uppercase">
          <span className="size-1.5 bg-signal-green pulse-live" />
          Workforce — live
        </span>
        <span className="font-mono text-[11px] tracking-[0.1em] text-ink-faint tabular-nums">
          {clock(step)}
        </span>
      </div>

      <div className="grid grid-cols-2 border-b border-paper-rule">
        {AGENTS.map((a, i) => {
          const s = STATUS[statuses[a.id]];
          return (
            <div
              key={a.id}
              className={`flex items-center gap-3 px-4 py-3 ${i % 2 === 0 ? "border-r" : ""} ${i < 2 ? "border-b" : ""} border-paper-rule`}
            >
              <PixelAvatar seed={a.id} className="size-6 shrink-0 text-ink" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[11px] tracking-[0.08em] text-ink uppercase">
                  {a.id}
                </p>
                <p className="truncate text-[11px] text-ink-faint">{a.role}</p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] text-ink-faint uppercase">
                <span className={`size-1.5 ${s.dot}`} />
                <span className="hidden sm:inline">{s.label}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex min-h-[172px] flex-col justify-end gap-[7px] px-4 py-3 font-mono text-[11.5px] leading-snug">
        {feed.length === 0 ? (
          <p className="text-ink-faint">— dispatcher tick —</p>
        ) : (
          feed.map((ev, i) => {
            const idx = played - feed.length + i;
            return (
              <p
                key={idx}
                className={`flex gap-2.5 truncate ${i === feed.length - 1 ? "monitor-line-in" : ""}`}
              >
                <span className="shrink-0 text-ink-faint tabular-nums">
                  {clock(idx)}
                </span>
                <span className="shrink-0 text-ink">{ev.agent}</span>
                <span
                  className={`truncate ${
                    ev.tone === "ok"
                      ? "text-signal-green"
                      : ev.tone === "sys"
                        ? "text-signal-amber"
                        : "text-ink-soft"
                  }`}
                >
                  {ev.text}
                  {ev.tone === "ok" ? " ✓" : ""}
                </span>
              </p>
            );
          })
        )}
      </div>
    </div>
  );
}
