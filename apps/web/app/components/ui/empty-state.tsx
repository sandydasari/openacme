import type { LucideIcon } from "lucide-react";
import { cn } from "@/app/lib/utils";

// Shared empty-state: a muted glyph above a mono caption. Keeps the
// "nothing here yet" moments consistent across pages instead of bare text.
export function EmptyState({
  icon: Icon,
  children,
  className,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-4 py-8 text-center",
        className
      )}
    >
      <Icon className="size-5 text-ink-faint/70" aria-hidden />
      <p className="max-w-[34ch] font-mono text-[12px] leading-relaxed text-ink-faint">
        {children}
      </p>
    </div>
  );
}
