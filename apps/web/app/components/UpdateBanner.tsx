import { useState } from "react";
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
 * user's shell (`openacme update`), where PATH/package-manager/permissions are
 * correct. Mirrors InstallHint's expandable card. Self-gates on an available
 * update; dismissal is keyed by version so it reappears on the next release.
 * Hidden when the sidebar is collapsed (like the other bottom labels).
 */
export function UpdateBanner({ collapsed = false }: { collapsed?: boolean }) {
  const check = useVersionCheck();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const latest = check && !check.upToDate ? check.latest : undefined;
  if (collapsed || !latest || dismissed || dismissedVersion() === latest) return null;

  const command = check?.command ?? "openacme update";

  return (
    <div className="border-t border-paper-rule">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:text-plot-red"
        aria-expanded={expanded}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-plot-red" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">Update available</span>
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
          {expanded ? "Hide" : `v${latest}`}
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 px-4 pb-3 text-[13px] leading-relaxed text-ink-soft">
          <div>
            OpenAcme v{latest} is available (you have v{check?.current}).
          </div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(command);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
            className="group flex w-full items-center gap-2 border border-code-surface-rule bg-code-surface px-2.5 py-1.5 text-left font-mono text-[12px] text-ink transition-colors hover:border-ink-faint"
            aria-label={`Copy command: ${command}`}
          >
            <span className="text-ink-faint">$</span>
            <span className="min-w-0 flex-1 truncate">{command}</span>
            <span
              className={`shrink-0 text-[10px] uppercase tracking-[0.08em] ${
                copied ? "text-signal-green" : "text-ink-faint group-hover:text-ink-soft"
              }`}
            >
              {copied ? "Copied" : "Copy"}
            </span>
          </button>
          <div className="flex items-center justify-between">
            <a
              href="https://openacme.pages.dev/docs/cli"
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:text-ink hover:underline"
            >
              How to update
            </a>
            <button
              type="button"
              onClick={() => {
                try {
                  if (latest) window.localStorage.setItem(DISMISS_KEY, latest);
                } catch {
                  // storage blocked — session-dismiss is enough
                }
                setDismissed(true);
              }}
              className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint hover:text-ink-soft"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
