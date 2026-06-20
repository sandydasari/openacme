import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { blogSource } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";
import { AuthorBadge } from "@/components/author-badge";
import { Comments } from "@/components/comments";
import { formatDate } from "@/lib/format";
import { SITE_NAME } from "@/lib/site";

export default async function BlogPost(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const page = blogSource.getPage([slug]);
  if (!page) notFound();

  const MDX = page.data.body;
  const tags = page.data.tags ?? [];

  return (
    <main className="flex flex-1 flex-col">
      <article className="mx-auto w-full max-w-3xl px-6 pt-12 pb-20 sm:pt-16">
        <Link
          href="/blog"
          className="font-mono text-[11px] tracking-[0.14em] text-ink-faint uppercase transition-colors hover:text-plot-red focus-scribe"
        >
          ← Blog
        </Link>

        <header className="mt-8 border-b border-paper-rule pb-8">
          {tags.length > 0 ? (
            <p className="flex flex-wrap gap-3">
              {tags.map((t) => (
                <span
                  key={t}
                  className="font-mono text-[11px] tracking-[0.14em] text-plot-red uppercase"
                >
                  {t}
                </span>
              ))}
            </p>
          ) : null}
          <h1 className="mt-4 text-[clamp(1.9rem,4vw,2.6rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance">
            {page.data.title}
          </h1>
          {page.data.description ? (
            <p className="mt-4 text-[17px] leading-relaxed text-ink-soft">
              {page.data.description}
            </p>
          ) : null}
          <div className="mt-7 flex flex-wrap items-center justify-between gap-4">
            <AuthorBadge author={page.data.author} />
            <time
              dateTime={page.data.date}
              className="font-mono text-[12px] tracking-[0.14em] text-ink-faint uppercase"
            >
              {formatDate(page.data.date)}
            </time>
          </div>
        </header>

        <div className="prose prose-console mt-10 max-w-none">
          <MDX components={getMDXComponents()} />
        </div>

        <aside className="mt-16 border-t border-paper-rule pt-10">
          <p className="font-mono text-[11px] tracking-[0.14em] text-ink-faint uppercase">
            The project behind this
          </p>
          <p className="mt-3 max-w-xl text-[17px] leading-relaxed text-ink-soft">
            OpenAcme is an open-source platform for running a self-hosted
            workforce of AI agents. This post is a note from building it.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <a
              href="https://github.com/sandydasari/openacme"
              target="_blank"
              rel="noreferrer"
              className="bg-ink px-4 py-2.5 font-mono text-[12px] tracking-[0.1em] text-paper uppercase transition-colors hover:bg-plot-red focus-scribe"
            >
              Star on GitHub
            </a>
            <a
              href="https://openacme.org"
              target="_blank"
              rel="noreferrer"
              className="border border-paper-rule px-4 py-2.5 font-mono text-[12px] tracking-[0.1em] text-ink-soft uppercase transition-colors hover:border-plot-red hover:text-plot-red focus-scribe"
            >
              Explore OpenAcme
            </a>
          </div>
        </aside>

        <Comments />
      </article>
    </main>
  );
}

export function generateStaticParams() {
  return blogSource.getPages().map((page) => ({ slug: page.slugs[0] }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const page = blogSource.getPage([slug]);
  if (!page) notFound();
  const { title, description, image, date, tags } = page.data;
  const url = `/blog/${slug}`;
  // metadataBase (root layout) makes these absolute for X/Reddit/etc.
  const ogImage = image ?? "/og/default.png";
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      url,
      siteName: SITE_NAME,
      title,
      description,
      publishedTime: date,
      tags,
      images: [ogImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  };
}
