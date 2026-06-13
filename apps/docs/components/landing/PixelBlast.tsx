"use client";

import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./hooks";

/* Living pixel field — canvas-2D take on the shader "pixel blast" idea:
   squares on the grid breathe in and out on hashed phases, and the pointer
   drags a ripple through them. No WebGL, no deps; brand tokens only. */

const PITCH = 14;
const SIZE = 3.5;
const RIPPLE_LIFE = 1400;

type Ripple = { x: number; y: number; t0: number; force: number };

function hash(ix: number, iy: number) {
  let h = ix * 374761393 + iy * 668265263;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 8) / 16777216;
}

const DEFAULT_MASK =
  "linear-gradient(115deg, transparent 38%, black 85%), linear-gradient(to bottom, black 72%, transparent 100%)";

export function PixelBlast({
  className = "text-ink-faint",
  mask = DEFAULT_MASK,
}: {
  className?: string;
  mask?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let running = false;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let frame = 0;
    let inkCache = "";
    let hues: string[] = [];
    const ripples: Ripple[] = [];

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, w, h);
      if (!inkCache || frame % 60 === 0) {
        const cs = getComputedStyle(canvas);
        inkCache = cs.color;
        hues = [
          "--plot-red",
          "--signal-amber",
          "--signal-blue",
          "--signal-green",
          "--signal-violet",
        ].map((v) => cs.getPropertyValue(v).trim() || inkCache);
      }
      frame++;
      const cols = Math.ceil(w / PITCH);
      const rows = Math.ceil(h / PITCH);
      const t = now / 1000;
      const live = ripples.filter((r) => now - r.t0 < RIPPLE_LIFE);
      ripples.length = 0;
      ripples.push(...live);

      for (let iy = 0; iy < rows; iy++) {
        for (let ix = 0; ix < cols; ix++) {
          const r1 = hash(ix, iy);
          const r2 = hash(ix + 1013, iy + 511);
          // sparse field — most cells stay dark most of the time
          let v = 0.5 + 0.5 * Math.sin(t * (0.4 + r2 * 1.1) * 2 + r1 * Math.PI * 2);
          v = Math.pow(v, 5) * (0.25 + r2 * 0.75);

          const cx = ix * PITCH + PITCH / 2;
          const cy = iy * PITCH + PITCH / 2;
          for (const rp of ripples) {
            const age = (now - rp.t0) / RIPPLE_LIFE;
            const radius = age * 320;
            const d = Math.hypot(cx - rp.x, cy - rp.y);
            const band = Math.exp(-(((d - radius) / 34) ** 2));
            v += band * (1 - age) * rp.force;
          }

          const a = Math.min(v, 1) * 0.5;
          if (a < 0.02) continue;
          // ~7% of cells carry a signal hue — quiet confetti, mostly ink
          const r3 = hash(ix + 77, iy + 991);
          ctx.fillStyle =
            r3 < 0.07 ? hues[Math.floor(r3 * 71) % hues.length]! : inkCache;
          ctx.globalAlpha = r3 < 0.07 ? Math.min(a * 1.6, 0.85) : a;
          const grow = SIZE + Math.min(v, 1) * 2;
          ctx.fillRect(cx - grow / 2, cy - grow / 2, grow, grow);
        }
      }
      ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
      if (!running) return;
      draw(now);
      raf = requestAnimationFrame(loop);
    };

    resize();
    if (reduced) {
      draw(2400); // one settled frame
    }

    const io = new IntersectionObserver(([entry]) => {
      const visible = !!entry?.isIntersecting;
      if (visible && !running && !reduced) {
        running = true;
        raf = requestAnimationFrame(loop);
      } else if (!visible && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    });
    io.observe(canvas);

    const toLocal = (e: PointerEvent): Ripple | null => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
      return { x, y, t0: performance.now(), force: 0 };
    };
    let lastMove = 0;
    const onMove = (e: PointerEvent) => {
      if (reduced || !running) return;
      const now = performance.now();
      if (now - lastMove < 90) return;
      lastMove = now;
      const r = toLocal(e);
      if (r) ripples.push({ ...r, force: 0.5 });
    };
    const onDown = (e: PointerEvent) => {
      if (reduced) return;
      const r = toLocal(e);
      if (r) ripples.push({ ...r, force: 1.4 });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    const ro = new ResizeObserver(() => {
      resize();
      if (reduced) draw(2400);
    });
    ro.observe(canvas);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [reduced]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`pointer-events-none absolute inset-0 -z-10 size-full ${className}`}
      style={{
        maskImage: mask,
        maskComposite: "intersect",
        WebkitMaskImage: mask,
        WebkitMaskComposite: "source-in",
      }}
    />
  );
}
