import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  // links omitted: a "Docs" row inside the docs sidebar is redundant.
  return (
    <DocsLayout {...baseOptions()} links={[]} tree={source.pageTree}>
      {children}
    </DocsLayout>
  );
}
