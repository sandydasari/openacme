import { blogSource, source } from "@/lib/source";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";
import { getLLMText } from "@/lib/llm-text";

export const dynamic = "force-static";

export async function GET() {
  const pages = [
    ...source.getPages(),
    ...blogSource.getPages().filter((p) => !p.data.draft),
  ];
  const sections = await Promise.all(pages.map(getLLMText));

  const body = [
    `# ${SITE_NAME} — full documentation`,
    ``,
    `> ${SITE_DESCRIPTION}`,
    ``,
    `Site: ${SITE_URL}`,
    ``,
    sections.join("\n\n---\n\n"),
    ``,
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
