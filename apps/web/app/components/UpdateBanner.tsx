import { useState } from "react";
import { ArrowUp, ArrowUpRight, Check, Copy, X } from "lucide-react";
import { useVersionCheck } from "@/app/lib/useVersionCheck";

const DISMISS_KEY = "openacme-update-dismissed";

function dismissedVersion(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * Sidebar "update available" notice. Notify-only — applying happens in the
 * user's shell (`openacme update`). Instrument register: dot + mono status
 * label, a mono version delta (no prose), the command on a code surface
 * (copy-on-click), and quiet actions. Dismissal is keyed by version so it
 * returns on the next release. Hidden when the sidebar is collapsed.
 */
export function UpdateBanner({ collapsed = false }: { collapsed?: boolean }) {
  const check = useVersionCheck();
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const latest = check && !check.upToDate ? check.latest : undefined;
  if (collapsed || !latest || dismissed || dismissedVersion() === latest) return null;

  const command = check?.command ?? "openacme update";

  const copy = () => {
    void navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, latest);
    } catch {
      // storage blocked — session-dismiss is enough
    }
    setDismissed(true);
  };

  return (
    <div className="space-y-2 border-t border-paper-rule px-4 py-3">
      <div className="flex items-center gap-2">
        <ArrowUp className="size-3.5 shrink-0 text-plot-red" aria-hidden />
        <span className="flex-1 font-mono text-[11px] tracking-[0.08em] text-ink uppercase">
          Update available
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-soft tabular-nums">
          {latest}
        </span>
      </div>

      <button
        type="button"
        onClick={copy}
        className="group flex w-full items-center gap-2 border border-code-surface-rule bg-code-surface px-2.5 py-1.5 text-left font-mono text-[12px] text-ink transition-colors hover:border-ink-faint"
        aria-label={`Copy command: ${command}`}
      >
        <span className="text-ink-faint">$</span>
        <span className="min-w-0 flex-1 truncate">{command}</span>
        {copied ? (
          <Check className="size-3.5 shrink-0 text-signal-green" aria-hidden />
        ) : (
          <Copy className="size-3.5 shrink-0 text-ink-faint group-hover:text-ink-soft" aria-hidden />
        )}
      </button>

      <div className="flex items-center justify-between font-mono text-[11px] tracking-[0.08em] uppercase">
        <a
          href="https://openacme.pages.dev/changelog"
          target="_blank"
          rel="noreferrer"
          className="group flex items-center gap-1 text-ink-faint transition-colors hover:text-ink-soft"
        >
          Changelog
          <ArrowUpRight className="size-3 text-ink-faint transition-colors group-hover:text-ink-soft" aria-hidden />
        </a>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss update notice"
          className="flex items-center gap-1 text-ink-faint transition-colors hover:text-ink-soft"
        >
          Dismiss
          <X className="size-3" aria-hidden />
        </button>
      </div>
    </div>
  );
}
