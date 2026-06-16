import { getAuthor } from "@/lib/authors";
import { PixelAvatar } from "@/components/landing/PixelAvatar";

export function AuthorBadge({
  author,
  className = "",
}: {
  author: string;
  className?: string;
}) {
  const { name, role } = getAuthor(author);
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="flex size-6 shrink-0 items-center justify-center border border-paper-rule bg-paper-sunk text-ink-soft">
        <PixelAvatar seed={author} className="size-3.5" />
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-[13px] text-ink">{name}</span>
        {role ? (
          <span className="font-mono text-[10px] tracking-[0.1em] text-ink-faint uppercase">
            {role}
          </span>
        ) : null}
      </span>
    </span>
  );
}
