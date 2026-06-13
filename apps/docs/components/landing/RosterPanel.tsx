"use client";

import { useEffect, useRef, useState } from "react";
import { PixelAvatar } from "./PixelAvatar";
import { ScrambleText } from "./ScrambleText";
import { usePrefersReducedMotion } from "./hooks";

type Role = {
  id: string;
  title: string;
  blurb: string;
  model: string;
  tools: string[];
  skills: string[];
  persona: string;
};

const ROLES: Role[] = [
  {
    id: "manager",
    title: "Chief of staff",
    blurb: "Triages everything sent to the team — claims, reassigns, or splits.",
    model: "claude-opus-4",
    tools: ["task_create", "task_update", "agent_list", "web_search"],
    skills: ["weekly-report"],
    persona:
      "You run the team's queue. When work arrives unaddressed, decide who takes it — don't relay, decide. Split anything that needs two people.",
  },
  {
    id: "analyst",
    title: "Research analyst",
    blurb: "Watches competitors and changelogs, reports what changed and why.",
    model: "claude-sonnet-4",
    tools: ["web_search", "web_extract", "browser", "read_file"],
    skills: ["competitor-brief", "sources-cited"],
    persona:
      "You track the market. Every claim carries a source link. When something changes — pricing, positioning, a launch — write the brief before being asked.",
  },
  {
    id: "writer",
    title: "Writer",
    blurb: "Drafts replies, release notes, and launch posts in your voice.",
    model: "gpt-5",
    tools: ["read_file", "write_file", "web_search", "browser"],
    skills: ["brand-voice", "release-notes"],
    persona:
      "You write the way the company speaks: plain sentences, no hype, verbs over adjectives. Drafts go to the task thread, never straight to publish.",
  },
  {
    id: "engineer",
    title: "Engineer",
    blurb: "Owns implementation, review, and CI hygiene on the codebase.",
    model: "claude-opus-4",
    tools: ["shell", "edit", "apply_patch", "execute_code", "browser"],
    skills: ["code-review", "ci-triage"],
    persona:
      "You ship small, reviewed changes. Run the tests before you claim something works. When CI breaks, you own it until it's green.",
  },
];

export function RosterPanel() {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState(0);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (reduced || pinned) return;
    timer.current = setInterval(
      () => setActive((a) => (a + 1) % ROLES.length),
      4500,
    );
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [reduced, pinned]);

  const role = ROLES[active]!;

  return (
    <div className="grid border border-paper-rule lg:grid-cols-12">
      {/* Role list */}
      <div className="flex flex-col border-b border-paper-rule lg:col-span-5 lg:border-r lg:border-b-0">
        {ROLES.map((r, i) => {
          const isActive = i === active;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                setPinned(true);
                setActive(i);
              }}
              aria-pressed={isActive}
              className={`group relative flex items-center gap-4 border-b border-paper-rule px-5 py-5 text-left transition-colors last:border-b-0 focus-scribe ${
                isActive ? "bg-paper-sunk" : "hover:bg-paper-sunk/60"
              }`}
            >
              <span
                className={`absolute top-0 left-0 h-full w-[2px] transition-colors ${
                  isActive ? "bg-plot-red" : "bg-transparent"
                }`}
              />
              <span className="font-mono text-[11px] text-ink-faint tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>
              <PixelAvatar
                seed={r.id}
                className={`size-7 shrink-0 transition-colors ${isActive ? "text-ink" : "text-ink-faint"}`}
              />
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold tracking-tight">
                  {r.title}
                </span>
                <span className="mt-0.5 block truncate text-[12.5px] text-ink-soft">
                  {r.blurb}
                </span>
              </span>
            </button>
          );
        })}
        <p className="hidden flex-1 items-end px-5 py-4 font-mono text-[10px] tracking-[0.14em] text-ink-faint uppercase lg:flex">
          Add one, retire one, change a model — you&apos;re the org chart.
        </p>
      </div>

      {/* Dossier — the agent's actual file */}
      <div className="flex flex-col bg-code-surface lg:col-span-7">
        <div className="flex items-center justify-between border-b border-paper-rule px-5 py-2.5">
          <span className="font-mono text-[11px] tracking-[0.1em] text-ink-faint">
            agents/{role.id}/AGENT.md
          </span>
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-ink-faint uppercase">
            <span className="size-1.5 bg-signal-green" />
            on roster
          </span>
        </div>
        <div
          key={role.id}
          className="flex-1 px-5 py-4 font-mono text-[12.5px] leading-[1.85]"
        >
          <p className="text-ink-faint">---</p>
          <p>
            <span className="text-ink-faint">name: </span>
            <span className="font-semibold text-ink">
              <ScrambleText text={role.title} durationMs={350} />
            </span>
          </p>
          <p>
            <span className="text-ink-faint">model: </span>
            <span className="text-ink">{role.model}</span>
          </p>
          <p className="truncate">
            <span className="text-ink-faint">tools: </span>
            <span className="text-ink-soft">[{role.tools.join(", ")}]</span>
          </p>
          <p className="truncate">
            <span className="text-ink-faint">skills: </span>
            <span className="text-ink-soft">[{role.skills.join(", ")}]</span>
          </p>
          <p className="text-ink-faint">---</p>
          <p className="mt-3 max-w-[52ch] font-sans text-[13.5px] leading-relaxed text-ink-soft">
            {role.persona}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-paper-rule px-5 py-3 font-mono text-[10.5px] tracking-[0.1em] text-ink-faint uppercase">
          <span>memory/MEMORY.md</span>
          <span>workspace/</span>
          <span>resources/</span>
          <span>own browser profile</span>
        </div>
      </div>
    </div>
  );
}
