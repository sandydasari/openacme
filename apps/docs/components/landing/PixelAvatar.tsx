/* Deterministic 7×7 pixel face from a seed string — every agent gets a
   distinct, stable mark in the pixel-robot family. */
export function PixelAvatar({
  seed,
  className = "",
}: {
  seed: string;
  className?: string;
}) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const next = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
  const cells: boolean[] = new Array(49).fill(false);
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 4; x++) {
      const on = next() < (y === 0 || y === 6 ? 0.35 : 0.6);
      cells[y * 7 + x] = on;
      cells[y * 7 + (6 - x)] = on;
    }
  }
  // a face needs eyes and a mouth gap
  cells[2 * 7 + 2] = true;
  cells[2 * 7 + 4] = true;
  cells[2 * 7 + 3] = false;
  cells[4 * 7 + 2] = true;
  cells[4 * 7 + 3] = true;
  cells[4 * 7 + 4] = true;

  return (
    <svg
      viewBox="0 0 7 7"
      className={className}
      shapeRendering="crispEdges"
      aria-hidden
    >
      {cells.map((on, i) =>
        on ? (
          <rect
            key={i}
            x={i % 7}
            y={Math.floor(i / 7)}
            width="1"
            height="1"
            fill="currentColor"
          />
        ) : null,
      )}
    </svg>
  );
}
