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
import { Mail } from "lucide-react";
import { GoogleIcon, MicrosoftIcon } from "@/app/components/BrandIcons";
import { API_BASE } from "../lib/api";

type Provider = "imap" | "gmail" | "microsoft";

function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  if (provider === "gmail") return <GoogleIcon className={className} />;
  if (provider === "microsoft") return <MicrosoftIcon className={className} />;
  return <Mail className={className} />;
}

interface EmailStatus {
  email: { provider: Provider; address: string } | null;
  redirectUri: string;
  imapDefaults: {
    host?: string;
    port?: number;
    smtpHost?: string;
    smtpPort?: number;
    tls?: boolean;
  } | null;
  oauthApps: { google: boolean; microsoft: boolean };
  status:
    | { bound: true; kind: "imap" | "oauth"; expiresAt: number | null; account: string | null }
    | { bound: false };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// All blank — omitted connection fields inherit the global config.email.imap
// default (or the provider's built-in 993/587) at resolution time.
const blankImap = {
  address: "",
  host: "",
  port: "",
  user: "",
  smtpHost: "",
  smtpPort: "",
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
  // When a global IMAP default exists, default to using it (form asks only for
  // address + password); unchecking reveals the per-agent connection override.
  const [useGlobalImap, setUseGlobalImap] = useState(true);

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
    const useWorkforce = !!data?.imapDefaults?.host && useGlobalImap;
    try {
      const res = await fetch(
        `${API_BASE}/api/agents/${encodeURIComponent(agentId)}/email/imap`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Send only filled fields — blanks inherit the global default. When
          // "use workforce server" is on, send no connection fields at all so
          // the agent fully inherits config.email.imap.
          body: JSON.stringify({
            address: imap.address,
            password: imap.password,
            ...(useWorkforce
              ? {}
              : {
                  ...(imap.host ? { host: imap.host } : {}),
                  ...(imap.user ? { user: imap.user } : {}),
                  ...(imap.smtpHost ? { smtpHost: imap.smtpHost } : {}),
                  ...(imap.port ? { port: Number(imap.port) } : {}),
                  ...(imap.smtpPort ? { smtpPort: Number(imap.smtpPort) } : {}),
                }),
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
  const dflt = data?.imapDefaults;
  const oauthConfigured =
    provider === "gmail"
      ? data?.oauthApps.google
      : provider === "microsoft"
        ? data?.oauthApps.microsoft
        : true;

  const set = (k: keyof typeof blankImap) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setImap((s) => ({ ...s, [k]: e.target.value }));

  const providerLabel =
    provider === "gmail" ? "Gmail" : provider === "microsoft" ? "Microsoft" : "IMAP";

  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between">
        <Label>Email</Label>
        {bound && <Badge variant="secondary">Connected</Badge>}
      </div>
      <p className="-mt-1 text-[13px] text-ink-soft">
        Give this agent its own mailbox — its own identity, isolated from other agents.
        Optional.
      </p>

      {/* Connected */}
      {bound && data?.status.bound && (
        <div className="flex items-center justify-between gap-3 border border-paper-rule bg-paper-sunk/40 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <ProviderIcon
              provider={data.email?.provider ?? ""}
              className="size-4 shrink-0"
            />
            <div className="min-w-0">
              <div className="truncate font-mono text-[12px] text-ink">
                {data.email?.address || data.status.account || "(bound)"}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                {data.email?.provider ?? data.status.kind}
                {data.status.kind === "oauth" && data.status.expiresAt
                  ? ` · token expires ${new Date(data.status.expiresAt * 1000).toLocaleDateString()}`
                  : ""}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!changing && (
              <Button variant="outline" size="sm" onClick={() => setChanging(true)} disabled={busy}>
                Change
              </Button>
            )}
            <Button variant="ghost-destructive" size="sm" onClick={disconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>
        </div>
      )}

      {/* Unbound, idle → compact opt-in (no big form until the user asks) */}
      {!bound && !changing && (
        <div className="flex items-center justify-between gap-3 border border-paper-rule bg-paper-sunk/40 px-3 py-2">
          <span className="text-[13px] text-ink-soft">No mailbox connected.</span>
          <Button size="sm" onClick={() => setChanging(true)}>
            Set up email
          </Button>
        </div>
      )}

      {/* Setup / re-bind form */}
      {changing && (
        <div className="grid gap-3">
          <div className="flex items-center justify-between">
            <Label htmlFor={`email-provider-${agentId}`}>Provider</Label>
            <button
              type="button"
              onClick={() => setChanging(false)}
              className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint transition-colors hover:text-plot-red"
            >
              Cancel
            </button>
          </div>
          <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
            <SelectTrigger id={`email-provider-${agentId}`} className="w-full md:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="imap">
                <span className="flex items-center gap-2">
                  <Mail className="size-4 text-ink-soft" /> IMAP / SMTP — any mailbox
                </span>
              </SelectItem>
              <SelectItem value="gmail">
                <span className="flex items-center gap-2">
                  <GoogleIcon className="size-4" /> Gmail
                </span>
              </SelectItem>
              <SelectItem value="microsoft">
                <span className="flex items-center gap-2">
                  <MicrosoftIcon className="size-4" /> Outlook / Microsoft 365
                </span>
              </SelectItem>
            </SelectContent>
          </Select>

          {provider === "imap" ? (
            <div className="grid gap-3 border border-paper-rule bg-paper-sunk/40 p-4">
              {dflt?.host && (
                <label className="flex items-center gap-2 text-[13px] text-ink-soft">
                  <input
                    type="checkbox"
                    checked={useGlobalImap}
                    onChange={(e) => setUseGlobalImap(e.target.checked)}
                    className="accent-plot-red"
                  />
                  Use the workforce mail server
                  <span className="font-mono text-[11px] text-ink-faint">
                    {dflt.host}
                    {dflt.port ? `:${dflt.port}` : ""}
                  </span>
                </label>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                <Pair label="Email address">
                  <Input value={imap.address} onChange={set("address")} placeholder="agent@example.com" />
                </Pair>
                {!(dflt?.host && useGlobalImap) && (
                  <>
                    <Pair label={dflt?.host ? "IMAP host (optional)" : "IMAP host"}>
                      <Input
                        value={imap.host}
                        onChange={set("host")}
                        placeholder={dflt?.host ? `inherits ${dflt.host}` : "imap.example.com"}
                      />
                    </Pair>
                    <Pair label="IMAP port">
                      <Input
                        value={imap.port}
                        onChange={set("port")}
                        placeholder={dflt?.port ? `inherits ${dflt.port}` : "993"}
                      />
                    </Pair>
                    <Pair label="Login user (optional)">
                      <Input value={imap.user} onChange={set("user")} placeholder="defaults to address" />
                    </Pair>
                    <Pair label="SMTP host (optional)">
                      <Input
                        value={imap.smtpHost}
                        onChange={set("smtpHost")}
                        placeholder={dflt?.smtpHost ? `inherits ${dflt.smtpHost}` : "defaults to IMAP host"}
                      />
                    </Pair>
                    <Pair label="SMTP port">
                      <Input
                        value={imap.smtpPort}
                        onChange={set("smtpPort")}
                        placeholder={dflt?.smtpPort ? `inherits ${dflt.smtpPort}` : "587"}
                      />
                    </Pair>
                  </>
                )}
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
                  disabled={busy || !imap.address || !imap.password || (!imap.host && !dflt?.host)}
                >
                  {bound ? "Re-bind" : "Connect"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 border border-paper-rule bg-paper-sunk/40 p-4">
              {!oauthConfigured ? (
                <p className="text-[13px] text-ink-soft">
                  No {providerLabel} OAuth app is set up yet.{" "}
                  <a
                    href="/settings?tab=email"
                    className="text-plot-red underline-offset-2 hover:underline"
                  >
                    Add it in Settings → Email
                  </a>
                  , then come back.
                </p>
              ) : (
                <>
                  <p className="text-[13px] text-ink-soft">
                    Register this redirect URI in your {providerLabel} OAuth app
                    (also in Settings → Email):
                  </p>
                  <code className="block break-all border border-paper-rule bg-paper px-2 py-1 font-mono text-[12px] text-ink">
                    {data?.redirectUri ?? "…"}
                  </code>
                  <div className="flex justify-end">
                    <Button
                      onClick={() => connectOAuth(provider as "gmail" | "microsoft")}
                      disabled={busy}
                    >
                      Connect {providerLabel}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
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
