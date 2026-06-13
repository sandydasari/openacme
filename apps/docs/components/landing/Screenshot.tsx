/* Theme-aware product screenshot. `name` maps to
   /screens/{light,dark}/<name>.{avif,webp} produced by scripts/optimize-shots.mjs.
   Captures are 1440x900 @2x. */
export function Screenshot({
  name,
  alt,
  priority = false,
}: {
  name: string;
  alt: string;
  priority?: boolean;
}) {
  return (
    <>
      <picture className="block dark:hidden">
        <source srcSet={`/screens/light/${name}.avif`} type="image/avif" />
        <img
          src={`/screens/light/${name}.webp`}
          alt={alt}
          width={2880}
          height={1800}
          loading={priority ? "eager" : "lazy"}
          className="block w-full"
        />
      </picture>
      <picture className="hidden dark:block">
        <source srcSet={`/screens/dark/${name}.avif`} type="image/avif" />
        <img
          src={`/screens/dark/${name}.webp`}
          alt={alt}
          width={2880}
          height={1800}
          loading="lazy"
          className="block w-full"
        />
      </picture>
    </>
  );
}
