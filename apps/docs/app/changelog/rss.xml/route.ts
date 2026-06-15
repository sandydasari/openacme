import { changelogSource } from "@/lib/source";
import { compareVersions } from "@/lib/semver";
import { releaseAnchor } from "@/lib/format";
import { buildRssFeed } from "@/lib/feed";

export const dynamic = "force-static";

export function GET() {
  const items = changelogSource
    .getPages()
    .sort((a, b) => compareVersions(b.data.version, a.data.version))
    .map((p) => ({
      title: `${p.data.title ?? `v${p.data.version}`}`,
      url: `/changelog#${releaseAnchor(p.data.version)}`,
      description: p.data.description,
      date: p.data.date,
    }));

  const xml = buildRssFeed({
    title: "Changelog",
    path: "/changelog",
    items,
  });

  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}
