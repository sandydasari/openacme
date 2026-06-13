import type { ReactNode } from "react";

export function ImageFrame({
  caption,
  children,
  className = "",
}: {
  caption?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={`border border-paper-rule bg-paper-sunk ${className}`}>
      <div className="border-b border-paper-rule p-2 sm:p-3">{children}</div>
      {caption ? (
        <figcaption className="px-3 py-2 font-mono text-[11px] tracking-[0.12em] text-ink-faint uppercase">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
