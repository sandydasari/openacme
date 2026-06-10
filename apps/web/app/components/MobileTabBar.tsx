"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Bot, BookOpen, ListChecks, Settings, Users } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { navigateClient } from "@/app/lib/navigate";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/teams", label: "Teams", icon: Users },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/skills", label: "Skills", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

/**
 * Mobile bottom tab bar. Replaces the hamburger drawer pattern with a
 * fixed bar of icon+label entries at the bottom of the viewport — the
 * convention for native iOS/Android apps with 3-5 top-level sections.
 * Hidden on md+ where the persistent left sidebar takes over.
 *
 * Position: fixed bottom-0 so it sits above content regardless of scroll
 * position. Safe-area-inset-bottom padding for iPhone home-indicator
 * clearance. Page content needs `pb-mobile-tabbar` to keep its tail
 * scrollable above the bar — handled in app/layout.tsx wrapper.
 */
export function MobileTabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-paper-rule bg-paper-sunk pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-5">
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          const Icon = item.icon;
          // Same-route intercept as the desktop sidebar: when we're
          // already on `/` and the user taps Home, Next's <Link> no-ops
          // the route change so we have to push the navigation manually
          // (clears `?session=...`, returns to Home view).
          const interceptHome = item.href === "/" && pathname === "/";
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={
                  interceptHome
                    ? (e) => {
                        e.preventDefault();
                        navigateClient("/");
                      }
                    : undefined
                }
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] uppercase tracking-[0.08em] transition-colors",
                  isActive
                    ? "text-plot-red"
                    : "text-ink-soft hover:text-ink"
                )}
              >
                <Icon className="size-5" aria-hidden />
                <span className="font-mono">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
