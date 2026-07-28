import { blogSource, changelogSource, source } from "@/lib/source";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";
import { mdUrl } from "@/lib/llm-text";

export const dynamic = "force-static";

export function GET() {
  const docs = source
    .getPages()
    .map(
      (p) => `- [${p.data.title}](${mdUrl(p)}): ${p.data.description ?? ""}`,
    );
  const blog = blogSource
    .getPages()
    .filter((p) => !p.data.draft)
    .sort(
      (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime(),
    )
    .map(
      (p) => `- [${p.data.title}](${mdUrl(p)}): ${p.data.description ?? ""}`,
    );

  const body = [
    `# ${SITE_NAME}`,
    ``,
    `> ${SITE_DESCRIPTION}`,
    ``,
    `OpenAcme is open source (https://github.com/sandydasari/openacme).`,
    `The full documentation in a single file: ${SITE_URL}/llms-full.txt`,
    ``,
    `## Docs`,
    ``,
    ...docs,
    ``,
    `## Blog`,
    ``,
    ...blog,
    ``,
    `## Optional`,
    ``,
    `- [Changelog](${SITE_URL}/changelog): every release, in order (${changelogSource.getPages().length} releases)`,
    `- [Changelog RSS](${SITE_URL}/changelog/rss.xml)`,
    `- [Blog RSS](${SITE_URL}/blog/rss.xml)`,
    ``,
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
