import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/app/lib/utils";
import {
  activeMentionQuery,
  highlightSegments,
  type SkillIndexEntry,
} from "@/app/lib/skill-mentions";

// Shared font/box classes — applied identically to the textarea and the
// highlight backdrop so glyphs line up exactly. Mirrors the textarea the
// composer used before (base ui Textarea padding `px-3 py-2` + the composer's
// own overrides). Keep the two in lockstep or the pills drift off the text.
const SHARED =
  "px-3 py-2 font-sans text-base md:text-sm leading-[1.5] whitespace-pre-wrap break-words";

function scoreSkill(query: string, s: SkillIndexEntry): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const n = s.name.toLowerCase();
  const ni = n.indexOf(q);
  if (ni === 0) return 1000 - n.length;
  if (ni > 0) return 500 - ni;
  const di = s.description.toLowerCase().indexOf(q);
  return di === -1 ? 0 : 100 - di;
}

/** Chat textarea with `/skill` inline highlighting + an autocomplete picker.
 *  Drop-in for the plain textarea: same value/onChange/onKeyDown contract, plus
 *  `skills`. When the picker is open it owns Arrow/Enter/Tab/Escape; otherwise
 *  it delegates to the parent `onKeyDown` (Enter→send stays intact). */
export function SkillTextarea({
  value,
  onChange,
  onKeyDown,
  skills,
  placeholder,
  disabled,
  textareaRef,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  skills: SkillIndexEntry[];
  placeholder: string;
  disabled?: boolean;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  className?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ start: number; query: string } | null>(
    null
  );
  const [active, setActive] = useState(0);

  const names = useMemo(() => new Set(skills.map((s) => s.name)), [skills]);
  const segments = useMemo(
    () => highlightSegments(value, names),
    [value, names]
  );

  const filtered = useMemo(() => {
    if (!menu) return [];
    return skills
      .map((s) => ({ s, score: scoreSkill(menu.query, s) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.s);
  }, [skills, menu]);

  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      taRef.current = node;
      if (typeof textareaRef === "function") textareaRef(node);
      else if (textareaRef)
        (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current =
          node;
    },
    [textareaRef]
  );

  // Recompute the active `/query` from the live caret position.
  const syncMenu = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const next = activeMentionQuery(el.value, el.selectionStart ?? 0);
    setMenu(next);
    setActive(0);
  }, []);

  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered.length, active]);

  const selectSkill = useCallback(
    (skill: SkillIndexEntry) => {
      const el = taRef.current;
      if (!el || !menu) return;
      const caret = el.selectionStart ?? value.length;
      const before = value.slice(0, menu.start);
      const after = value.slice(caret);
      const insert = `/${skill.name} `;
      const nextValue = before + insert + after;
      onChange(nextValue);
      setMenu(null);
      // Restore the caret right after the inserted token on the next frame.
      const pos = before.length + insert.length;
      requestAnimationFrame(() => {
        const node = taRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(pos, pos);
      });
    },
    [menu, value, onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) {
      onKeyDown?.(e);
      return;
    }
    if (menu && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = filtered[active];
        if (pick) selectSkill(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative flex-1 min-w-0">
      <div
        ref={backdropRef}
        aria-hidden
        className={cn(
          SHARED,
          "pointer-events-none absolute inset-0 max-h-48 overflow-hidden text-ink",
          className
        )}
      >
        {segments.map((seg, i) =>
          seg.isSkill ? (
            <span
              key={i}
              className="rounded-[3px] bg-plot-red/10 px-[1px] text-plot-red"
            >
              {seg.text}
            </span>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
        {/* Preserve height of a trailing blank line. */}
        {"​"}
      </div>
      <textarea
        ref={setRefs}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          syncMenu();
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={syncMenu}
        onClick={syncMenu}
        onScroll={(e) => {
          if (backdropRef.current)
            backdropRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onBlur={() => setMenu(null)}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck
        enterKeyHint="send"
        className={cn(
          SHARED,
          "relative min-h-[44px] max-h-48 w-full resize-none border-0 bg-transparent text-transparent caret-ink shadow-none outline-none placeholder:text-ink-faint focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
      />
      {menu && filtered.length > 0 && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-50 mb-1 max-h-64 w-full max-w-md overflow-y-auto border border-paper-rule bg-paper-sunk py-1 shadow-md"
        >
          <div className="px-3 pb-1 pt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Skills
          </div>
          {filtered.map((s, idx) => {
            const isActive = idx === active;
            return (
              <button
                key={s.name}
                type="button"
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setActive(idx)}
                onMouseDown={(e) => {
                  // Keep focus in the textarea (blur would close the menu first).
                  e.preventDefault();
                  selectSkill(s);
                }}
                className={cn(
                  "relative flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors",
                  isActive
                    ? "bg-paper text-ink"
                    : "text-ink-soft hover:bg-paper hover:text-ink"
                )}
              >
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[2px] bg-plot-red"
                  />
                )}
                <span className="font-mono text-[13px] text-plot-red">
                  /{s.name}
                </span>
                {s.description && (
                  <span className="truncate text-[11px] text-ink-faint">
                    {s.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
