import { useEffect, useLayoutEffect, useState } from "react";
import { Link, linkOptions, useLocation } from "@tanstack/react-router";
import {
  Home,
  Bot,
  BookOpen,
  Command,
  Compass,
  Gauge,
  ListChecks,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
  BookText,
  ArrowUpRight,
} from "lucide-react";
import { DOCS_URL } from "@/app/lib/links";
import { cn } from "@/app/lib/utils";
import { API_BASE } from "@/app/lib/api";
import { Logotype } from "@/app/components/Logotype";
import { Logomark } from "@/app/components/Logomark";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { UpdateBanner } from "@/app/components/UpdateBanner";
import { ActiveMarker } from "@/app/components/ui/active-marker";
import { useAcmePanel } from "@/app/lib/AcmePanelContext";

// no width transition: the lab-instrument register prefers an instant snap
// over animating a layout property (DESIGN.md §6 "Don't animate layout").

// Order matters — Home first (default landing for the workforce
// operator), then composition pages (Agents, Tasks, Skills), then
// global config (Settings).
const navItems = [
  { link: linkOptions({ to: "/" }), label: "Home", icon: Home },
  { link: linkOptions({ to: "/agents" }), label: "Agents", icon: Bot },
  { link: linkOptions({ to: "/teams" }), label: "Teams", icon: Users },
  { link: linkOptions({ to: "/tasks" }), label: "Tasks", icon: ListChecks },
  { link: linkOptions({ to: "/skills" }), label: "Skills", icon: BookOpen },
  { link: linkOptions({ to: "/usage" }), label: "Usage", icon: Gauge },
  { link: linkOptions({ to: "/settings" }), label: "Settings", icon: Settings },
];

const COLLAPSED_KEY = "openacme-sidebar-collapsed";

