import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Bell, BellOff, Trash2, Smartphone, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";
import { InstallGate, useIsStandalone, useIsIos } from "./InstallGate";
import {
  usePushSubscription,
  fetchDevices,
  deleteDevice,
  type PushDevice,
} from "@/app/lib/push";
import { usePingSoundEnabled } from "@/app/lib/pingSoundPref";
import { playPing } from "@/app/lib/sound";

function formatRelative(ts: number): string {
  const ms = Date.now() - ts * 1000;
  if (ms < 60_000) return "just now";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

function describeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return ua.slice(0, 40);
}

export function NotificationsTab() {
  const standalone = useIsStandalone();
  const isIos = useIsIos();
  const push = usePushSubscription();
  const [soundEnabled, setSoundEnabled] = usePingSoundEnabled();
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [loadingDevices, setLoadingDevices] = useState(false);

  const loadDevices = async () => {
    setLoadingDevices(true);
    try {
      setDevices(await fetchDevices());
    } catch (err) {
      toast.error("Failed to load devices", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoadingDevices(false);
    }
  };

  useEffect(() => {
    void loadDevices();
  }, [push.subscribed]);

  // iOS gates push behind installed-PWA. On iOS, even calling
  // requestPermission() in a regular Safari tab silently no-ops.
  const iosBlocked = isIos && !standalone;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>
            When an agent calls <code className="border border-paper-rule bg-paper-sunk px-1 py-0.5 font-mono text-[11px] text-ink">ping_user</code>{" "}
            you get a push notification on every device you&apos;ve subscribed
            here. Notifications stop firing as soon as you reply in the
            chat — same lifecycle as the home page&apos;s &quot;waiting&quot;
            row.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <InstallGate />

          {!push.supported && (
            <div className="border border-warn-ochre bg-paper-sunk p-3 text-sm text-ink-soft">
              This browser does not support push notifications. Try a recent
              Chrome / Safari / Firefox.
            </div>
          )}

          {push.supported && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
                  Permission
                </span>
                <Badge
                  variant={
                    push.permission === "granted"
                      ? "default"
                      : push.permission === "denied"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {push.permission}
                </Badge>
                {push.subscribed && (
                  <Badge variant="default" className="bg-signal-blue">
                    Subscribed
                  </Badge>
                )}
              </div>

              {push.error && (
                <div className="border border-destructive bg-paper-sunk px-3 py-2 font-mono text-[12px] text-destructive">
                  {push.error}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {!push.subscribed ? (
                  <Button
                    onClick={async () => {
                      const r = await push.subscribe();
                      if (r) toast.success("Notifications enabled");
                    }}
                    disabled={push.working || iosBlocked}
                  >
                    <Bell className="size-4" />
                    Enable on this device
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const ok = await push.unsubscribe();
                      if (ok) toast.success("Notifications disabled here");
                    }}
                    disabled={push.working}
                  >
                    <BellOff className="size-4" />
                    Disable on this device
                  </Button>
                )}
              </div>

              {iosBlocked && (
                <div className="text-sm text-ink-soft">
                  iOS only allows web push for installed PWAs. Follow the
                  steps above, then open OpenAcme from your home screen and
                  return here.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sound</CardTitle>
          <CardDescription>
            Play a short chime in this browser whenever an agent calls{" "}
            <code className="border border-paper-rule bg-paper-sunk px-1 py-0.5 font-mono text-[11px] text-ink">ping_user</code>
            , on any page. Works without a push subscription, but only while a
            tab is open. The first chime after a fresh page load may be silent
            until you&apos;ve interacted with the page once (browser autoplay
            policy).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
              Chime
            </span>
            <Badge variant={soundEnabled ? "default" : "secondary"}>
              {soundEnabled ? "On" : "Off"}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            {soundEnabled ? (
              <Button variant="outline" onClick={() => setSoundEnabled(false)}>
                <VolumeX className="size-4" />
                Mute ping sound
              </Button>
            ) : (
              <Button onClick={() => setSoundEnabled(true)}>
                <Volume2 className="size-4" />
                Enable ping sound
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => playPing()}
              disabled={!soundEnabled}
            >
              <Volume2 className="size-4" />
              Test sound
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Subscribed devices</CardTitle>
          <CardDescription>
            Each device that has enabled notifications. Removing a device
            stops it receiving pushes — the user agent on the device is
            shown so you can pick them apart.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingDevices && !devices ? (
            <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Loading…
            </div>
          ) : !devices || devices.length === 0 ? (
            <div className="text-sm text-ink-soft">
              No devices subscribed yet.
            </div>
          ) : (
            <ul className="divide-y divide-paper-rule/40">
              {devices.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Smartphone
                      className="size-4 shrink-0 text-ink-soft"
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm text-ink">
                        {describeUserAgent(d.userAgent)}
                      </div>
                      <div className="font-mono text-[11px] text-ink-faint">
                        Added {formatRelative(d.createdAt)}
                        {d.lastUsedAt != null && (
                          <span> · last used {formatRelative(d.lastUsedAt)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={async () => {
                      try {
                        await deleteDevice(d.id);
                        await loadDevices();
                        toast.success("Device removed");
                      } catch (err) {
                        toast.error("Failed to remove", {
                          description:
                            err instanceof Error ? err.message : String(err),
                        });
                      }
                    }}
                    aria-label="Remove device"
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
