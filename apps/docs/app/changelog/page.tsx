import type { Metadata } from "next";
import { changelogSource } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";
import { formatDate, releaseAnchor } from "@/lib/format";
import { compareVersions } from "@/lib/semver";
import { SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: "Changelog",
  description: `What's new in ${SITE_NAME}, release by release.`,
  alternates: { types: { "application/rss+xml": "/changelog/rss.xml" } },
};

export default function ChangelogPage() {
  const entries = changelogSource
    .getPages()
    .sort((a, b) => compareVersions(b.data.version, a.data.version));

  return (
    <main className="flex flex-1 flex-col">
      <div className="mx-auto w-full max-w-3xl px-6">
        <header className="border-b border-paper-rule pt-16 pb-10 sm:pt-20">
          <p className="flex items-center gap-3 font-mono text-[12px] leading-none tracking-[0.2em] text-plot-red uppercase">
            <span className="inline-block size-1.5 bg-plot-red" />
            Changelog
          </p>
          <h1 className="mt-6 text-[clamp(2rem,4vw,2.6rem)] leading-[1.06] font-semibold tracking-[-0.02em]">
            Every release, in order.
          </h1>
          <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-ink-soft">
            What shipped, version by version. Generated from the release notes.
          </p>
        </header>

        {entries.length === 0 ? (
          <p className="py-16 text-center text-[14px] text-ink-faint">
            No releases yet.
          </p>
        ) : (
          <ol>
            {entries.map((entry) => {
              const MDX = entry.data.body;
              const tags = entry.data.tags ?? [];
              const release = entry.data.release;
              const anchor = releaseAnchor(entry.data.version);
              return (
                <li
                  key={entry.data.version}
                  id={anchor}
                  className="scroll-mt-24 border-b border-paper-rule py-10 last:border-b-0"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                    <div className="flex items-center gap-3">
                      <span className="inline-block size-2 self-center bg-plot-red" />
                      <a
                        href={`#${anchor}`}
                        className="font-mono text-[1.2rem] leading-none font-medium tracking-tight text-ink tabular-nums transition-colors hover:text-plot-red focus-scribe"
                      >
                        {entry.data.version}
                      </a>
                      {release ? (
                        <a
                          href={release}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[11px] tracking-[0.12em] text-ink-faint uppercase transition-colors hover:text-plot-red focus-scribe"
                        >
                          release ↗
                        </a>
                      ) : null}
                    </div>
                    {entry.data.date ? (
                      <time
                        dateTime={entry.data.date}
                        className="font-mono text-[12px] tracking-[0.14em] text-ink-faint uppercase"
                      >
                        {formatDate(entry.data.date)}
                      </time>
                    ) : null}
                  </div>

                  {tags.length > 0 ? (
                    <p className="mt-3 flex flex-wrap gap-2 pl-5">
                      {tags.map((t) => (
                        <span
                          key={t}
                          className="border border-paper-rule px-2 py-0.5 font-mono text-[10px] tracking-[0.1em] text-ink-faint uppercase"
                        >
                          {t}
                        </span>
                      ))}
                    </p>
                  ) : null}

                  <div className="prose prose-console mt-5 max-w-none pl-5">
                    <MDX components={getMDXComponents()} />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </main>
  );
}
