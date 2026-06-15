import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Badge } from "@/app/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { API_BASE } from "../lib/api";

type Provider = "imap" | "gmail" | "microsoft";

interface EmailStatus {
  email: { provider: Provider; address: string } | null;
  redirectUri: string;
  oauthApps: { google: boolean; microsoft: boolean };
  status:
    | { bound: true; kind: "imap" | "oauth"; expiresAt: number | null; account: string | null }
    | { bound: false };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const blankImap = {
  address: "",
  host: "",
  port: "993",
  user: "",
  smtpHost: "",
  smtpPort: "587",
  password: "",
};

export function AgentEmailPanel({ agentId }: { agentId: string }) {
  const [data, setData] = useState<EmailStatus | null>(null);
  const [provider, setProvider] = useState<Provider>("imap");
  const [imap, setImap] = useState({ ...blankImap });
  const [busy, setBusy] = useState(false);
  // When bound, the connect/re-bind form is collapsed behind "Change". When
  // unbound, the form is shown directly (it's the connect flow).
  const [changing, setChanging] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `${API_BASE}/api/agents/${encodeURIComponent(agentId)}/email`
      );
      if (!res.ok) return;
      const d = (await res.json()) as EmailStatus;
      setData(d);
      if (d.email?.provider) setProvider(d.email.provider);
    } catch {
      /* leave panel in loading state */
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = async () => {
    setBusy(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/agents/${encodeURIComponent(agentId)}/email`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText);
      }
      toast.success("Email disconnected");
      setChanging(false);
      await load();
    } catch (e) {
      toast.error("Disconnect failed", { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const connectImap = async () => {
    setBusy(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/agents/${encodeURIComponent(agentId)}/email/imap`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...imap,
            port: Number(imap.port) || 993,
            smtpPort: Number(imap.smtpPort) || 587,
          }),
        }
      );
      if (!res.ok) {
        throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || res.statusText);
      }
      toast.success("IMAP mailbox connected");
      setImap((s) => ({ ...s, password: "" }));
      setChanging(false);
      await load();
    } catch (e) {
      toast.error("Connect failed", { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const connectOAuth = async (p: "gmail" | "microsoft") => {
    setBusy(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/agents/${encodeURIComponent(agentId)}/email/oauth/${p}/start`,
        { method: "POST" }
      );
      const d = (await res.json().catch(() => ({}))) as { authUrl?: string; error?: string };
      if (!res.ok || !d.authUrl) throw new Error(d.error || res.statusText);
      window.open(d.authUrl, "openacme-email-oauth", "width=520,height=700");
      toast.message("Complete sign-in in the popup window");
      const onMsg = (ev: MessageEvent) => {
        const m = ev.data as { type?: string; ok?: boolean } | null;
        if (m?.type === "openacme-email-oauth") {
          window.removeEventListener("message", onMsg);
          if (m.ok) setChanging(false);
          void load().then(() =>
            m.ok ? toast.success("Email connected") : toast.error("Sign-in failed")
          );
        }
      };
      window.addEventListener("message", onMsg);
      // Fallback for popups that close without posting (e.g. blocked opener).
      window.addEventListener("focus", () => void load(), { once: true });
    } catch (e) {
      toast.error("Could not start sign-in", { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const bound = data?.status.bound === true;
  const oauthConfigured =
    provider === "gmail"
      ? data?.oauthApps.google
      : provider === "microsoft"
        ? data?.oauthApps.microsoft
        : true;

  const set = (k: keyof typeof blankImap) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setImap((s) => ({ ...s, [k]: e.target.value }));

  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between">
        <Label>
          Email mailbox
          <span className="ml-2 font-normal text-ink-faint">a dedicated address for this agent</span>
        </Label>
        {bound && (
          <Badge variant="secondary">Connected</Badge>
        )}
      </div>

      {bound && data?.status.bound && (
        <div className="flex items-center justify-between gap-3 border border-paper-rule bg-paper-sunk/40 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate font-mono text-[12px] text-ink">
              {data.email?.address || data.status.account || "(bound)"}
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              {data.email?.provider ?? data.status.kind}
              {data.status.kind === "oauth" && data.status.expiresAt
                ? ` · token exp ${new Date(data.status.expiresAt * 1000).toLocaleString()}`
                : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!changing && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setChanging(true)}
                disabled={busy}
              >
                Change
              </Button>
            )}
            <Button variant="ghost-destructive" size="sm" onClick={disconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>
        </div>
      )}

      {(!bound || changing) && (
        <>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor={`email-provider-${agentId}`}>
                {bound ? "Re-bind / change provider" : "Connect a mailbox"}
              </Label>
              {bound && changing && (
                <button
                  type="button"
                  onClick={() => setChanging(false)}
                  className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint transition-colors hover:text-plot-red"
                >
                  Cancel
                </button>
              )}
            </div>
            <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
          <SelectTrigger id={`email-provider-${agentId}`} className="w-full md:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="imap">IMAP / SMTP — any mailbox</SelectItem>
            <SelectItem value="gmail">Gmail</SelectItem>
            <SelectItem value="microsoft">Outlook / Microsoft 365</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {provider === "imap" ? (
        <div className="grid gap-3 border border-paper-rule bg-paper-sunk/40 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Pair label="Email address">
              <Input value={imap.address} onChange={set("address")} placeholder="agent@example.com" />
            </Pair>
            <Pair label="IMAP host">
              <Input value={imap.host} onChange={set("host")} placeholder="imap.example.com" />
            </Pair>
            <Pair label="IMAP port">
              <Input value={imap.port} onChange={set("port")} placeholder="993" />
            </Pair>
            <Pair label="Login user (optional)">
              <Input value={imap.user} onChange={set("user")} placeholder="defaults to address" />
            </Pair>
            <Pair label="SMTP host (optional)">
              <Input value={imap.smtpHost} onChange={set("smtpHost")} placeholder="defaults to IMAP host" />
            </Pair>
            <Pair label="SMTP port">
              <Input value={imap.smtpPort} onChange={set("smtpPort")} placeholder="587" />
            </Pair>
          </div>
          <Pair label="App password">
            <Input
              type="password"
              value={imap.password}
              onChange={set("password")}
              placeholder="app-specific password"
            />
          </Pair>
          <div className="flex justify-end">
            <Button
              onClick={connectImap}
              disabled={busy || !imap.address || !imap.host || !imap.password}
            >
              {bound ? "Re-bind IMAP" : "Connect IMAP"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 border border-paper-rule bg-paper-sunk/40 p-4">
          {!oauthConfigured ? (
            <p className="text-sm text-ink-soft">
              Add{" "}
              <code className="font-mono text-[12px] text-ink">
                config.email.{provider === "gmail" ? "google" : "microsoft"}
              </code>{" "}
              {"{ clientId, clientSecret }"} (your own OAuth app) to config.yaml, then reload this
              page.
            </p>
          ) : (
            <>
              <p className="text-sm text-ink-soft">
                Register this redirect URI in your{" "}
                {provider === "gmail" ? "Google" : "Microsoft"} OAuth app:
              </p>
              <code className="block break-all border border-paper-rule bg-paper px-2 py-1 font-mono text-[12px] text-ink">
                {data?.redirectUri ?? "…"}
              </code>
              <div className="flex justify-end">
                <Button
                  onClick={() => connectOAuth(provider as "gmail" | "microsoft")}
                  disabled={busy}
                >
                  Connect {provider === "gmail" ? "Gmail" : "Microsoft"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
        </>
      )}
    </section>
  );
}

function Pair({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
