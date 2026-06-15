// Brand marks — full color for recognition (DESIGN.md §brand-logos: brand
// recognition beats palette purity; users shouldn't have to decode a
// monochrome glyph). LLM/tool marks come from @lobehub/icons (.Color where the
// brand is colorful; the plain mark where the real logo is black, e.g. OpenAI
// / Ollama / OpenRouter). Brave is simple-icons (CC0); Firecrawl + Browserbase
// are the official brand SVGs copied verbatim. Google/Microsoft are the
// canonical OAuth marks.
import { Boxes, Globe2 } from "lucide-react";
import {
  Claude,
  Exa,
  Gemini,
  Mistral,
  Ollama,
  OpenAI,
  OpenRouter,
  Tavily,
} from "@lobehub/icons";
import { siBrave } from "simple-icons";

// Firecrawl flame — official mark from svgl.app (firecrawl.dev/brand), copied
// verbatim. Rendered in its brand orange.
export function FirecrawlIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 50 72" className={className} fill="#fa5d19" aria-hidden>
      <path d="M41.715 23.193c-2.762.82-4.844 2.675-6.37 4.69-.327.432-1.01.107-.88-.423 2.92-12.007-.937-21.986-12.961-26.898a.803.803 0 0 0-1.085.937c5.47 21.961-17.537 20.109-14.63 45.005.05.427-.43.72-.78.47-1.09-.782-2.307-2.415-3.142-3.562a.502.502 0 0 0-.887.16c-.665 2.404-.98 4.67-.98 6.92 0 8.749 4.497 16.45 11.304 20.915.39.255.89-.11.758-.557a13.5 13.5 0 0 1-.563-3.697c0-.788.05-1.593.173-2.343.285-1.885.94-3.68 2.04-5.314 3.772-5.663 11.334-11.132 10.127-18.56-.078-.47.477-.78.827-.457 5.328 4.868 6.383 11.415 5.508 17.287-.075.51.564.782.887.382a11.6 11.6 0 0 1 2.892-2.587c.27-.168.63-.04.733.26.602 1.752 1.497 3.397 2.342 5.042a13.46 13.46 0 0 1 .905 9.982.502.502 0 0 0 .755.57C45.5 66.95 50 59.248 50 50.494c0-3.043-.532-6.025-1.54-8.82-2.112-5.862-7.472-10.264-6.117-17.904.065-.365-.273-.682-.628-.577" />
    </svg>
  );
}

// Browserbase — official favicon mark (browserbase.com/favicon.svg), verbatim.
export function BrowserbaseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 200" className={className} fill="none" aria-hidden>
      <rect x="30" y="36" width="134" height="124" fill="white" />
      <path d="M111.168 116.901H83.168V109.901H111.168V116.901Z" fill="#FF4500" />
      <path d="M111.168 86.208H83.168V79.208H111.168V86.208Z" fill="#FF4500" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M200 200H0V0H200V200ZM55.4453 147.815H128.678L145.259 131.234V111.891L131.441 98.0723L142.495 87.0186V69.0557L125.914 52.4756H55.4453V147.815Z"
        fill="#FF4500"
      />
    </svg>
  );
}

// Browser Use — official logo (single-color, provided by the project).
// Rendered in currentColor.
export function BrowserUseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} fill="currentColor" aria-hidden>
      <path d="M97.8916 39.0448C82.6177 33.1997 95.2199 10.8169 74.212 11.3849C48.5413 12.0793 8.31528 52.4518 12.4236 78.6851C14.4652 91.6755 24.6096 86.2218 29.3732 88.1154C32.5364 89.3652 36.2792 95.0083 40.3245 95.9047C22.4293 106.193 -0.556809 96.397 0.0102912 74.3423C0.829435 41.86 47.7474 -5.25386 81.1937 0.477571C99.8702 3.68414 102.189 23.5422 97.8916 39.0448Z" />
      <path d="M24.8115 57.7541L39.6068 71.7166C49.0332 80.1875 74.061 94.9706 85.403 84.9469C98.774 73.1306 70.495 32.3162 57.4769 25.802L68.9069 20.6639C86.7138 33.6796 113.783 75.9836 91.7294 94.4025C77.5014 106.282 54.5655 96.2204 41.0811 87.3707C30.8103 80.6294 15.9647 70.9591 24.8115 57.7415V57.7541Z" />
      <path d="M40.3373 4.75723C35.5485 4.88347 31.8055 11.1199 28.2895 12.2182C25.1642 13.1903 20.8414 10.5266 16.1408 14.0487C11.0495 17.8613 12.7891 36.0655 3.02233 40.5976C-2.98893 22.9362 0.75354 1.8789 22.4672 0.0736228C24.1433 -0.0652445 42.7822 1.17195 40.3373 4.74463V4.75723Z" />
      <path d="M76.1025 57.754C84.1175 71.0348 69.5871 86.2092 57.489 74.1025L76.1025 57.754Z" />
    </svg>
  );
}

