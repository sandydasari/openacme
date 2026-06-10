"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  p: (props) => <p className="mb-3 last:mb-0 leading-relaxed" {...props} />,
  h1: (props) => (
    <h1 className="mt-4 mb-2 text-xl font-semibold text-ink" {...props} />
  ),
  h2: (props) => (
    <h2 className="mt-4 mb-2 text-lg font-semibold text-ink" {...props} />
  ),
  h3: (props) => (
    <h3 className="mt-3 mb-2 text-base font-semibold text-ink" {...props} />
  ),
  ul: (props) => (
    <ul className="mb-3 ml-5 list-disc space-y-1 last:mb-0" {...props} />
  ),
  ol: (props) => (
    <ol className="mb-3 ml-5 list-decimal space-y-1 last:mb-0" {...props} />
  ),
  li: (props) => <li className="leading-relaxed" {...props} />,
  a: (props) => (
    <a
      className="text-ink underline underline-offset-4 transition-colors hover:text-plot-red"
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
  // Full hairline + paper-sunk tint instead of the side-stripe (banned).
  blockquote: (props) => (
    <blockquote
      className="my-3 border border-paper-rule bg-paper-sunk px-3 py-2 italic text-ink-soft"
      {...props}
    />
  ),
  hr: () => <hr className="my-4 h-px w-full border-0 bg-paper-rule" />,
  table: (props) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: (props) => (
    <th
      className="border border-paper-rule bg-paper-sunk px-2 py-1 text-left font-medium text-ink"
      {...props}
    />
  ),
  td: (props) => (
    <td
      className="border border-paper-rule px-2 py-1 text-ink"
      {...props}
    />
  ),
  code: ({ className, children, ...rest }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className={`${className ?? ""} font-mono text-[0.85em]`} {...rest}>
          {children}
        </code>
      );
    }
    // Inline <code> picks up surface, hairline, font-size, and padding from
    // globals.css `code:not(pre code)`. Keep the wrapper bare so the system
    // style wins; <code> is already monospaced by browser default.
    return <code {...rest}>{children}</code>;
  },
  pre: (props) => (
    <pre
      className="my-3 overflow-x-auto border border-code-surface-rule bg-code-surface p-3 font-mono text-[0.85em] leading-relaxed text-ink"
      {...props}
    />
  ),
};

// Memoized: parsing is O(message length) and runs per render — without
// this, every streamed token re-parses every message in the thread.
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
});
