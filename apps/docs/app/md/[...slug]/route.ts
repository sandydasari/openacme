import { notFound } from "next/navigation";
import { blogSource, source } from "@/lib/source";
import { getLLMText } from "@/lib/llm-text";

export const dynamic = "force-static";

// Raw-markdown mirror of every docs page and blog post: /md/docs/agents.md,
// /md/blog/<slug>.md. Linked from llms.txt so answer engines can pull clean
// markdown instead of scraping the HTML.
function toParams(url: string) {
  const slug = url.slice(1).split("/");
  slug[slug.length - 1] += ".md";
  return { slug };
}

export function generateStaticParams() {
  return [
    ...source.getPages().map((p) => toParams(p.url)),
    ...blogSource
      .getPages()
      .filter((p) => !p.data.draft)
      .map((p) => toParams(p.url)),
  ];
}

export async function GET(
  _req: Request,
  props: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await props.params;
  const last = slug.at(-1);
  if (!last?.endsWith(".md")) notFound();

  const [section, ...rest] = [...slug.slice(0, -1), last.slice(0, -3)];
  const page =
    section === "docs"
      ? source.getPage(rest)
      : section === "blog"
        ? blogSource.getPage(rest)
        : undefined;
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