// Renders a simple-icons glyph (24-grid path). Defaults to the brand color.
function SimpleIcon({
  icon,
  color,
  className,
}: {
  icon: { title: string; path: string; hex: string };
  color?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={color ?? `#${icon.hex}`}
      aria-hidden
    >
      <path d={icon.path} />
    </svg>
  );
}

export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

export function MicrosoftIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 23 23" className={className} aria-hidden>
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

type Vendor =
  | "anthropic"
  | "openai"
  | "google"
  | "mistral"
  | "openrouter"
  | "ollama";

function VendorMark({
  vendor,
  className,
}: {
  vendor: Vendor | null;
  className?: string;
}) {
  switch (vendor) {
    // Colorful brands → .Color. Anthropic models are Claude, and Claude's
    // colored sunburst is the recognizable mark.
    case "anthropic":
      return <Claude.Color className={className} aria-hidden />;
    case "google":
      return <Gemini.Color className={className} aria-hidden />;
    case "mistral":
      return <Mistral.Color className={className} aria-hidden />;
    // These brands' real logos are black — the plain mark is the brand color.
    case "openai":
      return <OpenAI className={className} aria-hidden />;
    case "openrouter":
      return <OpenRouter className={className} aria-hidden />;
    case "ollama":
      return <Ollama className={className} aria-hidden />;
    default:
      return <Boxes className={className} aria-hidden />;
  }
}

/**
 * Infer the LLM vendor from a model id. Handles bare ids (`claude-opus-4-8`,
 * `gpt-5`) and OpenRouter-style prefixes (`anthropic/claude-…`, `openai/…`,
 * `google/gemini-…`). Returns null when no confident match — caller falls
 * back to a neutral glyph rather than a wrong logo.
 */
export function providerFromModel(model: string): Vendor | null {
  const m = model.toLowerCase();
  if (m.includes("claude") || m.startsWith("anthropic/")) return "anthropic";
  if (m.includes("gemini") || m.startsWith("google/") || m.includes("gemma"))
    return "google";
  if (m.includes("mistral") || m.includes("mixtral") || m.includes("magistral"))
    return "mistral";
  if (
    m.includes("gpt") ||
    m.startsWith("openai/") ||
    /\bo[1-4]\b/.test(m) ||
    m.includes("o1-") ||
    m.includes("o3-")
  )
    return "openai";
  return null;
}

/** Map a provider id (config provider enum) to a vendor mark. */
function vendorFromProvider(provider: string): Vendor | null {
  const p = provider.toLowerCase();
  if (p === "anthropic") return "anthropic";
  if (p === "openai") return "openai";
  if (p === "google") return "google";
  if (p === "openrouter") return "openrouter";
  if (p === "ollama") return "ollama";
  if (p === "mistral") return "mistral";
  return null;
}

/** Brand mark for a provider id (openai/anthropic/openrouter/…); neutral otherwise. */
export function ProviderBrandLogo({
  provider,
  className,
}: {
  provider: string;
  className?: string;
}) {
  return (
    <VendorMark vendor={vendorFromProvider(provider)} className={className} />
  );
}

/** Brand mark for a model id; neutral glyph when the vendor is unknown. */
export function ModelProviderLogo({
  model,
  className,
}: {
  model: string;
  className?: string;
}) {
  return <VendorMark vendor={providerFromModel(model)} className={className} />;
}

/**
 * Brand mark for a tool/service id — web-search (tavily/exa/brave) and browser
 * (browserbase/browser-use/firecrawl) providers. Unknown ids fall back to a
 * neutral globe rather than a wrong logo.
 */
export function ToolBrandLogo({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  switch (id.toLowerCase()) {
    case "tavily":
      return <Tavily.Color className={className} aria-hidden />;
    case "exa":
      return <Exa className={className} aria-hidden />;
    case "brave":
      return <SimpleIcon icon={siBrave} className={className} />;
    case "firecrawl":
      return <FirecrawlIcon className={className} />;
    case "browserbase":
      return <BrowserbaseIcon className={className} />;
    case "browser-use":
      return <BrowserUseIcon className={className} />;
    default:
      return <Globe2 className={className} aria-hidden />;
  }
}
