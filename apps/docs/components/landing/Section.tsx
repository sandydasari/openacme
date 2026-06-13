import type { ReactNode } from "react";

/* Coded color — every domain gets a signal hue, used for indices, rules,
   and demo accents. Literal class maps so Tailwind sees the names. */
export type Tone = "red" | "amber" | "blue" | "green" | "violet";

export const TONE_TEXT: Record<Tone, string> = {
  red: "text-plot-red",
  amber: "text-signal-amber",
  blue: "text-signal-blue",
  green: "text-signal-green",
  violet: "text-signal-violet",
};

export const TONE_BG: Record<Tone, string> = {
  red: "bg-plot-red",
  amber: "bg-signal-amber",
  blue: "bg-signal-blue",
  green: "bg-signal-green",
  violet: "bg-signal-violet",
};

/* Blueprint crosshair at rule intersections. */
export function Crosshair({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute z-10 text-ink-faint ${className}`}
    >
      <svg width="9" height="9" viewBox="0 0 9 9" className="block">
        <path
          d="M4.5 0V9M0 4.5H9"
          stroke="currentColor"
          strokeWidth="1"
          opacity="0.7"
        />
      </svg>
    </span>
  );
}

/* Numbered section module — spec-sheet rail with index, label, title,
   and an optional right-aligned lede. */
export function Section({
  index,
  label,
  title,
  lede,
  children,
  id,
  tone = "red",
  flush = false,
  className = "",
}: {
  index: string;
  label: string;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  id?: string;
  tone?: Tone;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`relative scroll-mt-14 border-t border-paper-rule ${className}`}
    >
      <Crosshair className="-top-[4.5px] -left-[4.5px]" />
      <Crosshair className="-top-[4.5px] -right-[4.5px]" />
      <div
        className={`px-6 pt-16 sm:px-10 sm:pt-20 ${flush ? "pb-0" : "pb-16 sm:pb-20"}`}
      >
        <header className="grid gap-6 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-7">
            <p className="flex items-baseline gap-3 font-mono text-[12px] leading-none tracking-[0.18em] uppercase">
              <span className={`inline-block size-2 -translate-y-px self-center ${TONE_BG[tone]}`} />
              <span className={TONE_TEXT[tone]}>{index}</span>
              <span className="text-ink-faint">{label}</span>
            </p>
            <h2 className="mt-4 max-w-xl text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.015em] text-balance">
              {title}
            </h2>
          </div>
          {lede ? (
            <div className="self-end text-[15px] leading-relaxed text-ink-soft lg:col-span-5">
              {lede}
            </div>
          ) : null}
        </header>
        <div className="mt-10 sm:mt-12">{children}</div>
      </div>
    </section>
  );
}
