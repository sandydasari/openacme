import { useEffect, useState } from "react";

const KEY = "openacme.pingSound";
const EVENT = "openacme:ping-sound-changed";

/** Audible ping defaults ON; only an explicit opt-out disables it. */
export function isPingSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(KEY) !== "off";
}

export function setPingSoundEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  if (enabled) window.localStorage.removeItem(KEY);
  else window.localStorage.setItem(KEY, "off");
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Reactive mirror of the pref, synced across components and tabs. */
export function usePingSoundEnabled(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    const sync = () => setEnabled(isPingSoundEnabled());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return [enabled, setPingSoundEnabled];
}
