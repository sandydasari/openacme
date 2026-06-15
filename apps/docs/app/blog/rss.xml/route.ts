import { blogSource } from "@/lib/source";
import { buildRssFeed } from "@/lib/feed";

export const dynamic = "force-static";

export function GET() {
  const items = blogSource
    .getPages()
    .filter((p) => !p.data.draft)
    .sort(
      (a, b) =>
        new Date(b.data.date).getTime() - new Date(a.data.date).getTime(),
    )
    .map((p) => ({
      title: p.data.title,
      url: p.url,
      description: p.data.description,
      date: p.data.date,
    }));

  const xml = buildRssFeed({
    title: "Blog",
    path: "/blog",
    items,
  });

  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}
