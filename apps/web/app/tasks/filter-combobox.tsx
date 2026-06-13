import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import { cn } from "@/app/lib/utils";

export interface ComboOption {
  value: string;
  label: string;
}

// Searchable single-select for the task filters. `"all"` is the sentinel
// reset value rendered as `allLabel`; everything else comes from `options`.
export function FilterCombobox({
  value,
  options,
  onChange,
  allLabel,
  searchPlaceholder,
  className,
}: {
  value: string;
  options: ComboOption[];
  onChange: (v: string) => void;
  allLabel: string;
  searchPlaceholder: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(needle) ||
        o.value.toLowerCase().includes(needle)
    );
  }, [options, q]);

  const current =
    value === "all"
      ? allLabel
      : (options.find((o) => o.value === value)?.label ?? value);

  const select = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 border border-paper-rule bg-paper px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors hover:bg-paper-sunk hover:text-ink",
            value === "all" ? "text-ink-soft" : "text-ink",
            className
          )}
        >
          <span className="max-w-[9rem] truncate">{current}</span>
          <ChevronsUpDown className="size-3 shrink-0 text-ink-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-0">
        <div className="relative border-b border-paper-rule">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 w-full bg-transparent pl-8 pr-2 text-[13px] text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          <Option
            label={allLabel}
            active={value === "all"}
            onSelect={() => select("all")}
          />
          {filtered.map((o) => (
            <Option
              key={o.value}
              label={o.label}
              active={value === o.value}
              onSelect={() => select(o.value)}
            />
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-ink-faint">No match</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Option({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-paper-sunk",
        active ? "text-ink" : "text-ink-soft"
      )}
    >
      <span className="truncate">{label}</span>
      {active && <Check className="size-3.5 shrink-0 text-plot-red" />}
    </button>
  );
}
