import Link from "next/link";
import { TONE_TEXT, type Tone } from "./Section";

export type IndexItem = { n: string; label: string; href: string; tone: Tone };

/* Scrolling index of the page — every entry is numbered and jumps to its
   section. Hover pauses the track. */
export function IndexMarquee({ items }: { items: IndexItem[] }) {
  const row = (hidden: boolean) => (
    <div aria-hidden={hidden} className="marquee-track flex shrink-0 items-center">
      {items.map((it) => (
        <Link
          key={it.n + it.label}
          href={it.href}
          tabIndex={hidden ? -1 : 0}
          className="group/ix inline-flex items-baseline gap-2.5 px-6 py-4 font-mono text-[12px] tracking-[0.16em] whitespace-nowrap uppercase focus-scribe"
        >
          <span className={`text-[10px] ${TONE_TEXT[it.tone]}`}>{it.n}</span>
          <span className="text-ink-soft underline-offset-4 transition-colors group-hover/ix:text-ink group-hover/ix:underline">
            {it.label}
          </span>
        </Link>
      ))}
    </div>
  );

  return (
    <div className="flex items-stretch border-y border-paper-rule">
      <span className="flex shrink-0 items-center border-r border-paper-rule px-5 font-mono text-[10px] tracking-[0.2em] text-ink-soft uppercase">
        Index
      </span>
      <div className="marquee group flex min-w-0 flex-1 overflow-hidden">
        {row(false)}
        {row(true)}
        {row(true)}
      </div>
    </div>
  );
}
