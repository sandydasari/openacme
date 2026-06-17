import { useEffect, useState } from "react";
import { API_BASE } from "@/app/lib/api";

export interface VersionCheck {
  current: string;
  latest?: string;
  upToDate: boolean;
  command?: string;
}

/** One-shot check against the server's cached npm lookup. Silent on failure. */
export function useVersionCheck(): VersionCheck | null {
  const [data, setData] = useState<VersionCheck | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/version/check`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setData(d as VersionCheck);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return data;
}
