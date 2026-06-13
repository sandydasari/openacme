"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface ShowcaseStep {
  title: string;
  body: string;
  visual: ReactNode;
}

export function StickyShowcase({ steps }: { steps: ShowcaseStep[] }) {
  const [active, setActive] = useState(0);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = stepRefs.current.indexOf(
            entry.target as HTMLDivElement,
          );
          if (idx >= 0) setActive(idx);
        }
      },
      // Fire when a step crosses the middle band of the viewport.
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const el of stepRefs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,26rem)_1fr] lg:gap-16">
      <div>
        {steps.map((step, i) => (
          <div
            key={step.title}
            ref={(el) => {
              stepRefs.current[i] = el;
            }}
            className={`border-l-2 py-10 pl-6 transition-colors duration-300 lg:min-h-[45vh] ${
              active === i ? "border-plot-red" : "border-paper-rule"
            }`}
          >
            <span
              className={`font-mono text-[12px] tracking-[0.14em] ${
                active === i ? "text-plot-red" : "text-ink-faint"
              }`}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-2 text-xl font-semibold tracking-tight">
              {step.title}
            </h3>
            <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-ink-soft">
              {step.body}
            </p>
            {/* Mobile: show each step's visual inline. */}
            <div className="mt-6 lg:hidden">{step.visual}</div>
          </div>
        ))}
      </div>
      <div className="relative hidden lg:block">
        <div className="sticky top-24">
          {steps.map((step, i) => (
            <div
              key={step.title}
              className={`transition-opacity duration-300 ${
                active === i
                  ? "relative opacity-100"
                  : "absolute inset-0 opacity-0"
              }`}
              aria-hidden={active !== i}
            >
              {step.visual}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
