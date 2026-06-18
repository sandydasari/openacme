"use client";

import { useState } from "react";
import { CopyCommand } from "./CopyCommand";

const TABS = [
  { id: "curl", label: "curl", command: "curl -fsSL https://openacme.org/install.sh | sh" },
  { id: "npm", label: "npm", command: "npm install -g @openacme/cli && openacme setup" },
] as const;

/**
 * Install command with a curl/npm toggle — one command box at a time instead
 * of a stack. `dark` recolors the tab labels for the inverted start section;
 * CopyCommand carries its own surface so it reads on either background.
 */
export function InstallTabs({ dark = false }: { dark?: boolean }) {
  const [active, setActive] = useState(0);

  const idle = dark ? "text-paper/45 hover:text-paper/80" : "text-ink-faint hover:text-ink-soft";
  const on = dark ? "text-paper" : "text-ink";

  return (
    <div className="inline-flex max-w-full flex-col gap-2">
      <div className="flex items-center gap-4 font-mono text-[11px] tracking-[0.12em] uppercase">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActive(i)}
            aria-pressed={i === active}
            className={`border-b pb-1 transition-colors ${
              i === active ? `${on} border-plot-red` : `${idle} border-transparent`
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <CopyCommand command={TABS[active]!.command} />
    </div>
  );
}
