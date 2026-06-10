"use client";

/**
 * Home — the operator's primary surface. Three sections: Waiting,
 * Running, Idle. Sessions whose tasks are all terminal don't appear.
 * Live updates via `useHomeStream` (SSE).
 *
 * Click a row → navigate to `/?session=<id>`. The chat panel in
 * `page.tsx` picks that up and renders the conversation.
 *
 * `compact` mode = the rail variant rendered alongside an open chat
 * panel. Same data, narrower layout, no right-hand activity column,
 * the active session is highlighted so the rail doubles as a
 * persistent session switcher.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bell,
  CircleDot,
  Pause,
  Bot,
  Clock,
  MessageSquarePlus,
  Plus,
  Filter as FilterIcon,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useHomeStream } from "@/app/lib/useHomeStream";
import { API_BASE } from "@/app/lib/api";
import type { SessionSummary } from "@/app/lib/types";
import { cn } from "@/app/lib/utils";
import { navigateClient } from "@/app/lib/navigate";
import { InstallHint } from "@/app/components/InstallHint";
import { NotificationsPrompt } from "@/app/components/NotificationsPrompt";
import { AgentRef } from "@/app/components/ui/agent-ref";
import { Button } from "@/app/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";

/** Subset of AgentDefinition surfaced on the fresh-install picker.
 *  Mirrors what `/api/agents` returns; kept narrow so this component
 *  doesn't pull in the chat page's local Agent type. */
interface AgentPickerEntry {
  id: string;
  name: string;
  role: string;
}

