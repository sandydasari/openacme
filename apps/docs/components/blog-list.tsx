"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AuthorBadge } from "@/components/author-badge";

export type BlogListItem = {
  url: string;
  title: string;
  description?: string;
  date: string;
  dateLabel: string;
  author: string;
  tags: string[];
  image?: string;
};

export function BlogList({ posts }: { posts: BlogListItem[] }) {
  const [active, setActive] = useState<string | null>(null);

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const p of posts) for (const t of p.tags) set.add(t);
    return Array.from(set).sort();
  }, [posts]);

  const shown = active ? posts.filter((p) => p.tags.includes(active)) : posts;

  return (
    <div>
      {tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-paper-rule py-4">
          <FilterChip
            label="All"
            active={active === null}
            onClick={() => setActive(null)}
          />
          {tags.map((t) => (
            <FilterChip
              key={t}
              label={t}
              active={active === t}
              onClick={() => setActive(t)}
            />
          ))}
        </div>
      ) : null}

      <ul>
        {shown.map((post) => (
          <li key={post.url} className="border-b border-paper-rule">
            <Link
              href={post.url}
              className="group flex items-start gap-6 py-8 transition-colors focus-scribe"
            >
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[12px] leading-none tracking-[0.14em] text-ink-faint uppercase">
                  {post.dateLabel}
                </p>
                <h2 className="mt-3 text-[1.4rem] leading-[1.15] font-semibold tracking-[-0.015em] text-ink transition-colors group-hover:text-plot-red">
                  {post.title}
                </h2>
                {post.description ? (
                  <p className="mt-2.5 text-[15px] leading-relaxed text-ink-soft">
                    {post.description}
                  </p>
                ) : null}
                <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
                  <AuthorBadge author={post.author} />
                  {post.tags.length > 0 ? (
                    <span className="flex flex-wrap gap-2">
                      {post.tags.map((t) => (
                        <span
                          key={t}
                          className="border border-paper-rule px-2 py-0.5 font-mono text-[10px] tracking-[0.1em] text-ink-faint uppercase"
                        >
                          {t}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
              </div>
              {post.image ? (
                <div className="hidden shrink-0 self-center border border-paper-rule bg-paper-sunk sm:block">
                  <img
                    src={post.image}
                    alt=""
                    loading="lazy"
                    className="block aspect-[16/10] w-36 object-cover md:w-44"
                  />
                </div>
              ) : null}
            </Link>
          </li>
        ))}
        {shown.length === 0 ? (
          <li className="py-16 text-center text-[14px] text-ink-faint">
            No posts here yet.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`border px-2.5 py-1 font-mono text-[11px] tracking-[0.1em] uppercase transition-colors focus-scribe ${
        active
          ? "border-plot-red text-plot-red"
          : "border-paper-rule text-ink-faint hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
