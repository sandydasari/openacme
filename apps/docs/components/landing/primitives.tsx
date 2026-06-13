import type { ReactNode } from "react";

export function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-3 font-mono text-[12px] leading-none tracking-[0.2em] text-plot-red uppercase">
      <span className="inline-block size-1.5 bg-plot-red" />
      {children}
    </p>
  );
}

export type StatusTone = "ready" | "working" | "waiting" | "idle";

const TONE: Record<StatusTone, { dot: string; text: string }> = {
  ready: { dot: "bg-signal-green", text: "text-ink-soft" },
  working: { dot: "bg-signal-blue pulse-live", text: "text-ink-soft" },
  waiting: { dot: "bg-signal-amber", text: "text-ink-soft" },
  idle: { dot: "bg-paper-rule", text: "text-ink-faint" },
};

export function StatusChip({
  tone,
  children,
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <span
      className={`inline-flex items-center gap-2 border border-paper-rule px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] uppercase ${t.text}`}
    >
      <span className={`size-1.5 ${t.dot}`} />
      {children}
    </span>
  );
}
