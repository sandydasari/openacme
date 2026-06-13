"use client";

import { RootProvider } from "fumadocs-ui/provider/next";
import { lazy, type ReactNode } from "react";

const SearchDialog = lazy(() => import("@/components/search"));

export function Provider({ children }: { children: ReactNode }) {
  return <RootProvider search={{ SearchDialog }}>{children}</RootProvider>;
}
