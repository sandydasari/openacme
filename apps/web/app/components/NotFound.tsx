import { Link } from "@tanstack/react-router";
import { Button } from "@/app/components/ui/button";
import { ScribedRule } from "@/app/components/ui/scribed-rule";
import { Logotype } from "@/app/components/Logotype";

export function NotFound() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-8 bg-paper px-4 text-center">
      <Logotype className="h-6 w-auto text-ink-soft" />

      <div className="flex flex-col items-center gap-3">
        <span className="font-mono text-[clamp(6rem,26vw,13rem)] font-bold leading-[0.85] tracking-tighter text-ink">
          404
        </span>
        <ScribedRule className="w-40 bg-ink" />
        <h1 className="mt-2 font-mono text-[13px] uppercase tracking-[0.14em] text-ink">
          Page not found
        </h1>
      </div>

      <p className="max-w-sm text-sm leading-relaxed text-ink-soft">
        We couldn&apos;t find that page. The link may be broken, or whatever it
        pointed to has been removed.
      </p>

      <Button asChild size="lg">
        <Link to="/">Back to console</Link>
      </Button>
    </main>
  );
}
