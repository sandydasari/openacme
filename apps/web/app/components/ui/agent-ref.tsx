"use client"

import Link from "next/link"

import { cn } from "@/app/lib/utils"

/**
 * Inline reference to an agent — renders `@<id>` (or a display name) as a
 * deep link to the agent's page. stopPropagation so it works inside
 * clickable rows/cards without triggering the row action.
 */
export function AgentRef({
  id,
  label,
  className,
}: {
  id: string
  /** Display text; defaults to `@<id>`. */
  label?: string
  className?: string
}) {
  return (
    <Link
      href={`/agents?id=${encodeURIComponent(id)}`}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "underline-offset-2 transition-colors hover:text-plot-red hover:underline focus-visible:text-plot-red focus-visible:underline focus-visible:outline-none",
        className
      )}
    >
      {label ?? `@${id}`}
    </Link>
  )
}
