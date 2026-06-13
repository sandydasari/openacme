"use client";

import { useEffect, useState } from "react";
import { useInView, usePrefersReducedMotion } from "./hooks";

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&";

export function ScrambleText({
  text,
  className,
  durationMs = 600,
}: {
  text: string;
  className?: string;
  durationMs?: number;
}) {
  const [ref, inView] = useInView<HTMLSpanElement>(0.4);
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(text);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!inView || reduced || started) return;
    setStarted(true);
    const start = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const t = Math.min((now - start) / durationMs, 1);
      const settled = Math.floor(t * text.length);
      setDisplay(
        text
          .split("")
          .map((ch, i) => {
            if (i < settled || ch === " ") return ch;
            return CHARSET[Math.floor(((now / 30) * (i + 1)) % CHARSET.length)];
          })
          .join(""),
      );
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(text);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, reduced, started, text, durationMs]);

  return (
    <span ref={ref} className={className} aria-label={text}>
      {display}
    </span>
  );
}
