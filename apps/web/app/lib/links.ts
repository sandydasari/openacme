// Docs site base URL. Single source of truth — override at build time with
// VITE_DOCS_URL, otherwise the public docs site.
const env = import.meta.env as Record<string, string | undefined>;

export const DOCS_URL = env["VITE_DOCS_URL"] || "https://openacme.pages.dev/docs";

/** Build a docs URL for a sub-path, e.g. docsUrl("/remote-access"). */
export function docsUrl(path = ""): string {
  return `${DOCS_URL}${path}`;
}
