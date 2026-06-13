/* Product screenshot for docs pages. `name` maps to
   /screens/{light,dark}/<name>.{avif,webp} from scripts/optimize-shots.mjs. */
export function DocShot({
  name,
  alt,
  caption,
}: {
  name: string;
  alt: string;
  caption?: string;
}) {
  const img = (theme: "light" | "dark") => (
    <picture
      className={theme === "light" ? "block dark:hidden" : "hidden dark:block"}
    >
      <source srcSet={`/screens/${theme}/${name}.avif`} type="image/avif" />
      <img
        src={`/screens/${theme}/${name}.webp`}
        alt={alt}
        width={2880}
        height={1800}
        loading="lazy"
        className="my-0! block w-full"
      />
    </picture>
  );

  return (
    <figure className="not-prose my-6 border border-paper-rule bg-paper-sunk">
      <div className="border-b border-paper-rule p-2 last:border-b-0">
        {img("light")}
        {img("dark")}
      </div>
      {caption ? (
        <figcaption className="px-3 py-2 text-[13px] text-ink-soft">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
