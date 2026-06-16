import { Link } from "@tanstack/react-router";
import { AgentAvatar } from "@/app/components/ui/agent-avatar";
import { ModelProviderLogo } from "@/app/components/BrandIcons";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { Badge } from "@/app/components/ui/badge";
import { cn } from "@/app/lib/utils";
import {
  formatCost,
  formatPercent,
  formatTokens,
  kindColor,
  seriesColor,
} from "@/app/lib/format";
import type { UsageBreakdownRow } from "@/app/lib/types";

function relTime(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

function spendOf(r: UsageBreakdownRow): number {
  return r.costUsd > 0 ? r.costUsd : r.costUsdEquivalent;
}

/** Thin horizontal share bar behind a value — ranking visible without reading. */
function ShareBar({ fraction, color }: { fraction: number; color: string }) {
  return (
    <span className="relative block h-1 w-full bg-paper-sunk">
      <span
        className="absolute inset-y-0 left-0"
        style={{ width: `${Math.min(100, fraction * 100)}%`, background: color }}
      />
    </span>
  );
}

const AGENT_GRID =
  "grid grid-cols-[minmax(8rem,1.4fr)_5rem_5rem_5rem_5rem_4rem_5rem] items-center gap-3 px-1 md:grid-cols-[minmax(10rem,1.4fr)_6rem_6rem_6rem_5rem_5rem_6rem]";

function HeaderCell({
  children,
  align = "right",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <span
      className={cn(
        "label-faceplate text-ink-faint",
        align === "right" && "text-right"
      )}
    >
      {children}
    </span>
  );
}

export function AgentLedger({
  rows,
  agentName,
  agentAvatar,
  onPick,
}: {
  rows: UsageBreakdownRow[];
  agentName: (id: string) => string;
  agentAvatar?: (id: string) => string | undefined;
  onPick?: (agentId: string) => void;
}) {
  const total = rows.reduce((s, r) => s + spendOf(r), 0);
  return (
    <div className="flex flex-col">
      {rows.length > 0 && (
        <div className={cn(AGENT_GRID, "border-b border-paper-rule py-1.5")}>
          <HeaderCell align="left">Agent</HeaderCell>
          <HeaderCell>Spend</HeaderCell>
          <HeaderCell>In</HeaderCell>
          <HeaderCell>Out</HeaderCell>
          <HeaderCell>Cached</HeaderCell>
          <HeaderCell>Calls</HeaderCell>
          <HeaderCell>Last</HeaderCell>
        </div>
      )}
      {rows.map((r) => {
        const hitRate = r.inputTokens > 0 ? r.cachedInputTokens / r.inputTokens : 0;
        return (
          <button
            key={r.key}
            onClick={() => onPick?.(r.key)}
            className={cn(
              AGENT_GRID,
              "group border-b border-paper-rule py-2.5 text-left transition-colors last:border-b-0 hover:bg-paper-sunk"
            )}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center gap-2">
                <AgentAvatar avatar={agentAvatar?.(r.key)} size="sm" />
                <span className="truncate text-[0.9375rem] font-medium text-ink">
                  {agentName(r.key)}
                </span>
                <span className="meta-row text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
                  activity →
                </span>
              </span>
              <ShareBar
                fraction={total > 0 ? spendOf(r) / total : 0}
                color={seriesColor(r.key)}
              />
            </span>
            <span className="text-right font-mono text-sm tabular-nums text-ink">
              {formatCost(spendOf(r))}
            </span>
            <span className="meta-row text-right text-ink-soft">
              {formatTokens(r.inputTokens)}
            </span>
            <span className="meta-row text-right text-ink-soft">
              {formatTokens(r.outputTokens)}
            </span>
            <span className="meta-row text-right text-ink-soft">
              {r.inputTokens > 0 ? formatPercent(hitRate) : "—"}
            </span>
            <span className="meta-row text-right text-ink-soft">{r.events}</span>
            <span className="meta-row text-right text-ink-faint">
              {relTime(r.lastAt)}
            </span>
          </button>
        );
      })}
      {rows.length === 0 && (
        <span className="meta-row py-4 text-ink-faint">
          No agent activity in this range.
        </span>
      )}
    </div>
  );
}

const MODEL_GRID =
  "grid grid-cols-[minmax(9rem,1fr)_5.5rem_4.5rem_4.5rem_5.5rem] items-center gap-3 px-1";

export function ModelTable({
  rows,
  onPick,
}: {
  rows: UsageBreakdownRow[];
  onPick?: (model: string) => void;
}) {
  return (
    <div className="flex flex-col">
      {rows.length > 0 && (
        <div className={cn(MODEL_GRID, "border-b border-paper-rule py-1.5")}>
          <HeaderCell align="left">Model</HeaderCell>
          <HeaderCell>Spend</HeaderCell>
          <HeaderCell>Tokens</HeaderCell>
          <HeaderCell>Cached</HeaderCell>
          <HeaderCell>$/MTok</HeaderCell>
        </div>
      )}
      {rows.map((r) => {
        const spend = spendOf(r);
        const effective =
          r.totalTokens > 0 ? (spend / r.totalTokens) * 1_000_000 : null;
        const hitRate = r.inputTokens > 0 ? r.cachedInputTokens / r.inputTokens : 0;
        return (
          <button
            key={r.key}
            onClick={() => onPick?.(r.key)}
            className={cn(
              MODEL_GRID,
              "group border-b border-paper-rule py-2 text-left transition-colors last:border-b-0 hover:bg-paper-sunk"
            )}
          >
            <span className="flex min-w-0 items-center gap-2 font-mono text-xs text-ink">
              <ModelProviderLogo
                model={r.key}
                className="size-3.5 shrink-0 text-ink-soft"
              />
              <span className="truncate">{r.key}</span>
              <span className="meta-row text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
                activity →
              </span>
            </span>
            <span className="text-right font-mono text-sm tabular-nums text-ink">
              {formatCost(spend)}
            </span>
            <span className="meta-row text-right text-ink-soft">
              {formatTokens(r.totalTokens)}
            </span>
            <span className="meta-row text-right text-ink-soft">
              {r.inputTokens > 0 ? formatPercent(hitRate) : "—"}
            </span>
            <span className="meta-row text-right text-ink-soft">
              {effective !== null ? formatCost(effective) : "—"}
            </span>
          </button>
        );
      })}
      {rows.length === 0 && (
        <span className="meta-row py-3 text-ink-faint">No model usage.</span>
      )}
    </div>
  );
}

export function KindSplit({
  rows,
  onPick,
}: {
  rows: UsageBreakdownRow[];
  onPick?: (kind: string) => void;
}) {
  const total = rows.reduce((s, r) => s + spendOf(r), 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2 w-full overflow-hidden bg-paper-sunk">
        {rows.map((r) => (
          <span
            key={r.key}
            style={{
              width: `${total > 0 ? (spendOf(r) / total) * 100 : 0}%`,
              background: kindColor(r.key),
            }}
          />
        ))}
      </div>
      <div className="flex flex-col">
        {rows.map((r) => (
          <button
            key={r.key}
            onClick={() => onPick?.(r.key)}
            className="group flex items-center justify-between gap-3 border-b border-paper-rule px-1 py-1.5 text-left transition-colors last:border-b-0 hover:bg-paper-sunk"
          >
            <span className="flex items-center gap-2">
              <span
                className="inline-block size-2"
                style={{ background: kindColor(r.key) }}
              />
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
                {r.key}
              </span>
              <span className="meta-row text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
                activity →
              </span>
            </span>
            <span className="meta-row text-ink">
              {formatCost(spendOf(r))}
              <span className="ml-2 text-ink-faint">
                {total > 0 ? formatPercent(spendOf(r) / total) : "—"} · {r.events}{" "}
                calls
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function TaskCostTable({
  rows,
  onPick,
}: {
  rows: UsageBreakdownRow[];
  onPick?: (taskId: string) => void;
}) {
  return (
    <div className="flex flex-col">
      {rows.map((r) => (
        <div
          key={r.key}
          className="flex items-center justify-between gap-3 border-b border-paper-rule px-1 py-2 last:border-b-0"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Link to="/tasks" search={{ id: r.key }}>
              <Badge variant="secondary" className="font-mono">
                #{r.key}
              </Badge>
            </Link>
            <span className="meta-row text-ink-soft">
              {r.events} calls · {formatTokens(r.totalTokens)} tok
            </span>
          </span>
          <span className="flex items-center gap-3">
            <span className="font-mono text-sm tabular-nums text-ink">
              {formatCost(spendOf(r))}
            </span>
            {onPick && (
              <button
                onClick={() => onPick(r.key)}
                className="meta-row text-ink-faint transition-colors hover:text-ink"
              >
                activity →
              </button>
            )}
          </span>
        </div>
      ))}
      {rows.length === 0 && (
        <span className="meta-row py-3 text-ink-faint">
          No task-attributed usage in this range.
        </span>
      )}
    </div>
  );
}

export function BreakdownTab({
  byAgent,
  byModel,
  byKind,
  byTask,
  agentName,
  agentAvatar,
  onFilterAgent,
  onFilterModel,
  onFilterKind,
  onFilterTask,
  className,
}: {
  byAgent: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byKind: UsageBreakdownRow[];
  byTask: UsageBreakdownRow[];
  agentName: (id: string) => string;
  agentAvatar?: (id: string) => string | undefined;
  onFilterAgent: (id: string) => void;
  onFilterModel: (m: string) => void;
  onFilterKind: (k: string) => void;
  onFilterTask: (t: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-8", className)}>
      <section>
        <SectionEyebrow meta={`${byAgent.length} agents`}>
          By agent
        </SectionEyebrow>
        <AgentLedger
          rows={byAgent}
          agentName={agentName}
          agentAvatar={agentAvatar}
          onPick={onFilterAgent}
        />
      </section>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section>
          <SectionEyebrow meta={`${byModel.length} models`}>
            By model
          </SectionEyebrow>
          <ModelTable rows={byModel} onPick={onFilterModel} />
        </section>
        <section>
          <SectionEyebrow>By kind</SectionEyebrow>
          <KindSplit rows={byKind} onPick={onFilterKind} />
        </section>
      </div>
      <section>
        <SectionEyebrow meta={`${byTask.length} tasks`}>
          Cost per task
        </SectionEyebrow>
        <TaskCostTable rows={byTask} onPick={onFilterTask} />
      </section>
    </div>
  );
}
