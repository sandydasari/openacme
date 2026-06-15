import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Gauge, X } from "lucide-react";
import { z } from "zod";
import { Sidebar } from "@/app/components/Sidebar";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import { API_BASE } from "@/app/lib/api";
import { cn } from "@/app/lib/utils";
import { USAGE_KINDS, type UsageKind } from "@/app/lib/types";
import { useUsage, type UsageFilterState } from "@/app/lib/useUsage";
import { StatBlocks } from "@/app/usage/stat-blocks";
import {
  SpendChart,
  type SpendGroupBy,
  type SpendMetric,
} from "@/app/usage/spend-chart";
import { CalendarHeatmap, PunchCard } from "@/app/usage/heatmaps";
import { BreakdownTab } from "@/app/usage/breakdown-tab";
import { ActivityTab } from "@/app/usage/activity-tab";

const RANGES = [
  { id: "1d", label: "24H", seconds: 86_400 },
  { id: "7d", label: "7D", seconds: 7 * 86_400 },
  { id: "30d", label: "30D", seconds: 30 * 86_400 },
  { id: "90d", label: "90D", seconds: 90 * 86_400 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

export const Route = createFileRoute("/usage")({
  validateSearch: z.object({
    tab: z.enum(["overview", "breakdown", "activity"]).optional(),
    range: z.enum(["1d", "7d", "30d", "90d"]).optional(),
    /** Set by heatmap day-click: ISO date, overrides `range`. */
    day: z.coerce.string().optional(),
    /** Custom window from a chart-brush zoom (epoch seconds).
     *  Overrides `range` and `day` when both are present. */
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
    agentId: z.coerce.string().optional(),
    model: z.coerce.string().optional(),
    kind: z.enum(USAGE_KINDS).optional(),
    taskId: z.coerce.string().optional(),
  }),
  component: UsagePage,
});

interface AgentIdentity {
  name: string;
  avatar?: string;
}

function UsagePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/usage" });
  const tab = search.tab ?? "overview";
  const rangeId: RangeId = search.range ?? "7d";

  const [agents, setAgents] = useState<Map<string, AgentIdentity>>(new Map());
  const [metric, setMetric] = useState<SpendMetric>("cost");
  const [groupBy, setGroupBy] = useState<SpendGroupBy>("agent");
  const [liveTick, setLiveTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/agents`, {
          credentials: "include",
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const defs = (await res.json()) as Array<{
          id: string;
          name: string;
          avatar?: string;
        }>;
        setAgents(
          new Map(defs.map((d) => [d.id, { name: d.name, avatar: d.avatar }]))
        );
      } catch {
        // identity decoration only — ids render fine without it
      }
    })();
    return () => ctrl.abort();
  }, []);

  // liveTick is a dep on purpose: each usage_event advances `to` so
  // fresh rows land inside the window — otherwise the range freezes at
  // page-load time and live turns are invisible to totals/series.
  // Fixed windows (brush zoom, day click) don't slide — intended.
  const filter: UsageFilterState = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const dims = {
      agentId: search.agentId,
      model: search.model,
      kind: search.kind,
      taskId: search.taskId,
    };
    if (search.from !== undefined && search.to !== undefined) {
      return { from: search.from, to: search.to, ...dims };
    }
    if (search.day) {
      const dayStart = Math.floor(Date.parse(`${search.day}T00:00:00Z`) / 1000);
      return { from: dayStart, to: dayStart + 86_400, ...dims };
    }
    const seconds = RANGES.find((r) => r.id === rangeId)!.seconds;
    return { from: now - seconds, to: now, ...dims };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    search.from,
    search.to,
    search.day,
    search.agentId,
    search.model,
    search.kind,
    search.taskId,
    rangeId,
    liveTick,
  ]);

  // Hour buckets for windows up to two days, day buckets beyond.
  const bucket: "hour" | "day" =
    filter.to - filter.from <= 2 * 86_400 ? "hour" : "day";
  const { data, loading, error } = useUsage(filter, {
    seriesBucket: bucket,
    seriesGroupBy: groupBy,
  });

  // Bump the activity tab's reload counter on live usage events.
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/home/stream`, {
      withCredentials: true,
    });
    const onUsage = () => setLiveTick((t) => t + 1);
    es.addEventListener("usage_event", onUsage);
    return () => {
      es.removeEventListener("usage_event", onUsage);
      es.close();
    };
  }, []);

  const setSearch = useCallback(
    (patch: Partial<typeof search>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }) });
    },
    [navigate]
  );

  const agentName = useCallback(
    (id: string) => agents.get(id)?.name ?? id,
    [agents]
  );
  const agentAvatar = useCallback(
    (id: string) => agents.get(id)?.avatar,
    [agents]
  );
  const labelForSeries = useCallback(
    (key: string) => (groupBy === "agent" ? agentName(key) : key),
    [groupBy, agentName]
  );

  const chips: Array<{ label: string; clear: Partial<typeof search> }> = [];
  if (search.from !== undefined && search.to !== undefined) {
    const fmt = (s: number) =>
      new Date(s * 1000).toISOString().slice(5, 16).replace("T", " ");
    chips.push({
      label: `${fmt(search.from)} – ${fmt(search.to)}`,
      clear: { from: undefined, to: undefined },
    });
  }
  if (search.day) chips.push({ label: search.day, clear: { day: undefined } });
  if (search.agentId)
    chips.push({
      label: `agent: ${agentName(search.agentId)}`,
      clear: { agentId: undefined },
    });
  if (search.model)
    chips.push({ label: `model: ${search.model}`, clear: { model: undefined } });
  if (search.kind)
    chips.push({ label: `kind: ${search.kind}`, clear: { kind: undefined } });
  if (search.taskId)
    chips.push({ label: `task #${search.taskId}`, clear: { taskId: undefined } });

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />
      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-3 md:px-6">
          <h1 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
            <Gauge className="size-3.5" aria-hidden />
            Usage
          </h1>
          <div className="inline-flex border border-paper-rule">
            {RANGES.map((r, i) => (
              <button
                key={r.id}
                onClick={() =>
                  setSearch({
                    range: r.id,
                    day: undefined,
                    from: undefined,
                    to: undefined,
                  })
                }
                className={cn(
                  "inline-flex h-7 items-center px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors",
                  i > 0 && "border-l border-paper-rule",
                  rangeId === r.id && !search.day && search.from === undefined
                    ? "bg-ink text-paper"
                    : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink"
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </header>

        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-paper-rule px-3 py-2 md:px-6">
            <span className="label-faceplate">Filters</span>
            {chips.map((chip) => (
              <button
                key={chip.label}
                onClick={() => setSearch(chip.clear)}
                className="inline-flex items-center gap-1 bg-paper-sunk px-2 py-0.5 font-mono text-[11px] text-ink-soft transition-colors hover:text-ink"
              >
                {chip.label}
                <X className="size-3" />
              </button>
            ))}
          </div>
        )}

        {loading && !data.summary ? (
          <div className="relative flex flex-1 items-end px-6 py-12 section-enter">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Reading usage ledger
            </span>
            <LoadingHairline />
          </div>
        ) : error ? (
          <div className="px-6 py-8">
            <span className="meta-row text-destructive">
              Usage ledger unavailable: {error}
            </span>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <Tabs
              value={tab}
              onValueChange={(v) => setSearch({ tab: v as typeof tab })}
              className="flex flex-col"
            >
              <TabsList className="px-3 md:px-6">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="breakdown">Breakdown</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="section-enter">
                {data.summary && (
                  <StatBlocks
                    summary={data.summary}
                    onTurnsClick={() => setSearch({ tab: "activity" })}
                  />
                )}
                <div className="flex flex-col gap-8 px-3 py-6 md:px-6">
                  <section>
                    <SectionEyebrow
                      meta={
                        <span className="flex items-center gap-3">
                          <Toggle
                            options={["cost", "tokens", "turns"]}
                            value={metric}
                            onChange={(v) => setMetric(v as SpendMetric)}
                          />
                          <Toggle
                            options={["agent", "model", "kind"]}
                            value={groupBy}
                            onChange={(v) => setGroupBy(v as SpendGroupBy)}
                          />
                        </span>
                      }
                    >
                      Spend over time
                    </SectionEyebrow>
                    <div className="pt-3">
                      <SpendChart
                        rows={data.series}
                        bucket={bucket}
                        metric={metric}
                        groupBy={groupBy}
                        labelFor={labelForSeries}
                        onPickKey={(key) => {
                          if (groupBy === "agent") setSearch({ agentId: key });
                          else if (groupBy === "model") setSearch({ model: key });
                          else setSearch({ kind: key as UsageKind });
                        }}
                        onZoom={(from, to) =>
                          setSearch({ from, to, day: undefined })
                        }
                      />
                    </div>
                  </section>

                  <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
                    <section>
                      <SectionEyebrow meta="UTC days">
                        Daily activity
                      </SectionEyebrow>
                      <div className="overflow-x-auto pt-3">
                        {data.heatmap && (
                          <CalendarHeatmap
                            heatmap={data.heatmap}
                            onPickDay={(day) => setSearch({ day })}
                          />
                        )}
                      </div>
                    </section>
                    <section>
                      <SectionEyebrow meta="agent × hour (UTC)">
                        Punch card
                      </SectionEyebrow>
                      <div className="overflow-x-auto pt-3">
                        {data.heatmap && (
                          <PunchCard
                            heatmap={data.heatmap}
                            agentName={agentName}
                            agentAvatar={agentAvatar}
                          />
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="breakdown" className="section-enter">
                <BreakdownTab
                  className="px-3 py-6 md:px-6"
                  byAgent={data.breakdownAgent}
                  byModel={data.breakdownModel}
                  byKind={data.breakdownKind}
                  byTask={data.breakdownTask}
                  agentName={agentName}
                  agentAvatar={agentAvatar}
                  onFilterAgent={(id) =>
                    setSearch({ agentId: id, tab: "activity" })
                  }
                  onFilterModel={(m) => setSearch({ model: m, tab: "activity" })}
                  onFilterKind={(k) =>
                    setSearch({ kind: k as UsageKind, tab: "activity" })
                  }
                  onFilterTask={(t) => setSearch({ taskId: t, tab: "activity" })}
                />
              </TabsContent>

              <TabsContent value="activity" className="section-enter">
                <div className="px-3 py-6 md:px-6">
                  <ActivityTab
                    filter={filter}
                    agentName={agentName}
                    agentAvatar={agentAvatar}
                    liveTick={liveTick}
                  />
                </div>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </main>
    </div>
  );
}

function Toggle({
  options,
  value,
  onChange,
}: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <span className="inline-flex border border-paper-rule">
      {options.map((o, i) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={cn(
            "inline-flex h-5 items-center px-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors",
            i > 0 && "border-l border-paper-rule",
            value === o
              ? "bg-ink text-paper"
              : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink"
          )}
        >
          {o}
        </button>
      ))}
    </span>
  );
}
