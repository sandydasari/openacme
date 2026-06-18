"use client";

import { useEffect, useRef } from "react";
import { GISCUS, isGiscusConfigured } from "@/lib/giscus";

const GISCUS_ORIGIN = "https://giscus.app";

function currentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function Comments() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isGiscusConfigured || !ref.current) return;
    const host = ref.current;

    // Inject the giscus script once. React StrictMode runs effects twice in dev
    // (setup, cleanup, setup); guarding on a marker keeps the script alive across
    // the remount instead of tearing it down before client.js can load.
    if (!host.querySelector("script[data-giscus]")) {
      const script = document.createElement("script");
      script.src = `${GISCUS_ORIGIN}/client.js`;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.setAttribute("data-giscus", "");
      Object.entries({
        "data-repo": GISCUS.repo,
        "data-repo-id": GISCUS.repoId,
        "data-category": GISCUS.category,
        "data-category-id": GISCUS.categoryId,
        "data-mapping": GISCUS.mapping,
        "data-strict": "1",
        "data-reactions-enabled": GISCUS.reactionsEnabled,
        "data-emit-metadata": "0",
        "data-input-position": GISCUS.inputPosition,
        "data-theme": currentTheme(),
        "data-lang": "en",
        "data-loading": "lazy",
      }).forEach(([k, v]) => script.setAttribute(k, v));
      host.appendChild(script);
    }

    // keep giscus in sync with the site theme toggle
    const observer = new MutationObserver(() => {
      const frame = host.querySelector<HTMLIFrameElement>("iframe.giscus-frame");
      frame?.contentWindow?.postMessage(
        { giscus: { setConfig: { theme: currentTheme() } } },
        GISCUS_ORIGIN,
      );
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  if (!isGiscusConfigured) return null;

  return (
    <section className="mt-16 border-t border-paper-rule pt-10">
      <p className="mb-6 font-mono text-[11px] tracking-[0.14em] text-ink-faint uppercase">
        Comments
      </p>
      <div ref={ref} />
    </section>
  );
}
