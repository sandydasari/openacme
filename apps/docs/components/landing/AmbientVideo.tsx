"use client";

import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./hooks";

/* Autoplaying muted loop — a living screenshot, no player chrome.
   Reduced motion gets the static poster. */
export function AmbientVideo({
  mp4,
  webm,
  poster,
  width,
  height,
}: {
  mp4: string;
  webm?: string;
  poster: string;
  width: number;
  height: number;
}) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!reduced) void ref.current?.play().catch(() => {});
  }, [reduced]);

  if (reduced) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={poster}
        alt="The OpenAcme console — roster, task board, and chat"
        width={width}
        height={height}
        className="block w-full"
      />
    );
  }

  return (
    <video
      ref={ref}
      autoPlay
      muted
      loop
      playsInline
      poster={poster}
      width={width}
      height={height}
      className="block w-full"
      aria-label="A task moving through the OpenAcme console — roster, board, brief, result, chat"
    >
      {webm ? <source src={webm} type="video/webm" /> : null}
      <source src={mp4} type="video/mp4" />
    </video>
  );
}
