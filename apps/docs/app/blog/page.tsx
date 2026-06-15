import type { Metadata } from "next";
import { blogSource } from "@/lib/source";
import { formatDate } from "@/lib/format";
import { BlogList, type BlogListItem } from "@/components/blog-list";
import { SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: "Blog",
  description: `Notes, releases, and ideas from the ${SITE_NAME} team.`,
  alternates: { types: { "application/rss+xml": "/blog/rss.xml" } },
};

export default function BlogIndex() {
  const posts: BlogListItem[] = blogSource
    .getPages()
    .filter((p) => process.env.NODE_ENV !== "production" || !p.data.draft)
    .sort(
      (a, b) =>
        new Date(b.data.date).getTime() - new Date(a.data.date).getTime(),
    )
    .map((p) => ({
      url: p.url,
      title: p.data.title,
      description: p.data.description,
      date: p.data.date,
      dateLabel: formatDate(p.data.date),
      author: p.data.author,
      tags: p.data.tags ?? [],
    }));

  return (
    <main className="flex flex-1 flex-col">
      <div className="mx-auto w-full max-w-3xl px-6">
        <header className="border-b border-paper-rule pt-16 pb-10 sm:pt-20">
          <p className="flex items-center gap-3 font-mono text-[12px] leading-none tracking-[0.2em] text-plot-red uppercase">
            <span className="inline-block size-1.5 bg-plot-red" />
            Blog
          </p>
          <h1 className="mt-6 text-[clamp(2rem,4vw,2.6rem)] leading-[1.06] font-semibold tracking-[-0.02em]">
            Notes from the workforce.
          </h1>
          <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-ink-soft">
            Releases, design notes, and what we&apos;re learning building an AI
            workforce you run yourself.
          </p>
        </header>
        <BlogList posts={posts} />
      </div>
    </main>
  );
}
