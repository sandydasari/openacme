import { useState } from "react";
import { CalendarRange, ChevronsUpDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import { cn } from "@/app/lib/utils";

// Which task timestamp the range filters on. Updated is the default
// because every task carries it — Closed/Due empty out non-terminal /
// undated tasks, which is intentional but surprising as a default.
export type DateField = "updated_at" | "created_at" | "closed_at" | "due_at";

export interface DateRange {
  field: DateField;
  from: string | null; // YYYY-MM-DD (local), inclusive start-of-day
  to: string | null; // YYYY-MM-DD (local), inclusive end-of-day
}

export const EMPTY_DATE_RANGE: DateRange = {
  field: "updated_at",
  from: null,
  to: null,
};

export const dateRangeActive = (r: DateRange): boolean => !!(r.from || r.to);

const FIELDS: { value: DateField; label: string }[] = [
  { value: "updated_at", label: "Updated" },
  { value: "created_at", label: "Created" },
  { value: "closed_at", label: "Closed" },
  { value: "due_at", label: "Due" },
];

const fieldLabel = (f: DateField) =>
  FIELDS.find((x) => x.value === f)?.label ?? f;

// Local YYYY-MM-DD for `d`, matching the value space of <input type=date>.
function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toISO(d);
}

function startOfMonth(): string {
  const d = new Date();
  d.setDate(1);
  return toISO(d);
}

const PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  { label: "Today", range: () => ({ from: toISO(new Date()), to: toISO(new Date()) }) },
  { label: "7d", range: () => ({ from: daysAgo(6), to: toISO(new Date()) }) },
  { label: "30d", range: () => ({ from: daysAgo(29), to: toISO(new Date()) }) },
  { label: "Month", range: () => ({ from: startOfMonth(), to: toISO(new Date()) }) },
];

// Compact MM-DD for the trigger chip — stays in the engraved-ISO register
// the rest of the task surface uses, rather than a friendly "Jun 24".
const chip = (d: string) => d.slice(5);

function triggerLabel(r: DateRange): string {
  const f = fieldLabel(r.field);
  if (r.from && r.to) return `${f} ${chip(r.from)}→${chip(r.to)}`;
  if (r.from) return `${f} ≥ ${chip(r.from)}`;
  if (r.to) return `${f} ≤ ${chip(r.to)}`;
  return "Dates";
}

export function DateRangeFilter({
  value,
  onChange,
  className,
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = dateRangeActive(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 border border-paper-rule bg-paper px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors hover:bg-paper-sunk hover:text-ink",
            active ? "text-ink" : "text-ink-soft",
            className
          )}
        >
          <CalendarRange className="size-3 shrink-0 text-ink-faint" />
          <span className="max-w-[11rem] truncate normal-case">
            {triggerLabel(value)}
          </span>
          <ChevronsUpDown className="size-3 shrink-0 text-ink-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="border-b border-paper-rule px-3 py-2">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Filter by
          </div>
          <div className="grid grid-cols-4 border border-paper-rule">
            {FIELDS.map((f, i) => (
              <button
                key={f.value}
                type="button"
                onClick={() => onChange({ ...value, field: f.value })}
                className={cn(
                  "h-7 font-mono text-[10px] uppercase tracking-[0.04em] transition-colors",
                  i > 0 && "border-l border-paper-rule",
                  value.field === f.value
                    ? "bg-ink text-paper"
                    : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 border-b border-paper-rule px-3 py-2">
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              From
            </span>
            <input
              type="date"
              value={value.from ?? ""}
              max={value.to ?? undefined}
              onChange={(e) =>
                onChange({ ...value, from: e.target.value || null })
              }
              className="h-8 w-full border border-paper-rule bg-paper px-2 font-mono text-[12px] tabular-nums text-ink outline-none transition-colors focus:border-ink-soft"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              To
            </span>
            <input
              type="date"
              value={value.to ?? ""}
              min={value.from ?? undefined}
              onChange={(e) =>
                onChange({ ...value, to: e.target.value || null })
              }
              className="h-8 w-full border border-paper-rule bg-paper px-2 font-mono text-[12px] tabular-nums text-ink outline-none transition-colors focus:border-ink-soft"
            />
          </label>
        </div>

        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="grid flex-1 grid-cols-4 gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  const r = p.range();
                  onChange({ ...value, from: r.from, to: r.to });
                }}
                className="h-7 border border-paper-rule bg-paper font-mono text-[10px] uppercase tracking-[0.04em] text-ink-soft transition-colors hover:bg-paper-sunk hover:text-ink"
              >
                {p.label}
              </button>
            ))}
          </div>
          {active && (
            <button
              type="button"
              onClick={() => onChange({ ...value, from: null, to: null })}
              className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft transition-colors hover:text-plot-red"
            >
              Clear
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Read-time predicate: is `task` inside the active range? Tasks missing the
// chosen timestamp (e.g. an open task has no closed_at) fall out when a
// range is set — intended, so "Closed in June" never lists unclosed work.
export function taskInDateRange(
  dateOf: (field: DateField) => string | null,
  r: DateRange
): boolean {
  if (!dateRangeActive(r)) return true;
  const raw = dateOf(r.field);
  if (!raw) return false;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) return false;
  if (r.from && ms < new Date(`${r.from}T00:00:00`).getTime()) return false;
  if (r.to && ms > new Date(`${r.to}T23:59:59.999`).getTime()) return false;
  return true;
}
