/* Dot-grid backdrop on the 28px grid, faded out toward the lower-left.
   Pure CSS — no canvas, no glow. */
export function PixelGrid() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10"
      style={{
        backgroundImage:
          "radial-gradient(var(--paper-rule) 1px, transparent 1px)",
        backgroundSize: "28px 28px",
        maskImage:
          "linear-gradient(115deg, transparent 45%, black 90%), linear-gradient(to bottom, black 70%, transparent 100%)",
        maskComposite: "intersect",
        WebkitMaskImage:
          "linear-gradient(115deg, transparent 45%, black 90%), linear-gradient(to bottom, black 70%, transparent 100%)",
        WebkitMaskComposite: "source-in",
      }}
    />
  );
}
