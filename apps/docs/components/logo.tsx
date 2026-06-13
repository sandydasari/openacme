"use client";

import { useId } from "react";

export function Logomark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 10 10"
      shapeRendering="crispEdges"
      fill="currentColor"
      role="img"
      aria-label="OpenAcme"
      className={className}
    >
      <rect x="3" y="1" width="3" height="1" />
      <rect x="4" y="2" width="1" height="2" />
      <rect x="1" y="5" width="1" height="1" />
      <rect x="2" y="4" width="6" height="2" />
      <rect x="8" y="5" width="1" height="1" />
      <rect x="0" y="6" width="2" height="2" />
      <rect x="4" y="6" width="2" height="2" />
      <rect x="8" y="6" width="2" height="2" />
      <rect x="0" y="8" width="10" height="2" />
    </svg>
  );
}

/* Pixel wordmark from docs/images/logo-text.svg, refilled with currentColor. */
export function Wordmark({ className }: { className?: string }) {
  // Mask id must be unique per instance — the layout mounts this in both the
  // top nav and the sidebar, and a duplicate id can resolve to a hidden copy.
  const maskId = useId();
  return (
    <svg
      viewBox="0 0 500 78"
      shapeRendering="crispEdges"
      role="img"
      aria-label="OpenAcme"
      className={className}
    >
      <defs>
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="500"
          height="78"
        >
          <rect width="500" height="78" fill="white" />
          <g
            transform="translate(0,78) scale(0.1,-0.1)"
            fill="black"
            stroke="none"
          >
            <path d="M0 390 l0 -390 2500 0 2500 0 0 390 0 390 -2500 0 -2500 0 0 -390z m560 -10 l0 -280 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -280z m560 70 l0 -210 -140 0 -140 0 0 -70 0 -70 -70 0 -70 0 0 280 0 280 210 0 210 0 0 -210z m560 140 l0 -70 -140 0 -140 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -70z m280 0 l0 -70 70 0 70 0 0 -70 0 -70 70 0 70 0 0 140 0 140 70 0 70 0 0 -280 0 -280 -70 0 -70 0 0 70 0 70 -70 0 -70 0 0 70 0 70 -70 0 -70 0 0 -140 0 -140 -70 0 -70 0 0 280 0 280 70 0 70 0 0 -70z m980 -210 l0 -280 -70 0 -70 0 0 70 0 70 -70 0 -70 0 0 -70 0 -70 -70 0 -70 0 0 210 0 210 70 0 70 0 0 70 0 70 140 0 140 0 0 -280z m560 210 l0 -70 -140 0 -140 0 0 -140 0 -140 140 0 140 0 0 -70 0 -70 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -70z m420 0 l0 -70 70 0 70 0 0 70 0 70 140 0 140 0 0 -280 0 -280 -70 0 -70 0 0 210 0 210 -70 0 -70 0 0 -140 0 -140 -70 0 -70 0 0 140 0 140 -70 0 -70 0 0 -210 0 -210 -70 0 -70 0 0 280 0 280 140 0 140 0 0 -70z m980 0 l0 -70 -140 0 -140 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -70z" />
            <path d="M280 380 l0 -140 70 0 70 0 0 140 0 140 -70 0 -70 0 0 -140z" />
            <path d="M840 450 l0 -70 70 0 70 0 0 70 0 70 -70 0 -70 0 0 -70z" />
            <path d="M2660 450 l0 -70 70 0 70 0 0 70 0 70 -70 0 -70 0 0 -70z" />
          </g>
        </mask>
      </defs>
      <rect
        width="500"
        height="78"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}

export function LogoLockup() {
  return (
    <span className="inline-flex items-center gap-3 py-1">
      <Logomark className="size-7" />
      <Wordmark className="h-[18px] w-auto" />
    </span>
  );
}
