"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useInView, usePrefersReducedMotion } from "./hooks";
import { TONE_BG, TONE_TEXT, type Tone } from "./Section";

/* Capability bento. To keep the grid calm, only ONE cell animates at a
   time: a spotlight rotates through the cells on a slow cadence, and
   hovering a cell pins the spotlight to it. Non-active cells render a
   clean, finished frame — the same one used under reduced motion. */

const SPOTLIGHT_MS = 3400;

const SpotlightContext = createContext<{
  active: number;
  setHover: (i: number | null) => void;
  hoverCapable: boolean;
}>({ active: -1, setHover: () => {}, hoverCapable: true });

/* True only for the demo inside the currently-spotlit cell. */
const CellActiveContext = createContext(false);

export function BentoGrid({
  count,
  children,
  className = "",
}: {
  count: number;
  children: ReactNode;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>(0.3);
  const [spot, setSpot] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  // No-hover devices (touch) can't pin a spotlight, so the rotating
  // spotlight is pointless there — cells self-activate when scrolled into
  // view instead (see BentoCell). Only run the rotation on hover devices.
  const [hoverCapable, setHoverCapable] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    setHoverCapable(mq.matches);
    const on = (e: MediaQueryListEvent) => setHoverCapable(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    if (reduced || !inView || hover !== null || !hoverCapable) return;
    const t = setInterval(() => setSpot((s) => (s + 1) % count), SPOTLIGHT_MS);
    return () => clearInterval(t);
  }, [reduced, inView, hover, count, hoverCapable]);

  const active = hover ?? spot;

  return (
    <SpotlightContext.Provider value={{ active, setHover, hoverCapable }}>
      <div ref={ref} className={className}>
        {children}
      </div>
    </SpotlightContext.Provider>
  );
}

/* Demos tick only while their cell is the active one, and restart from a
   clean frame each time the spotlight lands. */
function useTicker(intervalMs: number) {
  const reduced = usePrefersReducedMotion();
  const active = useContext(CellActiveContext);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduced || !active) return;
    setTick(0);
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [reduced, active, intervalMs]);
  return { tick, idle: reduced || !active };
}

export function BentoCell({
  order,
  index,
  label,
  title,
  body,
  children,
  tone = "red",
  className = "",
}: {
  order: number;
  index: string;
  label: string;
  title: string;
  body: string;
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const { active, setHover, hoverCapable } = useContext(SpotlightContext);
  const [ref, inView] = useInView<HTMLDivElement>(0.55);
  // Hover devices: the spotlight (or a pinning hover) drives it.
  // Touch devices: the cell wakes while it's the one on screen.
  const isActive = hoverCapable ? order === active : inView;

  return (
    <div
      ref={ref}
      onMouseEnter={() => setHover(order)}
      onMouseLeave={() => setHover(null)}
      className={`group/cell relative flex flex-col gap-4 border-b border-paper-rule p-6 transition-colors duration-300 sm:border-r ${isActive ? "bg-paper-sunk/40" : ""} ${className}`}
    >
      <span
        aria-hidden
        className={`absolute top-0 left-0 h-[2px] transition-all duration-500 ease-out-quart ${TONE_BG[tone]} ${isActive ? "w-full opacity-100" : "w-9 opacity-70"}`}
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
      <div className="mt-auto">
        <CellActiveContext.Provider value={isActive}>
          {children}
        </CellActiveContext.Provider>
      </div>
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
  const { tick, idle } = useTicker(90);
  const line = MEMORY_NEW[0]!;
  const chars = Math.min(tick * 3, line.length);
  const shown = idle ? line : line.slice(0, chars);
  const typingDone = idle || chars >= line.length;

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
  const { tick, idle } = useTicker(80);
  const cmd = `openacme skills install ${SKILLS[1]}`;
  const chars = Math.min(tick * 3, cmd.length);
  const typed = idle ? cmd : cmd.slice(0, chars);
  const installed = idle || chars >= cmd.length;

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
  const { tick, idle } = useTicker(1100);
  const i = idle ? 0 : tick % MODELS.length;
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
  const { tick, idle } = useTicker(1700);
  const target = idle ? 0 : tick % 2;

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
      {!idle && (
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
  const { tick, idle } = useTicker(1700);
  const active = idle ? 0 : tick % 2;

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
  const { tick, idle } = useTicker(55);
  // At rest: waiting for the next fire (empty bar, task queued).
  const phase = idle ? 0 : tick % 80;
  const pct = Math.min(phase / 50, 1) * 100;
  const fired = !idle && phase >= 50;

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
  const { tick, idle } = useTicker(1100);
  const offset = idle ? 0 : tick % MCP_TOOLS.length;

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
