import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { EnrollForm } from "@/app/components/EnrollForm";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { Logotype } from "@/app/components/Logotype";
import { API_BASE } from "../lib/api";

export const Route = createFileRoute("/setup")({
  validateSearch: z.object({ token: z.coerce.string().optional() }),
  component: SetupPage,
});

function SetupPage() {
  const { token } = Route.useSearch();
  // /setup is first-run only. If the instance is already claimed, a stranger
  // shouldn't see a "create the operator account" form — bounce them to the
  // right place. Invites use /enroll, which stays open post-claim.
  const [phase, setPhase] = useState<"checking" | "claim">("checking");

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/status`, { credentials: "include" })
      .then((r) => r.json())
      .then(
        (d: {
          needsSetup?: boolean;
          member?: unknown;
          authRequired?: boolean;
        }) => {
          if (d?.needsSetup) {
            setPhase("claim");
            return;
          }
          // Local-trusted: nothing to claim — bounce home; the gate
          // auto-sessions the user.
          if (d?.authRequired === false) {
            window.location.href = "/";
            return;
          }
          // Already claimed — signed-in users go home, everyone else to login.
          window.location.href = d?.member ? "/" : "/login";
        }
      )
      .catch(() => setPhase("claim"));
  }, []);

  if (phase === "checking") {
    return (
      <main className="relative flex min-h-screen items-center justify-center bg-paper px-4">
        <div className="flex flex-col items-center gap-3">
          <Logotype className="h-7 w-auto text-ink" />
          <LoadingHairline aria-label="Loading" />
        </div>
      </main>
    );
  }

  return (
    <EnrollForm
      headline="OPENACME · CLAIM INSTANCE"
      blurb="First run — create the operator account, then choose an email and password."
      initialToken={token ?? ""}
      tokenHelp="Run `openacme claim` on the server (or check `openacme logs`) to print a setup link with this token filled in."
    />
  );
}