// Use a layout effect on the client; on the server, fall back to
// useEffect so SSR/static prerender doesn't throw. The layout effect
// runs synchronously after render, before the browser paints — that
// lets us flip to the persisted value with no visible animate-in,
// while the initial render still matches the server's HTML (avoiding
// hydration mismatch warnings).
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function Sidebar({ children }: { children?: React.ReactNode }) {
  const pathname = useLocation({ select: (l) => l.pathname });
  const { open: acmeOpen, setOpen: setAcmeOpen } = useAcmePanel();
  const [version, setVersion] = useState<string | null>(null);
  // SSR + first client render both emit `collapsed=true` (same HTML, no
  // hydration warning). The layoutEffect flips it to the persisted value
  // before paint.
  const [collapsed, setCollapsed] = useState<boolean>(true);
  useIsomorphicLayoutEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLLAPSED_KEY);
      if (stored === "false") setCollapsed(false);
    } catch {
      // localStorage blocked — keep collapsed default.
    }
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, String(next));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data && typeof data.version === "string") setVersion(data.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside
      className={cn(
        // Mobile uses a fixed bottom tab bar (see MobileTabBar); this rail
        // hides under md. Desktop keeps the persistent left rail with the
        // collapse toggle.
        "hidden shrink-0 flex-col border-r border-paper-rule bg-sidebar text-sidebar-foreground md:flex",
        collapsed ? "md:w-14" : "md:w-60"
      )}
    >
        <div
          className={cn(
            "flex items-center border-b border-paper-rule py-5",
            // Drawer mode (mobile or expanded desktop) keeps the expanded
            // layout; only the desktop-collapsed rail centers its single button.
            collapsed
              ? "justify-between px-4 md:justify-center md:px-3"
              : "justify-between px-4"
          )}
        >
          {collapsed ? (
            <button
              onClick={toggle}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              className="group/logo relative flex size-7 items-center justify-center text-ink transition-colors hover:text-plot-red focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-plot-red"
            >
              <Logomark className="size-5 group-hover/logo:hidden" />
              <PanelLeftOpen className="hidden size-4 group-hover/logo:block" />
            </button>
          ) : (
            <>
              <Logotype className="h-6 w-auto text-ink" />
              <button
                onClick={toggle}
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
                className="-mr-1 flex size-6 items-center justify-center text-ink-soft hover:bg-paper hover:text-ink focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-plot-red"
              >
                <PanelLeftClose className="size-4" />
              </button>
            </>
          )}
        </div>

        <nav className="flex flex-col">
          {/* Drawer mode renders nav labels even when desktop sidebar is
              collapsed — the drawer is full-width. The "Console" header
              hides only when the desktop rail is in icon-only mode. */}
          <div
            className={cn(
              "px-4 pt-4 pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint",
              collapsed ? "md:hidden" : ""
            )}
          >
            Console
          </div>
          {navItems.map((item) => {
            const isActive =
              item.link.to === "/"
                ? pathname === "/"
                : pathname.startsWith(item.link.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.link.to}
                {...item.link}
                aria-current={isActive ? "page" : undefined}
                title={collapsed ? item.label : undefined}
                className={cn(
                  "group relative flex items-center gap-3 text-sm transition-colors",
                  // Mobile drawer + expanded desktop = labeled rows. Desktop
                  // collapsed rail = centered icons only.
                  "px-4 py-3 md:py-2",
                  collapsed && "md:justify-center md:px-0 md:py-2.5",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <ActiveMarker active={isActive} />
                <Icon className="size-4 shrink-0" />
                <span
                  className={cn(
                    "font-medium",
                    collapsed ? "md:hidden" : ""
                  )}
                >
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>

        <div
          className={cn(
            "flex-1 overflow-y-auto",
            collapsed ? "hidden md:block" : ""
          )}
        >
          {children}
        </div>

        {/* Ask Acme — labeled nav-style row that opens the ambient panel
            (the platform helper, summonable from anywhere). */}
        <button
          type="button"
          onClick={() => setAcmeOpen(!acmeOpen)}
          title="Ask Acme — the platform helper (⌘⇧K)"
          aria-label="Ask Acme"
          aria-expanded={acmeOpen}
          aria-keyshortcuts="Meta+Shift+K Control+Shift+K"
          className={cn(
            "group relative flex w-full items-center gap-3 border-t border-paper-rule text-sm font-medium transition-colors",
            "px-4 py-3 md:py-2.5",
            collapsed && "md:justify-center md:px-0",
            // Accent it: this isn't a page, it's the platform helper. plot-red
            // icon + tinted hover, and a held plot-red state while the panel
            // is open so you can tell it's active.
            acmeOpen
              ? "bg-plot-red/10 text-plot-red"
              : "text-ink hover:bg-plot-red/10 hover:text-plot-red"
          )}
        >
          <ActiveMarker active={acmeOpen} />
          <Compass className="size-4 shrink-0 text-plot-red" />
          <span className={cn(collapsed ? "md:hidden" : "")}>Ask Acme</span>
          <span
            className={cn(
              "font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint",
              collapsed ? "md:hidden" : "ml-auto"
            )}
            aria-hidden
          >
            ⌘⇧K
          </span>
        </button>

        {/* Documentation — a labeled nav-style row directly above the bottom
            bar (external link, opens the docs site). */}
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          title={collapsed ? "Documentation" : undefined}
          className={cn(
            "group relative flex items-center gap-3 border-t border-paper-rule text-sm transition-colors",
            "px-4 py-3 md:py-2",
            collapsed && "md:justify-center md:px-0 md:py-2.5",
            "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          )}
        >
          <BookText className="size-4 shrink-0" />
          <span className={cn("font-medium", collapsed ? "md:hidden" : "")}>
            Documentation
          </span>
          <ArrowUpRight
            className={cn(
              "size-3.5 shrink-0 text-ink-faint transition-colors group-hover:text-ink",
              collapsed ? "md:hidden" : "ml-auto"
            )}
            aria-hidden
          />
        </a>

        <UpdateBanner collapsed={collapsed} />

        <div
          className={cn(
            "flex items-center border-t border-paper-rule",
            // Desktop-collapsed = stacked column; everything else = row.
            collapsed
              ? "justify-between gap-2 px-4 py-3 md:flex-col md:justify-center md:gap-1 md:px-2"
              : "justify-between gap-2 px-4 py-3"
          )}
        >
          <div
            className={cn(
              "font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint",
              collapsed ? "md:hidden" : ""
            )}
          >
            {version ? `v${version}` : "v—"}
          </div>
          <div
            className={cn(
              "flex items-center gap-1",
              collapsed ? "md:flex-col" : ""
            )}
          >
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("openacme:open-palette"))
              }
              title="Open command palette (⌘K)"
              aria-label="Open command palette"
              aria-keyshortcuts="Meta+K Control+K"
              className={cn(
                "flex items-center gap-1.5 text-ink-soft transition-colors hover:text-ink focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-plot-red",
                collapsed ? "px-1 md:size-6 md:justify-center md:px-0" : "px-1"
              )}
            >
              <Command className="size-3.5 shrink-0" aria-hidden />
              <span
                className={cn(
                  "font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint",
                  collapsed ? "md:hidden" : ""
                )}
              >
                K
              </span>
            </button>
            <ThemeToggle compact />
          </div>
        </div>
      </aside>
  );
}
