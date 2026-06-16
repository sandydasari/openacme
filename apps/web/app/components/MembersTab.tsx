import { useEffect, useState } from "react";
import { toast } from "sonner";
import { UserPlus, Trash2, LogOut, Copy, User } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { API_BASE } from "@/app/lib/api";
import { docsUrl } from "@/app/lib/links";
import { clearStoredAuthToken } from "./auth-fetch";

interface Member {
  id: string;
  email: string;
  createdAt: number;
}

interface AuthStatus {
  authRequired?: boolean;
  member?: { id: string; email: string } | null;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function MembersTab() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/status`, { credentials: "include" })
      .then((r) => r.json())
      .then((d: AuthStatus) => setStatus(d))
      .catch(() => setStatus({ authRequired: false }));
  }, []);

  const loadMembers = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/members`, {
        credentials: "include",
      });
      const body = (await res.json()) as { members: Member[] };
      setMembers(body.members);
    } catch (err) {
      toast.error("Failed to load members", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  useEffect(() => {
    if (status?.authRequired) void loadMembers();
  }, [status?.authRequired]);

  if (status === null) {
    return (
      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
        Loading…
      </div>
    );
  }

  // Local-trusted mode: no human accounts exist — the daemon auto-sessions
  // anyone on this machine. Member management only applies once exposed.
  if (!status.authRequired) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invite your team</CardTitle>
          <CardDescription>Share this workforce with coworkers.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-soft">
            This instance is <span className="text-ink">local</span> — anyone
            on this machine is signed in automatically, so there&apos;s nothing
            to manage yet. Expose it to require login and add people:
          </p>
          <pre className="border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink">
            openacme expose
          </pre>
          <p className="text-sm text-ink-soft">
            You&apos;ll create the first operator account, then invite others
            right here.
          </p>
          <a
            href={docsUrl("/remote-access")}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-sm text-plot-red underline-offset-2 hover:underline"
          >
            Sharing &amp; remote access →
          </a>
        </CardContent>
      </Card>
    );
  }

  async function signOut() {
    setWorking(true);
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // proceed regardless — clearing the local token logs us out client-side
    }
    clearStoredAuthToken();
    window.location.href = "/login";
  }

  async function createInvite() {
    setWorking(true);
    try {
      const res = await fetch(`${API_BASE}/api/members/invite`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { url: string };
      setInviteUrl(body.url);
    } catch (err) {
      toast.error("Failed to create invite", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setWorking(false);
    }
  }

  async function revoke(m: Member) {
    try {
      const res = await fetch(`${API_BASE}/api/members/${m.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Removed ${m.email}`);
      await loadMembers();
    } catch (err) {
      toast.error("Failed to remove member", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const currentId = status.member?.id;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>
            The operator account you&apos;re signed in with on this device.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <User className="size-4 shrink-0 text-ink-soft" aria-hidden />
            <span className="truncate text-sm text-ink">
              {status.member?.email ?? "—"}
            </span>
          </div>
          <Button variant="outline" onClick={signOut} disabled={working}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invite a coworker</CardTitle>
          <CardDescription>
            Generate a one-time link. Anyone who opens it picks their own email
            and password and joins as an operator. Hand it off out-of-band — no
            email is sent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={createInvite} disabled={working}>
            <UserPlus className="size-4" />
            Create invite link
          </Button>
          {inviteUrl && (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate border border-paper-rule bg-paper-sunk px-3 py-2 font-mono text-[12px] text-ink">
                {inviteUrl}
              </code>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copy invite link"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(inviteUrl);
                    toast.success("Copied");
                  } catch {
                    toast.error("Couldn't copy — select the link manually");
                  }
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Everyone who can sign in. Removing someone invalidates their
            sessions immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {members === null ? (
            <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Loading…
            </div>
          ) : members.length === 0 ? (
            <div className="text-sm text-ink-soft">No members yet.</div>
          ) : (
            <ul className="divide-y divide-paper-rule/40">
              {members.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink">
                      {m.email}
                      {m.id === currentId && (
                        <span className="ml-2 font-mono text-[11px] text-ink-faint">
                          (you)
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-ink-faint">
                      Joined {formatDate(m.createdAt)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${m.email}`}
                    disabled={m.id === currentId}
                    onClick={() => revoke(m)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
