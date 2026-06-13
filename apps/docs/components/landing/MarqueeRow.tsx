export function MarqueeRow({ items }: { items: string[] }) {
  const row = (hidden: boolean) => (
    <div
      aria-hidden={hidden}
      className="marquee-track flex shrink-0 items-center gap-12 pr-12"
    >
      {items.map((item) => (
        <span
          key={item}
          className="font-mono text-[12px] tracking-[0.18em] whitespace-nowrap text-ink-faint uppercase"
        >
          {item}
        </span>
      ))}
    </div>
  );

  return (
    <div className="marquee group flex overflow-hidden border-y border-paper-rule py-4">
      {row(false)}
      {row(true)}
      {row(true)}
    </div>
  );
}
