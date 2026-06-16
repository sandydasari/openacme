import { useEffect, useState, type ReactNode } from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Toaster } from "@/app/components/ui/sonner";
import { TooltipProvider } from "@/app/components/ui/tooltip";
import { AuthFetch } from "@/app/components/auth-fetch";
import { HelpOverlay } from "@/app/components/HelpOverlay";
import { CommandPalette } from "@/app/components/CommandPalette";
import { RegisterServiceWorker } from "@/app/components/RegisterServiceWorker";
import { MobileTabBar } from "@/app/components/MobileTabBar";
import { AcmePanel } from "@/app/components/AcmePanel";
import { CurrentViewProvider } from "@/app/lib/CurrentViewContext";
import { AcmePanelProvider } from "@/app/lib/AcmePanelContext";
import { API_BASE } from "@/app/lib/api";

export const Route = createRootRoute({ component: RootLayout });

// Pages that render their own auth UI and must not be gated.
const PUBLIC_PATHS = new Set(["/login", "/setup", "/enroll"]);

/**
 * Resolve auth BEFORE mounting protected routes, so an unauthenticated load
 * redirects to /login (or /setup on a fresh install) without the app first
 * rendering — and flashing — its "can't reach the server" error state.
 * `/api/auth/status` never 401s (it returns `member: null`), so this check
 * is independent of the AuthFetch 401 handler, which stays as the safety net
 * for sessions that expire mid-use.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"checking" | "ready">(() =>
    PUBLIC_PATHS.has(window.location.pathname) ? "ready" : "checking"
  );

  useEffect(() => {
    if (phase !== "checking") return;
    let cancelled = false;
    fetch(`${API_BASE}/api/auth/status`, { credentials: "include" })
      .then((r) => r.json())
      .then(
        (d: {
          member?: unknown;
          needsSetup?: boolean;
          authRequired?: boolean;
        }) => {
          if (cancelled) return;
          if (d?.member) {
            setPhase("ready");
            return;
          }
          // Local-trusted: no login required — just mount. Any gated request
          // auto-sessions on a loopback Host, so the app works without a form.
          if (d?.authRequired === false) {
            setPhase("ready");
            return;
          }
          if (d?.needsSetup) {
            window.location.href = "/setup";
            return;
          }
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = `/login?next=${next}`;
        }
      )
      .catch(() => {
        // Network blip — let the app mount; AuthFetch handles a real 401.
        if (!cancelled) setPhase("ready");
      });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  if (phase === "checking") {
    return <main className="min-h-screen bg-paper" />;
  }
  return <>{children}</>;
}

function RootLayout() {
  return (
    <TooltipProvider delayDuration={200}>
      <AuthFetch />
      <RegisterServiceWorker />
      <AcmePanelProvider>
        <CurrentViewProvider>
          <Shell />
        </CurrentViewProvider>
      </AcmePanelProvider>
    </TooltipProvider>
  );
}

/** App shell. The ambient Acme panel floats over the page (no app-shift) so
 *  opening it doesn't reflow everything — calmer, changes less on screen. */
function Shell() {
  return (
    <>
      <AuthGate>
        <Outlet />
      </AuthGate>
      <HelpOverlay />
      <CommandPalette />
      <AcmePanel />
      <Toaster />
      <MobileTabBar />
    </>
  );
}
