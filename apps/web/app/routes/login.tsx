import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { ScribedRule } from "@/app/components/ui/scribed-rule";
import { Logotype } from "@/app/components/Logotype";
import { setStoredAuthToken } from "@/app/components/auth-fetch";
import { API_BASE } from "../lib/api";

const HEADLINE = "OPENACME · SIGN IN";

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ next: z.coerce.string().optional() }),
  component: LoginPage,
});

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [next, setNext] = useState("/");
  // Hide the form until we've checked status: an already-valid session
  // skips straight in, and a fresh install bounces to /setup.
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const n = params.get("next");
    if (n) setNext(n);

    fetch(`${API_BASE}/api/auth/status`, { credentials: "include" })
      .then((r) => r.json())
      .then(
        (data: {
          needsSetup?: boolean;
          member?: unknown;
          authRequired?: boolean;
        }) => {
          if (data?.member) {
            window.location.href = n || "/";
            return;
          }
          // Local-trusted: no login needed — bounce home; loading the app
          // shell trips the gate, which mints the auto-session.
          if (data?.authRequired === false) {
            window.location.href = n || "/";
            return;
          }
          if (data?.needsSetup) {
            window.location.href = "/setup";
            return;
          }
          setChecking(false);
        }
      )
      .catch(() => setChecking(false));
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        let message = "Login failed";
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // keep default
        }
        toast.error(message);
        setSubmitting(false);
        return;
      }
      // Store the session token as a bearer fallback — iOS standalone PWAs
      // evict cookies between launches; localStorage survives.
      const body = (await res.json()) as { token?: string };
      if (body.token) setStoredAuthToken(body.token);
      window.location.href = next || "/";
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <main className="relative flex min-h-screen items-center justify-center bg-paper px-4">
        <div className="flex flex-col items-center gap-3">
          <Logotype className="h-7 w-auto text-ink" />
          <LoadingHairline aria-label="Resuming session" />
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="section-enter w-full max-w-sm border border-paper-rule bg-paper">
        <ScribedRule className="bg-ink" />

        <div className="px-5 pt-4 pb-3">
          <Logotype className="h-7 w-auto text-ink" />
          <h1 className="scribe-in mt-3 font-mono text-[11px] uppercase tracking-[0.08em] text-ink">
            {HEADLINE}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            Sign in with your email and password.
          </p>
        </div>

        <ScribedRule delay={300} />

        <form onSubmit={onSubmit} className="space-y-4 px-5 py-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !email.trim() || !password}
          >
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                <LoadingHairline inline aria-label="Verifying" />
                Verifying
              </span>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>
      </div>
    </main>
  );
}
