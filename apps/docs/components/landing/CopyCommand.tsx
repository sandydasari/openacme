"use client";

import { useState } from "react";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className="group inline-flex max-w-full items-center gap-3 border border-paper-rule bg-code-surface px-4 py-3 text-left font-mono text-[13px] text-ink transition-colors hover:border-ink-faint focus-scribe"
      aria-label={`Copy command: ${command}`}
    >
      <span className="text-ink-faint">$</span>
      <span className="truncate">{command}</span>
      <span
        className={`ml-2 shrink-0 text-[10px] tracking-[0.12em] uppercase ${
          copied ? "text-signal-green" : "text-ink-faint group-hover:text-ink-soft"
        }`}
      >
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}
