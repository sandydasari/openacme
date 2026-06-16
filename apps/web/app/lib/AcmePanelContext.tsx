import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** Ambient Acme panel open-state. Shared so the panel renders AND the app
 *  layout can shift left to keep the page visible while it's docked. */
const Ctx = createContext<{
  open: boolean;
  setOpen: (v: boolean) => void;
} | null>(null);

export function AcmePanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  // ⌘/Ctrl+Shift+K toggles; a dispatched event (sidebar "Ask Acme") opens.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    // Sidebar "Ask Acme" toggles too (press again to close), matching the hotkey.
    const onToggle = () => setOpen((o) => !o);
    document.addEventListener("keydown", onKey);
    window.addEventListener("openacme:open-acme", onToggle);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("openacme:open-acme", onToggle);
    };
  }, []);

  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAcmePanel(): { open: boolean; setOpen: (v: boolean) => void } {
  return useContext(Ctx) ?? { open: false, setOpen: () => {} };
}
