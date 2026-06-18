import { useState } from "react";
import { ArrowUp, Check, Copy, X } from "lucide-react";
import { useVersionCheck } from "@/app/lib/useVersionCheck";

const DISMISS_KEY = "openacme-update-dismissed";
const CHANGELOG_URL = "https://openacme.org/changelog";
const HIDDEN_PATHS = new Set(["/login", "/setup", "/enroll"]);

function dismissedVersion(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * Floating "update available" notice. Notify-only — applying happens in the
 * user's shell (`openacme update`). Borrows the AcmePanel elevation idiom
 * (hairline `ink/15` border + shadow over `paper-sunk`) so it reads as floating
 * chrome, not page content. A short helper line tells the user what running the
 * command gets them; actions are icon-only (corner × to dismiss, copy glyph on
 * the command). Dismissal is keyed by version so it returns on the next release.
 */
export function UpdateBanner() {
  const check = useVersionCheck();
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const latest = check && !check.upToDate ? check.latest : undefined;
  if (!latest || dismissed || dismissedVersion() === latest) return null;
  if (typeof window !== "undefined" && HIDDEN_PATHS.has(window.location.pathname)) return null;

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
    <div className="fixed right-4 bottom-20 z-30 w-[280px] max-w-[calc(100vw-2rem)] space-y-2 border border-ink/15 bg-paper-sunk px-4 py-3 shadow-xl md:bottom-4">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss update notice"
        className="absolute top-2.5 right-2.5 text-ink-faint transition-colors hover:text-ink-soft"
      >
        <X className="size-3.5" aria-hidden />
      </button>

      <div className="flex items-center gap-2 pr-6">
        <ArrowUp className="size-3.5 shrink-0 text-plot-red" aria-hidden />
        <a
          href={CHANGELOG_URL}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] tracking-[0.08em] text-ink underline-offset-2 uppercase hover:underline"
        >
          Update available
        </a>
      </div>

      <p className="text-[12px] leading-snug text-ink-soft">
        Update to <span className="font-mono text-ink">v{latest}</span>:
      </p>

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
    </div>
  );
}
