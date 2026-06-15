import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

export type FeedItem = {
  title: string;
  url: string;
  description?: string;
  date?: string;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildRssFeed(opts: {
  title: string;
  description?: string;
  path: string;
  items: FeedItem[];
}): string {
  const feedUrl = `${SITE_URL}${opts.path}`;
  const items = opts.items
    .map((item) => {
      const link = `${SITE_URL}${item.url}`;
      return [
        "    <item>",
        `      <title>${escapeXml(item.title)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
        item.date
          ? `      <pubDate>${new Date(item.date).toUTCString()}</pubDate>`
          : "",
        item.description
          ? `      <description>${escapeXml(item.description)}</description>`
          : "",
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(`${SITE_NAME} — ${opts.title}`)}</title>`,
    `    <link>${escapeXml(feedUrl)}</link>`,
    `    <description>${escapeXml(opts.description ?? SITE_DESCRIPTION)}</description>`,
    `    <atom:link href="${escapeXml(`${feedUrl}/rss.xml`)}" rel="self" type="application/rss+xml"/>`,
    items,
    "  </channel>",
    "</rss>",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}
