import { useEffect, useRef } from "react";
import { API_BASE } from "./api";
import { playPing } from "./sound";
import { isPingSoundEnabled } from "./pingSoundPref";

/**
 * Workforce-wide audible ping. Subscribes to the home stream and plays a
 * sound whenever an agent calls the `ping_user` tool. Mounted once at the
 * root layout so it fires no matter which page the user is on. Dedupe by
 * event id — an SSE reconnect could redeliver. Gated on the user's
 * Settings → Notifications sound toggle (read fresh at fire time).
 */
export function usePingSound(): void {
  const lastPingIdRef = useRef<string | null>(null);
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/home/stream`, {
      withCredentials: true,
    });
    const onTaskEvent = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as {
          event?: { id: string; kind: string };
        };
        const ev = data.event;
        if (ev && ev.kind === "ping_user" && ev.id !== lastPingIdRef.current) {
          lastPingIdRef.current = ev.id;
          if (isPingSoundEnabled()) playPing();
        }
      } catch {
        /* ignore */
      }
    };
    es.addEventListener("task_event", onTaskEvent);
    return () => {
      es.removeEventListener("task_event", onTaskEvent);
      es.close();
    };
  }, []);
}
