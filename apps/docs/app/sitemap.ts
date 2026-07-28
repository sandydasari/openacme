import type { MetadataRoute } from "next";
import { blogSource, source } from "@/lib/source";
import { SITE_URL } from "@/lib/site";
import { gitLastModified } from "@/lib/last-modified";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, priority: 1 },
    { url: `${SITE_URL}/blog`, priority: 0.7 },
    { url: `${SITE_URL}/changelog`, priority: 0.7 },
    ...source.getPages().map((page) => ({
      url: `${SITE_URL}${page.url}`,
      lastModified: gitLastModified(page.absolutePath),
      priority: 0.7,
    })),
    ...blogSource
      .getPages()
      .filter((page) => !page.data.draft)
      .map((page) => ({
        url: `${SITE_URL}${page.url}`,
        lastModified: gitLastModified(page.absolutePath) ?? page.data.date,
        priority: 0.6,
      })),
  ];
}
