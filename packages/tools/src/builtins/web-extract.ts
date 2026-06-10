import { z } from 'zod';
import { registry } from "../registry.js";
import { WebRateLimitError } from "../web/types.js";
import {
  type ExtractFormat,
  type ExtractProvider,
} from "../web/extract/types.js";
import { jinaProvider } from "../web/extract/jina.js";
import { firecrawlProvider } from "../web/extract/firecrawl.js";
import { localProvider, extractFromHtml } from "../web/extract/local.js";

export { extractFromHtml };

const PROVIDERS: Record<string, ExtractProvider> = {
  jina: jinaProvider,
  firecrawl: firecrawlProvider,
  local: localProvider,
};

interface ResolvedExtract {
  provider: ExtractProvider;
  apiKey?: string;
}

// Resolution order — always returns a usable provider:
//  1. Explicit OPENACME_EXTRACT_PROVIDER (jina | firecrawl | local) [+ matching key]
//  2. OPENACME_EXTRACT_LOCAL=1|true → local (privacy-first opt-in: no third-party calls)
//  3. FIRECRAWL_API_KEY set → Firecrawl (paid premium quality)
//  4. default → Jina Reader (works without a key at 20 RPM/IP; 500 RPM with JINA_API_KEY)
//
// Returns ResolvedExtract on success or a string error for misconfigured
// explicit selections.
export function resolveExtractProvider(): ResolvedExtract | string {
  const explicit = process.env.OPENACME_EXTRACT_PROVIDER;
  if (explicit) {
    const provider = PROVIDERS[explicit];
    if (!provider) {
      return `OPENACME_EXTRACT_PROVIDER='${explicit}' is not recognized (use jina, firecrawl, or local)`;
    }
    if (explicit === "firecrawl" && !process.env.FIRECRAWL_API_KEY) {
      return "OPENACME_EXTRACT_PROVIDER=firecrawl but FIRECRAWL_API_KEY is not set";
    }
    return {
      provider,
      apiKey:
        explicit === "firecrawl"
          ? process.env.FIRECRAWL_API_KEY
          : explicit === "jina"
            ? process.env.JINA_API_KEY
            : undefined,
    };
  }

  const localOptIn = process.env.OPENACME_EXTRACT_LOCAL;
  if (localOptIn === "1" || localOptIn?.toLowerCase() === "true") {
    return { provider: PROVIDERS.local! };
  }

  if (process.env.FIRECRAWL_API_KEY) {
    return { provider: PROVIDERS.firecrawl!, apiKey: process.env.FIRECRAWL_API_KEY };
  }

  return { provider: PROVIDERS.jina!, apiKey: process.env.JINA_API_KEY };
}

function rateLimitMessage(err: WebRateLimitError): string {
  const base = `Web extract rate-limited by ${err.providerId} (HTTP 429).`;
  if (err.providerId === "jina" && !err.authed) {
    return `${base} The unauthenticated Jina free tier is 20 RPM per IP. Add JINA_API_KEY (free at jina.ai, 10M tokens) for 500 RPM, or set FIRECRAWL_API_KEY for a paid premium provider, or set OPENACME_EXTRACT_LOCAL=true to extract locally without any third party.`;
  }
  if (err.providerId === "jina") {
    return `${base} You've hit your Jina quota. Set FIRECRAWL_API_KEY to switch providers, or OPENACME_EXTRACT_LOCAL=true for local extraction.`;
  }
  if (err.providerId === "firecrawl") {
    return `${base} Firecrawl quota exhausted. Try again later, drop FIRECRAWL_API_KEY to fall back to Jina, or set OPENACME_EXTRACT_LOCAL=true.`;
  }
  return `${base} Try again later or switch providers via OPENACME_EXTRACT_PROVIDER.`;
}

registry.register({
  name: "web_extract",
  toolset: "web",
  runtime: "worker",
  description:
    "Fetch a URL and extract its main readable content as markdown (default), plain text, or cleaned HTML. " +
    "Works zero-config via Jina Reader's free tier. With FIRECRAWL_API_KEY uses Firecrawl for higher reliability on JS-heavy / bot-protected sites. " +
    "Set OPENACME_EXTRACT_LOCAL=true to use local Mozilla Readability extraction with no third-party calls (privacy-first; fails on Cloudflare-protected sites).",
  parameters: z.object({
    url: z.string().url().describe("HTTP/HTTPS URL to fetch and extract"),
    format: z
      .enum(["markdown", "text", "html"])
      .optional()
      .default("markdown")
      .describe("Output format (default: markdown)"),
    maxChars: z
      .number()
      .min(1)
      .max(200_000)
      .optional()
      .default(25_000)
      .describe("Truncate the extracted content to this many characters"),
  }),
  emoji: "🌐",
  parallelSafe: true,
  handler: async (args) => {
    const { url, format, maxChars } = args as {
      url: string;
      format: ExtractFormat;
      maxChars: number;
    };

    const resolved = resolveExtractProvider();
    if (typeof resolved === "string") {
      return JSON.stringify({ error: resolved });
    }

    try {
      const result = await resolved.provider.extract(
        { url, format, maxChars },
        resolved.apiKey,
      );
      return JSON.stringify({ success: true, ...result });
    } catch (error) {
      if (error instanceof WebRateLimitError) {
        return JSON.stringify({ error: rateLimitMessage(error) });
      }
      return JSON.stringify({
        error: `Extract failed: ${(error as Error).message}`,
      });
    }
  },
});