function formatRelative(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - unixSeconds);
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatDefer(unixSeconds: number | null): string | null {
  if (unixSeconds == null) return null;
  const now = Math.floor(Date.now() / 1000);
  const diff = unixSeconds - now;
  if (diff <= 0) return null;
  if (diff < 60) return `quiet ${diff}s`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `quiet ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `quiet ${h}h`;
  const d = Math.floor(h / 24);
  return `quiet ${d}d`;
}

interface RowProps {
  s: SessionSummary;
  onClick: () => void;
  onDelete: () => void;
  compact: boolean;
  active: boolean;
}

/** Common keyboard handler for div-as-button: Enter and Space activate. */
function activateOnKey(handler: () => void) {
  return (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  };
}

function SessionRow({ s, onClick, onDelete, compact, active }: RowProps) {
  const wakeLabel = formatDefer(s.deferUntil);
  const statusDot =
    s.status === "waiting"
      ? "bg-plot-red pulse-live"
      : s.status === "running"
        ? "bg-signal-blue"
        : "bg-ink-faint";
  const statusLabel =
    s.status === "waiting"
      ? "Waiting"
      : s.status === "running"
        ? "Running"
        : "Idle";
  const statusTextColor =
    s.status === "waiting"
      ? "text-plot-red"
      : s.status === "running"
        ? "text-signal-blue"
        : "text-ink-soft";

  const deleteButton = (size: "compact" | "full") => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      aria-label="Delete session"
      title="Delete session"
      // Hover-to-reveal on pointer devices, always-visible on touch:
      // group-hover doesn't fire on tap, so opacity-100 under
      // @media(hover:none) keeps the delete reachable on phones.
      className={cn(
        "flex shrink-0 items-center justify-center p-1 text-ink-faint opacity-0 transition-opacity hover:bg-paper-rule/60 hover:text-plot-red focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-plot-red group-hover:opacity-100 [@media(hover:none)]:opacity-60 [@media(hover:none)]:size-11",
        size === "compact" ? "size-6" : "size-7"
      )}
    >
      <Trash2 className={size === "compact" ? "size-3" : "size-3.5"} aria-hidden />
    </button>
  );

  if (compact) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={activateOnKey(onClick)}
        className={cn(
          "group relative flex w-full items-start gap-2 border-b border-paper-rule/40 px-3 py-2 text-left transition-colors cursor-pointer last:border-b-0",
          active
            ? "bg-paper text-ink"
            : "hover:bg-paper-sunk"
        )}
      >
        {active && (
          <span
            className="absolute inset-y-0 left-0 w-[3px] bg-plot-red"
            aria-hidden
          />
        )}
        <span
          className={cn("status-dot mt-1.5", statusDot)}
          aria-hidden
          title={statusLabel}
        />
        <span className="sr-only">{statusLabel}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">
            {s.title || "Untitled session"}
          </div>
          <div className="flex items-center gap-1 truncate text-[11px] text-ink-soft">
            <Bot className="size-3 shrink-0" aria-hidden />
            <AgentRef
              id={s.agentId}
              label={s.agentName}
              className="truncate"
            />
            <span className="text-ink-faint">·</span>
            <span className="truncate font-mono tabular-nums">
              {formatRelative(s.lastActivity)}
            </span>
          </div>
          {s.pingMessage && (
            <div className="mt-1 line-clamp-2 border border-paper-rule bg-paper-sunk px-1.5 py-0.5 text-[11px] text-ink-soft">
              <Bell
                className="mr-1 inline size-2.5 -translate-y-px text-ink-faint"
                aria-hidden
              />
              {s.pingMessage}
            </div>
          )}
        </div>
        {deleteButton("compact")}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={activateOnKey(onClick)}
      className={cn(
        "group flex w-full items-start gap-3 border-b border-paper-rule/40 px-4 py-3 text-left transition-colors cursor-pointer last:border-b-0 md:gap-4 md:px-6",
        "hover:bg-paper-sunk"
      )}
    >
      {/* Desktop: status block with dot + label. Mobile: section header
          already conveys the bucket (waiting/running/idle), so the
          per-row status indicator is redundant noise — drop it entirely. */}
      <div className="hidden shrink-0 items-center gap-2 pt-0.5 md:flex md:w-32">
        <span className={cn("status-dot", statusDot)} aria-hidden />
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.08em]",
            statusTextColor
          )}
        >
          {statusLabel}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        {/* Desktop: agent · title on one line. Mobile: title prominent on
            line 1, agent + relative time on line 2 (closer to phone
            conventions and gives the title room to breathe). */}
        <div className="hidden items-center gap-2 text-sm md:flex">
          <Bot className="size-3.5 shrink-0 text-ink-soft" aria-hidden />
          <Link
            href={`/agents?id=${encodeURIComponent(s.agentId)}`}
            onClick={(e) => e.stopPropagation()}
            className="font-medium hover:underline"
          >
            {s.agentName}
          </Link>
          <span className="text-ink-faint">·</span>
          <span className="min-w-0 truncate text-ink">
            {s.title || "Untitled session"}
          </span>
        </div>
        <div className="truncate text-sm font-medium text-ink md:hidden">
          {s.title || "Untitled session"}
        </div>
        <div className="mt-1 flex items-center gap-2 truncate text-[12px] text-ink-soft md:hidden">
          <Link
            href={`/agents?id=${encodeURIComponent(s.agentId)}`}
            onClick={(e) => e.stopPropagation()}
            className="truncate hover:underline"
          >
            {s.agentName}
          </Link>
          <span className="text-ink-faint">·</span>
          <span className="shrink-0 font-mono tabular-nums text-ink-faint">
            {formatRelative(s.lastActivity)}
          </span>
        </div>
        {s.currentTaskTitle && (
          <div className="mt-1 truncate text-[12px] text-ink-soft">
            on: {s.currentTaskTitle}
          </div>
        )}
        {s.pingMessage && (
          <div className="mt-1 line-clamp-2 border border-paper-rule bg-paper-sunk px-2 py-1 text-[12px] text-ink-soft">
            <Bell className="mr-1 inline size-3 -translate-y-px text-ink-faint" aria-hidden />
            {s.pingMessage}
          </div>
        )}
        {/* Mobile-only meta line — quiet timer + task count badges. The
            relative timestamp already lives next to the agent line above. */}
        {(wakeLabel || s.pendingTaskCount > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.08em] md:hidden">
            {wakeLabel && (
              <span className="flex items-center gap-1 text-signal-blue">
                <Clock className="size-3" aria-hidden />
                {wakeLabel}
              </span>
            )}
            {s.pendingTaskCount > 0 && (
              <span className="text-signal-blue">
                {s.pendingTaskCount} task{s.pendingTaskCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}
      </div>
      {/* Right meta column — desktop only. Mobile pushes the same data
          into the title block's secondary lines. */}
      <div className="hidden w-40 shrink-0 flex-col items-end gap-1 pt-1 text-right md:flex">
        <span className="font-mono text-[11px] tabular-nums text-ink-faint">
          {formatRelative(s.lastActivity)}
        </span>
        {wakeLabel && (
          <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-signal-blue">
            <Clock className="size-3" aria-hidden />
            {wakeLabel}
          </span>
        )}
        {s.pendingTaskCount > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-signal-blue">
            {s.pendingTaskCount} task{s.pendingTaskCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {deleteButton("full")}
    </div>
  );
}

function Section({
  title,
  hint,
  icon: Icon,
  tone,
  sessions,
  onPick,
  onDelete,
  compact,
  activeSessionId,
}: {
  title: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "waiting" | "running" | "idle";
  sessions: SessionSummary[];
  onPick: (sid: string) => void;
  onDelete: (sid: string) => void;
  compact: boolean;
  activeSessionId: string | null;
}) {
  if (sessions.length === 0) return null;
  const toneColor =
    tone === "waiting"
      ? "text-plot-red"
      : tone === "running"
        ? "text-signal-blue"
        : "text-ink-soft";
  return (
    <section>
      {/* Section header carries the only hairline that demarcates the
       *  region (DESIGN.md §5 — "1px hairline below the label"). Sections
       *  butt up so the previous section's last row border-b plus this
       *  header's border-b act as a labeled divider, never doubled. */}
      <div
        className={cn(
          "flex items-center justify-between border-b border-paper-rule pb-2 pt-3",
          compact ? "px-3" : "px-4 md:px-6"
        )}
      >
        <h2
          className={cn(
            "flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.10em]",
            toneColor
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {title}
          <span className="font-mono text-ink-faint">·</span>
          <span className="font-mono text-ink-faint">{sessions.length}</span>
        </h2>
        {hint && !compact && (
          <span className="hidden font-mono text-[10px] text-ink-faint md:inline">
            {hint}
          </span>
        )}
      </div>
      {sessions.map((s) => (
        <SessionRow
          key={s.sessionId}
          s={s}
          onClick={() => onPick(s.sessionId)}
          onDelete={() => onDelete(s.sessionId)}
          compact={compact}
          active={activeSessionId === s.sessionId}
        />
      ))}
    </section>
  );
}

/**
 * Always-on "+ New chat" entry point. Opens a popover with the same
 * agent grid the EmptyState uses. Picking an agent navigates to
 * `/?agent=<id>` (no session id) — the chat page already supports
 * this state via ChatAgentReadyState until the first message commits
 * a session via `/api/chat`.
 *
 * Self-fetches `/api/agents` so the parent doesn't have to thread it.
 * Renders nothing until the first agent loads (avoids a flash of a
 * disabled-looking button).
 */
function NewChatPopover({ compact }: { compact: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentPickerEntry[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/agents`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((list: AgentPickerEntry[]) => setAgents(list))
      .catch(() => {
        if (!ctrl.signal.aborted) setAgents([]);
      });
    return () => ctrl.abort();
  }, []);

  // Hide the trigger until we know there's at least one agent — there
  // is nothing to start a chat with otherwise, and the link from
  // EmptyState's "Create an agent" CTA already handles the recovery path.
  if (!agents || agents.length === 0) return null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? agents.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.role?.toLowerCase().includes(q)
      )
    : agents;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        {compact ? (
          <button
            type="button"
            aria-label="New chat"
            className="flex size-7 shrink-0 items-center justify-center border border-paper-rule bg-paper text-ink-soft transition-colors hover:border-plot-red hover:text-plot-red"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className="flex shrink-0 items-center border border-paper-rule bg-paper px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:border-plot-red hover:text-plot-red"
          >
            New chat
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="flex w-72 flex-col p-0"
      >
        <div className="border-b border-paper-rule px-3 py-2">
          <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
            Start a chat
          </p>
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
            className="w-full border border-paper-rule bg-paper px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-plot-red"
          />
        </div>
        <ul className="max-h-[50vh] overflow-y-auto">
          {filtered.length === 0 ? (
            <li className="px-3 py-3 text-center text-[12px] text-ink-faint">
              No agents match.
            </li>
          ) : (
            filtered.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setQuery("");
                    // Preserve other params (e.g. ?agentFilter) so
                    // picking a new chat doesn't drop the operator's
                    // filter. Drop ?session — this is a fresh chat.
                    const params = new URLSearchParams(
                      searchParams.toString()
                    );
                    params.set("agent", a.id);
                    params.delete("session");
                    navigateClient(`/?${params.toString()}`);
                  }}
                  className="group flex w-full items-start gap-3 border-b border-paper-rule/40 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-paper-sunk"
                >
                  <MessageSquarePlus
                    className="mt-0.5 size-4 shrink-0 text-ink-soft group-hover:text-plot-red"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">
                      {a.name}
                    </div>
                    {a.role && (
                      <div className="mt-0.5 line-clamp-2 text-[12px] text-ink-soft">
                        {a.role}
                      </div>
                    )}
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Single-button dropdown that scopes the home view to one agent.
 * Replaces the prior chip-per-agent row — that visual got noisy at 5+
 * agents. The popover content mirrors NewChatPopover (search + list)
 * so both pickers feel the same.
 */
function FilterByAgentPopover({
  agentTotals,
  active,
  onPick,
  compact,
}: {
  agentTotals: { id: string; name: string; count: number }[];
  active: string | null;
  onPick: (id: string | null) => void;
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const total = agentTotals.reduce((sum, t) => sum + t.count, 0);
  const activeName = agentTotals.find((t) => t.id === active)?.name ?? null;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? agentTotals.filter((t) => t.name.toLowerCase().includes(q))
    : agentTotals;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title={
            activeName
              ? `Filtered: ${activeName}`
              : "Filter by agent"
          }
          aria-label={
            activeName ? `Filtered by ${activeName}` : "Filter by agent"
          }
          className={cn(
            "relative flex size-8 shrink-0 items-center justify-center border bg-paper transition-colors hover:border-plot-red hover:text-plot-red",
            active
              ? "border-plot-red text-plot-red"
              : "border-paper-rule text-ink-soft"
          )}
        >
          <FilterIcon className="size-3.5" aria-hidden />
          {active && (
            <span
              aria-hidden
              className="absolute right-1 top-1 size-1.5 bg-plot-red"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="flex w-64 flex-col p-0"
      >
        <div className="border-b border-paper-rule px-3 py-2">
          <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
            Filter by agent
          </p>
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
            className="w-full border border-paper-rule bg-paper px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-plot-red"
          />
        </div>
        <ul className="max-h-[50vh] overflow-y-auto">
          <li>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setQuery("");
                onPick(null);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-3 border-b border-paper-rule/40 px-3 py-2 text-left text-[13px] transition-colors hover:bg-paper-sunk",
                !active && "bg-plot-red/10 text-plot-red"
              )}
            >
              <span className="font-medium">All agents</span>
              <span className="font-mono tabular-nums text-ink-faint">
                {total}
              </span>
            </button>
          </li>
          {filtered.length === 0 ? (
            <li className="px-3 py-3 text-center text-[12px] text-ink-faint">
              No agents match.
            </li>
          ) : (
            filtered.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setQuery("");
                    onPick(a.id);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 border-b border-paper-rule px-3 py-2 text-left text-[13px] transition-colors last:border-b-0 hover:bg-paper-sunk",
                    active === a.id && "bg-plot-red/10 text-plot-red"
                  )}
                >
                  <span className="truncate font-medium">{a.name}</span>
                  <span className="font-mono tabular-nums text-ink-faint">
                    {a.count}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Empty state — no active sessions in any bucket. Two paths:
 *
 *   - Workforce has at least one agent (the normal case post-Acme
 *     auto-materialization): show a picker so the user can start a
 *     fresh chat. Without this, a clean install lands on Home with
 *     "Nothing's running" and no way to reach the chat UI.
 *   - Zero agents (the user deleted everything, including Acme): point
 *     them at the Agents page to recreate one.
 */
function EmptyState({ compact }: { compact: boolean }) {
  const [agents, setAgents] = useState<AgentPickerEntry[] | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${API_BASE}/api/agents`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((list: AgentPickerEntry[]) => setAgents(list))
      .catch(() => {
        if (!ctrl.signal.aborted) setAgents([]);
      });
    return () => ctrl.abort();
  }, []);

  // Loading: keep the layout stable while the fetch resolves.
  if (agents === null) {
    return (
      <div className="px-6 py-12 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
        Loading&hellip;
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-soft">
          No agents in your workforce.
        </p>
        <p className="mt-2 text-sm text-ink-faint">
          Recreate one to get started.
        </p>
        <div className="mt-4">
          <Button asChild>
            <Link href="/agents">Create an agent</Link>
          </Button>
        </div>
      </div>
    );
  }

  // Compact rail: just the picker, tighter padding. Non-compact: full
  // landing with copy + picker.
  return (
    <div className={cn("text-center", compact ? "px-3 py-6" : "px-6 py-10")}>
      {!compact && (
        <>
          <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-soft">
            Start a chat
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
            Select an agent. Sessions and tasks file to this view as the
            workforce runs.
          </p>
        </>
      )}
      <ul
        className={cn(
          "mx-auto mt-6 grid gap-2",
          compact ? "max-w-full" : "max-w-md"
        )}
      >
        {agents.map((a) => (
          <li key={a.id}>
            <Link
              href={`/?agent=${encodeURIComponent(a.id)}`}
              className="group flex items-start gap-3 border border-paper-rule bg-paper px-3 py-2.5 text-left transition-colors hover:border-plot-red hover:bg-paper-sunk"
            >
              <MessageSquarePlus
                className="mt-0.5 size-4 shrink-0 text-ink-soft group-hover:text-plot-red"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-ink">
                  {a.name}
                </div>
                {a.role && (
                  <div className="mt-0.5 line-clamp-2 text-[12px] text-ink-soft">
                    {a.role}
                  </div>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Search ──────────────────────────────────────────────────────────────

interface MessageSearchHit {
  sessionId: string;
  agentId: string;
  agentName: string;
  sessionTitle: string | null;
  role: "user" | "assistant";
  snippet: string;
  rank: number;
}

/** Unified search-result row. `kind` tells the operator why this hit
 *  matched: agent name, session title, ping, or message body. */
interface SearchResultEntry {
  sessionId: string;
  agentId: string;
  agentName: string;
  title: string | null;
  /** What surface produced this match — drives the leading badge text. */
  kind: "agent" | "title" | "ping" | "message";
  /** Live-session role if local; null for server-only hits. */
  status: "waiting" | "running" | "idle" | null;
  snippet: string;
  /** Lower is better. Local hits beat server hits via tier ordering. */
  rank: number;
}

const KIND_LABEL: Record<SearchResultEntry["kind"], string> = {
  agent: "agent",
  title: "title",
  ping: "ping",
  message: "message",
};

const STATUS_DOT: Record<NonNullable<SearchResultEntry["status"]>, string> = {
  waiting: "bg-plot-red",
  running: "bg-signal-blue",
  idle: "bg-ink-faint",
};

/**
 * Highlight occurrences of every whitespace-separated query token in
 * `text`. Case-insensitive, longest-token-first so "foo bar" doesn't
 * double-highlight inside "foobar". Returns React nodes.
 */
function highlightMatches(text: string, query: string): React.ReactNode {
  const tokens = query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return text;
  const pattern = new RegExp(
    `(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi"
  );
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    pattern.test(part) ? (
      <mark
        key={i}
        className="bg-plot-red/15 text-ink underline decoration-plot-red/40 underline-offset-2"
      >
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function SearchBar({
  query,
  onChange,
  loading,
  inputRef,
  compact,
  trailing,
}: {
  query: string;
  onChange: (next: string) => void;
  loading: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  compact: boolean;
  /** Sibling control rendered to the right of the search box, inside the
   *  same breathing band. Used for the agent filter chip. */
  trailing?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2",
        compact ? "px-3 py-2" : "px-4 py-3 md:px-6"
      )}
    >
      <div
        className={cn(
          "relative flex flex-1 items-center gap-2 border border-paper-rule bg-paper transition-colors focus-within:border-plot-red",
          "px-3 py-1.5"
        )}
      >
        <Search className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search sessions by title, agent, or message…"
          aria-label="Search workforce"
          aria-keyshortcuts="/"
          autoComplete="off"
          spellCheck={false}
          className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="shrink-0 p-0.5 text-ink-faint transition-colors hover:text-plot-red focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-plot-red"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : (
          <kbd
            title="Press / to focus search"
            className="shrink-0 border border-paper-rule px-1 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint"
          >
            /
          </kbd>
        )}
        {loading && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden">
            <span aria-hidden className="loading-hairline" />
          </span>
        )}
      </div>
      {trailing}
    </div>
  );
}

function SearchResultRow({
  entry,
  query,
  active,
  onPick,
  compact,
}: {
  entry: SearchResultEntry;
  query: string;
  active: boolean;
  onPick: (sid: string) => void;
  compact: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(entry.sessionId)}
      className={cn(
        "group relative flex w-full items-start gap-3 border-b border-paper-rule/40 text-left transition-colors last:border-b-0",
        compact ? "px-3 py-2" : "px-4 py-2.5 md:px-6",
        active ? "bg-paper-sunk" : "hover:bg-paper-sunk"
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[2px] bg-plot-red"
        />
      )}
      <span
        className={cn(
          "status-dot mt-1.5 shrink-0",
          entry.status ? STATUS_DOT[entry.status] : "bg-ink-faint"
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-medium text-ink">
            {entry.title || "Untitled session"}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            <Bot className="size-2.5" aria-hidden />
            <span className="truncate max-w-[8rem]">{entry.agentName}</span>
            <span aria-hidden>·</span>
            <span>{KIND_LABEL[entry.kind]}</span>
          </span>
        </div>
        <div className="mt-0.5 line-clamp-2 font-mono text-[11px] leading-snug text-ink-soft">
          {highlightMatches(entry.snippet, query)}
        </div>
      </div>
    </button>
  );
}

export function HomeView({ compact = false }: { compact?: boolean } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSessionId = searchParams.get("session") ?? null;
  // Filter the three buckets to one agent. URL-backed (`?agentFilter=`)
  // so refresh and shared links survive. Orthogonal to ?session / ?agent
  // — picking a chip never changes which chat is open. Null = show all.
  const agentFilter = searchParams.get("agentFilter");
  const { payload, loading, error, refresh } = useHomeStream();

  // Build a lookup of sessionId → agentId so the row click can pin
  // both into the URL. Without the agent in the URL, opening a
  // session belonging to a different agent would briefly render the
  // chat header with stale agent info.
  const sessionToAgent = new Map<string, string>();
  if (payload) {
    for (const bucket of [payload.waiting, payload.running, payload.idle]) {
      for (const s of bucket) sessionToAgent.set(s.sessionId, s.agentId);
    }
  }

  // Canonical URL is `?session=<id>` only — the agent is implied
  // by the session row server-side, the chat page fetches
  // `/api/sessions/:id` and adopts the agent from there.
  // useCallback so the search keydown effect doesn't re-attach
  // on every render via the deps array.
  const pick = useCallback((sid: string) => {
    navigateClient(`/?session=${encodeURIComponent(sid)}`);
  }, []);

  const deleteSession = async (sid: string) => {
    if (!confirm("Delete this session? Messages and attachments are removed permanently.")) return;
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sid)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      alert(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // If the deleted session is the one currently open in the chat panel,
    // clear it from the URL so the page doesn't try to render a gone session.
    if (sid === activeSessionId) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("session");
      const qs = params.toString();
      navigateClient(qs ? `/?${qs}` : "/");
    }
    void refresh({ force: true });
  };

  // ── Search ────────────────────────────────────────────────────────
  // Always-visible search bar above the section list. Title / agent /
  // ping matches resolve client-side from the home payload; message-
  // body content goes to /api/messages/search (FTS5, debounced).
  const [searchQuery, setSearchQuery] = useState("");
  const [serverHits, setServerHits] = useState<MessageSearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Pre-build status lookup so server hits can adopt status from the
  // home payload when the matching session is currently live.
  const statusBySession = useMemo(() => {
    const m = new Map<string, "waiting" | "running" | "idle">();
    if (payload) {
      for (const s of payload.waiting) m.set(s.sessionId, "waiting");
      for (const s of payload.running) m.set(s.sessionId, "running");
      for (const s of payload.idle) m.set(s.sessionId, "idle");
    }
    return m;
  }, [payload]);

  // Wrap the open-with-results transition in View Transitions when the
  // empty → non-empty toggle happens. The default browser snapshot
  // animation cross-fades the section list ↔ search results region.
  const setQueryAnimated = useCallback((next: string) => {
    const wasEmpty = searchQuery.trim().length === 0;
    const willBeEmpty = next.trim().length === 0;
    const crossing = wasEmpty !== willBeEmpty;
    setSearchActiveIndex(0);
    if (
      crossing &&
      typeof document !== "undefined" &&
      typeof (document as Document & { startViewTransition?: unknown })
        .startViewTransition === "function"
    ) {
      (document as Document & {
        startViewTransition: (cb: () => void) => void;
      }).startViewTransition(() => setSearchQuery(next));
    } else {
      setSearchQuery(next);
    }
  }, [searchQuery]);

  // Debounced server search (140ms). AbortController kills the previous
  // request so a fast typer never sees an out-of-order response.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length === 0) {
      setServerHits([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(
        `${API_BASE}/api/messages/search?q=${encodeURIComponent(q)}&limit=20`,
        { signal: ctrl.signal }
      )
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((data: { results: MessageSearchHit[] }) => {
          setServerHits(data.results ?? []);
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setServerHits([]);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setSearchLoading(false);
        });
    }, 140);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [searchQuery]);

  // Merge local + server hits. Local title matches > agent > ping >
  // server content. Dedupe by sessionId; local wins because it carries
  // the live status dot.
  const searchResults = useMemo<SearchResultEntry[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q.length === 0) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    const matches = (haystack: string | null | undefined): boolean => {
      if (!haystack) return false;
      const lc = haystack.toLowerCase();
      return tokens.every((t) => lc.includes(t));
    };

    const out: SearchResultEntry[] = [];
    const seen = new Set<string>();
    const push = (e: SearchResultEntry) => {
      if (seen.has(e.sessionId)) return;
      seen.add(e.sessionId);
      out.push(e);
    };

    if (payload) {
      const all = [...payload.waiting, ...payload.running, ...payload.idle];
      // Title hits — rank 0 tier (best).
      for (const s of all) {
        if (matches(s.title)) {
          push({
            sessionId: s.sessionId,
            agentId: s.agentId,
            agentName: s.agentName,
            title: s.title,
            kind: "title",
            status: s.status,
            snippet: s.title ?? "",
            rank: 0,
          });
        }
      }
      // Agent-name hits — rank 1 tier.
      for (const s of all) {
        if (matches(s.agentName) && !matches(s.title ?? "")) {
          push({
            sessionId: s.sessionId,
            agentId: s.agentId,
            agentName: s.agentName,
            title: s.title,
            kind: "agent",
            status: s.status,
            snippet: s.title || `Session with ${s.agentName}`,
            rank: 1,
          });
        }
      }
      // Ping hits — rank 2 tier.
      for (const s of all) {
        if (s.pingMessage && matches(s.pingMessage)) {
          push({
            sessionId: s.sessionId,
            agentId: s.agentId,
            agentName: s.agentName,
            title: s.title,
            kind: "ping",
            status: s.status,
            snippet: s.pingMessage,
            rank: 2,
          });
        }
      }
    }
    // Server content hits — rank 3+ tier (FTS bm25; lower is better).
    for (const h of serverHits) {
      push({
        sessionId: h.sessionId,
        agentId: h.agentId,
        agentName: h.agentName,
        title: h.sessionTitle,
        kind: "message",
        status: statusBySession.get(h.sessionId) ?? null,
        snippet: h.snippet,
        rank: 3 + (h.rank ?? 0),
      });
    }
    return out;
  }, [searchQuery, payload, serverHits, statusBySession]);

  // Clamp active index when results shrink.
  useEffect(() => {
    if (searchActiveIndex >= searchResults.length) {
      setSearchActiveIndex(Math.max(0, searchResults.length - 1));
    }
  }, [searchResults.length, searchActiveIndex]);

  // Global `/` focuses the search input. Esc clears the query when
  // there is one; otherwise blurs. Arrow keys + Enter navigate
  // results when the input is focused.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditable) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (target !== searchInputRef.current) return;

      if (e.key === "Escape") {
        if (searchQuery) {
          e.preventDefault();
          setQueryAnimated("");
        } else {
          searchInputRef.current?.blur();
        }
        return;
      }
      if (searchResults.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSearchActiveIndex((i) => Math.min(searchResults.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSearchActiveIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = searchResults[searchActiveIndex];
        if (hit) {
          pick(hit.sessionId);
          setQueryAnimated("");
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searchQuery, searchResults, searchActiveIndex, setQueryAnimated, pick]);

  const setAgentFilter = (next: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next == null) params.delete("agentFilter");
    else params.set("agentFilter", next);
    const qs = params.toString();
    navigateClient(qs ? `/?${qs}` : "/");
  };

  if (loading && !payload) {
    return (
      <div
        className={cn(
          "flex items-center justify-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint",
          compact
            ? "h-full w-[340px] shrink-0 border-r border-paper-rule"
            : "h-full flex-1"
        )}
      >
        Loading&hellip;
      </div>
    );
  }
  if (error) {
    return (
      <div
        className={cn(
          "px-4 py-8 text-sm text-ink-soft md:px-6",
          compact
            ? "w-[340px] shrink-0 border-r border-paper-rule"
            : "flex-1"
        )}
      >
        Failed to load home: {error}
      </div>
    );
  }

  const empty =
    !payload ||
    (payload.waiting.length === 0 &&
      payload.running.length === 0 &&
      payload.idle.length === 0);

  return (
    <div
      className={cn(
        "h-full overflow-y-auto bg-paper",
        compact
          ? "w-[340px] shrink-0 border-r border-paper-rule"
          : "flex-1"
      )}
    >
      {/* Top-of-home prompts. Each self-gates on its own conditions:
          InstallHint is iOS Safari only (mobile-only by viewport);
          NotificationsPrompt shows on any platform that supports web push
          (desktop Chrome/Edge/Firefox/Safari 16+, Android Chrome, and
          installed iOS PWAs) when permission is "default" and the user
          hasn't dismissed. */}
      {!compact && (
        <>
          <div className="md:hidden">
            <InstallHint />
          </div>
          <NotificationsPrompt />
        </>
      )}
      <div
        className={cn(
          "flex items-center justify-between gap-3",
          compact ? "px-3 py-3" : "px-3 py-3 md:px-6 md:py-4"
        )}
      >
        <div className="flex min-w-0 items-center gap-2 md:gap-3">
          <h1
            className={cn(
              "text-ink",
              compact ? "text-sm font-medium" : "text-lg font-medium"
            )}
          >
            Home
          </h1>
          {!compact && (() => {
            // Aggregate workforce status. Plot Red anchors the eye when
            // anything is waiting on the operator; otherwise Signal Blue
            // marks live work; otherwise the workforce is idle and ink-faint.
            const waiting = payload?.waiting.length ?? 0;
            const running = payload?.running.length ?? 0;
            const idle = payload?.idle.length ?? 0;
            const total = waiting + running + idle;
            const tone =
              waiting > 0
                ? {
                    dot: "bg-plot-red pulse-live",
                    label: "text-plot-red",
                    text: `${waiting} waiting on you`,
                  }
                : running > 0
                  ? {
                      dot: "bg-signal-blue",
                      label: "text-signal-blue",
                      text: `${running} running`,
                    }
                  : total > 0
                    ? {
                        dot: "bg-ink-faint",
                        label: "text-ink-soft",
                        text: "Workforce idle",
                      }
                    : {
                        dot: "bg-ink-faint",
                        label: "text-ink-soft",
                        text: "Workforce activity at a glance",
                      };
            return (
              <>
                <span aria-hidden className="h-4 w-px shrink-0 bg-paper-rule" />
                <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em]">
                  <span aria-hidden className={cn("status-dot", tone.dot)} />
                  <span className={tone.label}>{tone.text}</span>
                </span>
              </>
            );
          })()}
        </div>
        <NewChatPopover compact={compact} />
      </div>

      {!empty && payload && (() => {
        // Per-agent totals from the UNFILTERED payload so chip counts
        // don't zero out when a filter is active. Single-agent slot
        // hides the filter entirely — scoping is noise when there's
        // nothing to scope away from.
        const totals = new Map<string, { name: string; count: number }>();
        for (const bucket of [payload.waiting, payload.running, payload.idle]) {
          for (const s of bucket) {
            const cur = totals.get(s.agentId);
            if (cur) cur.count++;
            else totals.set(s.agentId, { name: s.agentName, count: 1 });
          }
        }
        const agentTotals =
          totals.size > 1
            ? Array.from(totals.entries())
                .map(([id, { name, count }]) => ({ id, name, count }))
                .sort((a, b) => a.name.localeCompare(b.name))
            : null;
        return (
          <SearchBar
            query={searchQuery}
            onChange={setQueryAnimated}
            loading={searchLoading}
            inputRef={searchInputRef}
            compact={compact}
            trailing={
              agentTotals && (
                <FilterByAgentPopover
                  agentTotals={agentTotals}
                  active={agentFilter}
                  onPick={setAgentFilter}
                  compact={compact}
                />
              )
            }
          />
        );
      })()}

      {empty ? (
        <EmptyState compact={compact} />
      ) : searchQuery.trim().length > 0 ? (
        searchResults.length === 0 && !searchLoading ? (
          <div
            className={cn(
              "text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint",
              compact ? "px-3 py-8" : "px-4 py-12 md:px-6"
            )}
          >
            No matches.
          </div>
        ) : (
          <div className="border-t border-paper-rule">
            {searchResults.map((entry, i) => (
              <SearchResultRow
                key={`${entry.sessionId}-${entry.kind}`}
                entry={entry}
                query={searchQuery}
                active={i === searchActiveIndex}
                onPick={(sid) => {
                  pick(sid);
                  setQueryAnimated("");
                }}
                compact={compact}
              />
            ))}
          </div>
        )
      ) : (() => {
        const apply = (b: SessionSummary[]) =>
          agentFilter ? b.filter((s) => s.agentId === agentFilter) : b;
        const w = apply(payload!.waiting);
        const r = apply(payload!.running);
        const i = apply(payload!.idle);
        // Filter active + nothing left in any bucket → tell the user
        // explicitly rather than dropping into a blank pane.
        if (agentFilter && w.length === 0 && r.length === 0 && i.length === 0) {
          const name =
            payload!.waiting.find((s) => s.agentId === agentFilter)?.agentName ??
            payload!.running.find((s) => s.agentId === agentFilter)?.agentName ??
            payload!.idle.find((s) => s.agentId === agentFilter)?.agentName ??
            agentFilter;
          return (
            <div
              className={cn(
                "text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint",
                compact ? "px-3 py-8" : "px-4 py-12 md:px-6"
              )}
            >
              No active sessions for {name}.
            </div>
          );
        }
        return (
          <>
            <Section
              title="Waiting on you"
              hint="oldest first"
              icon={Bell}
              tone="waiting"
              sessions={w}
              onPick={pick}
              onDelete={deleteSession}
              compact={compact}
              activeSessionId={activeSessionId}
            />
            <Section
              title="Running"
              hint="live"
              icon={CircleDot}
              tone="running"
              sessions={r}
              onPick={pick}
              onDelete={deleteSession}
              compact={compact}
              activeSessionId={activeSessionId}
            />
            <Section
              title="Idle"
              hint="with pending work"
              icon={Pause}
              tone="idle"
              sessions={i}
              onPick={pick}
              onDelete={deleteSession}
              compact={compact}
              activeSessionId={activeSessionId}
            />
          </>
        );
      })()}
    </div>
  );
}

