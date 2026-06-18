import { X, AlertCircle } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { PierreFileIcon } from "@/app/components/chat/PierreFileIcon";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AttachmentChipProps {
  kind: "image" | "file" | "data";
  mediaType: string;
  size: number;
  name: string;
  status?: "uploading" | "ready" | "error";
  error?: string;
  /** When true, render an `X` button that calls onRemove. */
  removable?: boolean;
  onRemove?: () => void;
  /** When set, the chip becomes a link target — used for the user bubble. */
  href?: string;
}

export function AttachmentChip({
  mediaType,
  size,
  name,
  status,
  error,
  removable,
  onRemove,
  href,
}: AttachmentChipProps) {
  const inner = (
    <span className="flex items-center gap-2 min-w-0">
      {status === "uploading" ? (
        <LoadingHairline inline aria-label="Uploading" className="shrink-0" />
      ) : status === "error" ? (
        <AlertCircle className="size-3 shrink-0 text-destructive" />
      ) : (
        <PierreFileIcon name={name} mediaType={mediaType} className="size-3.5" />
      )}
      <span className="truncate text-[12px] text-ink">{name}</span>
      <span className="font-mono text-[11px] text-ink-faint shrink-0 tabular-nums">
        {formatSize(size)}
      </span>
    </span>
  );

  return (
    <span
      className={cn(
        "inline-flex max-w-[80vw] items-center gap-1 border border-paper-rule bg-paper-sunk px-2 py-1 sm:max-w-[260px]",
        status === "error" && "border-destructive text-destructive"
      )}
      title={error ?? `${name} (${mediaType})`}
    >
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 hover:text-plot-red"
        >
          {inner}
        </a>
      ) : (
        inner
      )}
      {removable && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove attachment"
          className="ml-1 p-0.5 text-ink-soft hover:text-destructive shrink-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
