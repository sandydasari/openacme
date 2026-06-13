"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePrefersReducedMotion } from "./hooks";
import { TONE_BG, TONE_TEXT, type Tone } from "./Section";

/* Small looping demos for the capability bento. Each renders a meaningful
   static frame under prefers-reduced-motion. */

function useTicker(intervalMs: number, enabled = true) {
  const reduced = usePrefersReducedMotion();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduced || !enabled) return;
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [reduced, enabled, intervalMs]);
  return { tick, reduced };
}

export function BentoCell({
  index,
  label,
  title,
  body,
  children,
  tone = "red",
  className = "",
}: {
  index: string;
  label: string;
  title: string;
  body: string;
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={`relative flex flex-col gap-4 border-b border-paper-rule p-6 sm:border-r ${className}`}
    >
      <span
        aria-hidden
        className={`absolute top-0 left-0 h-[2px] w-9 ${TONE_BG[tone]}`}
      />
      <div>
        <p className="font-mono text-[10.5px] tracking-[0.16em] uppercase">
          <span className={TONE_TEXT[tone]}>{index}</span>
          <span className="ml-2.5 text-ink-faint">{label}</span>
        </p>
        <h3 className="mt-2.5 text-[16px] font-semibold tracking-tight">
          {title}
        </h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
          {body}
        </p>
      </div>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

/* ---- Memory: a MEMORY.md that keeps learning ---- */

const MEMORY_BASE = [
  "- Invoices: totals in EUR, net-30",
  "- Weekly report ships monday 09:00",
  "- Plain sentences, no hype",
];
const MEMORY_NEW = [
  "- Pricing page moved to /pricing-v2",
  "- Acme Corp renewed — 2 seats",
  "- Prefers tables over prose",
];

export function MemoryDemo() {
  const { tick, reduced } = useTicker(110);
  const which = Math.floor(tick / 60) % MEMORY_NEW.length;
  const line = MEMORY_NEW[which]!;
  const phase = tick % 60;
  const chars = Math.min(phase * 2, line.length);
  const shown = reduced ? MEMORY_NEW[0]! : line.slice(0, chars);
  const typingDone = reduced || chars >= line.length;

  return (
    <div className="border border-paper-rule bg-code-surface font-mono text-[12px] leading-[1.9]">
      <div className="border-b border-paper-rule px-4 py-2 text-[10.5px] tracking-[0.1em] text-ink-faint">
        memory/MEMORY.md
      </div>
      <div className="px-4 py-3">
        {MEMORY_BASE.map((l) => (
          <p key={l} className="truncate text-ink-soft">
            {l}
          </p>
        ))}
        <p className="truncate">
          <span className={typingDone ? "text-ink" : "text-ink-soft"}>
            {shown}
          </span>
          {!typingDone && (
            <span className="ml-px inline-block h-[1em] w-[6px] translate-y-[0.1em] bg-signal-violet" />
          )}
          {typingDone && (
            <span className="ml-2 text-[10px] tracking-[0.1em] text-signal-green uppercase">
              saved
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

/* ---- Skills: install from anywhere ---- */

const SKILLS = ["competitor-brief", "release-notes", "invoice-formatter"];

export function SkillsDemo() {
  const { tick, reduced } = useTicker(110);
  const which = Math.floor(tick / 50) % SKILLS.length;
  const name = SKILLS[which]!;
  const cmd = `openacme skills install ${name}`;
  const phase = tick % 50;
  const chars = Math.min(phase * 2, cmd.length);
  const typed = reduced ? `openacme skills install ${SKILLS[0]}` : cmd.slice(0, chars);
  const installed = reduced || chars >= cmd.length;

  return (
    <div className="border border-paper-rule bg-code-surface px-4 py-3 font-mono text-[12px] leading-[1.9]">
      <p className="truncate text-ink">
        <span className="text-ink-faint">$ </span>
        {typed}
        {!installed && (
          <span className="ml-px inline-block h-[1em] w-[6px] translate-y-[0.1em] bg-signal-green" />
        )}
      </p>
      <p
        className={`truncate text-signal-green transition-opacity ${installed ? "opacity-100" : "opacity-0"}`}
      >
        ✓ installed — every agent can use it
      </p>
    </div>
  );
}

/* ---- Per-agent model ---- */

const MODELS = [
  ["claude-opus-4", "Anthropic"],
  ["gpt-5", "OpenAI"],
  ["gemini-2.5-pro", "Google"],
  ["qwen3-coder", "Ollama — local"],
] as const;

export function ModelCycler() {
  const { tick, reduced } = useTicker(2200);
  const i = reduced ? 0 : tick % MODELS.length;
  const [model, provider] = MODELS[i]!;

  return (
    <div className="border border-paper-rule bg-code-surface px-4 py-3">
      <p className="font-mono text-[10.5px] tracking-[0.12em] text-ink-faint uppercase">
        model:
      </p>
      <p key={model} className="monitor-line-in mt-1 truncate font-mono text-[15px] font-semibold text-ink">
        {model}
      </p>
      <p className="mt-0.5 font-mono text-[11px] text-ink-faint">{provider}</p>
    </div>
  );
}

/* ---- Teams: manager routes the work ---- */

export function TeamRouteDemo() {
  const { tick, reduced } = useTicker(2400);
  const target = reduced ? 0 : tick % 2;

  return (
    <svg
      viewBox="0 0 220 110"
      className="block w-full text-paper-rule"
      aria-hidden
    >
      {/* connectors */}
      <path d="M110 32 L55 78" stroke="currentColor" strokeWidth="1" />
      <path d="M110 32 L165 78" stroke="currentColor" strokeWidth="1" />
      {/* routed task */}
      {!reduced && (
        <circle key={tick} r="2.5" fill="var(--signal-blue)">
          <animateMotion
            dur="1.1s"
            fill="freeze"
            path={target === 0 ? "M110 32 L55 78" : "M110 32 L165 78"}
          />
        </circle>
      )}
      <Node x={110} y={20} label="manager" active />
      <Node x={55} y={90} label="analyst" active={target === 0} />
      <Node x={165} y={90} label="writer" active={target === 1} />
    </svg>
  );
}

function Node({
  x,
  y,
  label,
  active,
}: {
  x: number;
  y: number;
  label: string;
  active?: boolean;
}) {
  return (
    <g>
      <rect
        x={x - 32}
        y={y - 11}
        width="64"
        height="22"
        fill="var(--paper)"
        stroke={active ? "var(--ink-faint)" : "var(--paper-rule)"}
        strokeWidth="1"
      />
      <text
        x={x}
        y={y + 3.5}
        textAnchor="middle"
        className="fill-ink font-mono"
        style={{ fontSize: "9.5px", letterSpacing: "0.08em" }}
      >
        {label}
      </text>
    </g>
  );
}

/* ---- A browser per agent ---- */

export function BrowserPairDemo() {
  const { tick, reduced } = useTicker(2400);
  const active = reduced ? 0 : tick % 2;

  return (
    <div className="grid grid-cols-2 gap-2">
      {(["analyst", "writer"] as const).map((who, i) => (
        <div
          key={who}
          className={`border bg-paper transition-colors ${active === i ? "border-ink-faint" : "border-paper-rule"}`}
        >
          <div className="flex items-center gap-1.5 border-b border-paper-rule px-2.5 py-1.5">
            <span className="size-1 bg-paper-rule" />
            <span className="size-1 bg-paper-rule" />
            <span
              className={`size-1 ${active === i ? "bg-signal-green" : "bg-paper-rule"}`}
            />
            <span className="ml-1 truncate font-mono text-[9.5px] tracking-[0.08em] text-ink-faint uppercase">
              {who}
            </span>
          </div>
          <div className="px-2.5 py-2 font-mono text-[10px] leading-[1.8] text-ink-soft">
            <p className="truncate">own profile</p>
            <p className="truncate">own logins</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- Schedules: recurring work re-opens itself ---- */

export function ScheduleDemo() {
  const { tick, reduced } = useTicker(80);
  const phase = reduced ? 59 : tick % 80;
  const pct = Math.min(phase / 60, 1) * 100;
  const fired = phase >= 60;

  return (
    <div className="border border-paper-rule bg-code-surface px-4 py-3 font-mono text-[12px]">
      <div className="flex items-center justify-between">
        <span className="text-ink">every monday · 09:00</span>
        <span className="text-[10.5px] tracking-[0.1em] text-ink-faint uppercase">
          recurring
        </span>
      </div>
      <div className="mt-3 h-px w-full bg-paper-rule">
        <div
          className="h-px bg-signal-amber transition-[width] duration-200 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p
        className={`mt-2.5 truncate text-[11px] transition-opacity ${fired ? "opacity-100" : "opacity-40"}`}
      >
        <span className={fired ? "text-signal-green" : "text-ink-faint"}>
          {fired ? "✓ done — re-opened for next monday" : "#16 weekly metrics"}
        </span>
      </p>
    </div>
  );
}

/* ---- MCP: namespaced tools from any server ---- */

const MCP_TOOLS = [
  "mcp-github__create_pr",
  "mcp-slack__post_message",
  "mcp-notion__update_page",
  "mcp-stripe__create_invoice",
];

export function McpDemo() {
  const { tick, reduced } = useTicker(1600);
  const offset = reduced ? 0 : tick % MCP_TOOLS.length;

  return (
    <div className="border border-paper-rule bg-code-surface px-4 py-3 font-mono text-[11.5px] leading-[2]">
      {[0, 1, 2].map((i) => {
        const tool = MCP_TOOLS[(offset + i) % MCP_TOOLS.length]!;
        return (
          <p
            key={tool}
            className={`truncate ${i === 0 ? "monitor-line-in text-ink" : "text-ink-faint"}`}
          >
            {tool}
          </p>
        );
      })}
    </div>
  );
}
