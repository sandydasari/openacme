import type { InferPageType } from "fumadocs-core/source";
import type { blogSource, source } from "@/lib/source";
import { SITE_URL } from "@/lib/site";

type DocsPage = InferPageType<typeof source>;
type BlogPage = InferPageType<typeof blogSource>;

// URL of the raw-markdown mirror served by app/md/[...slug]/route.ts.
export function mdUrl(page: DocsPage | BlogPage): string {
  return `${SITE_URL}/md${page.url}.md`;
}

export async function getLLMText(page: DocsPage | BlogPage): Promise<string> {
  const content = await page.data.getText("processed");
  const lines = [
    `# ${page.data.title}`,
    ``,
    `URL: ${SITE_URL}${page.url}`,
  ];
  if (page.data.description) lines.push(``, page.data.description);
  lines.push(``, content);
  return lines.join("\n");
}
