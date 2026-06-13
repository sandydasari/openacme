import { Fragment } from "react";

/* Staggered per-word rise — each word lifts out of an overflow-clipped
   slot. Pure CSS, plays once on load. */
export function RiseWords({
  text,
  delay = 0,
  className = "",
}: {
  text: string;
  delay?: number;
  className?: string;
}) {
  const words = text.split(" ");
  return (
    <span className={className}>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="-mb-[0.12em] inline-block overflow-hidden pb-[0.12em] align-bottom">
            <span
              className="rise-word inline-block"
              style={{ animationDelay: `${delay + i * 80}ms` }}
            >
              {w}
            </span>
          </span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </span>
  );
}
