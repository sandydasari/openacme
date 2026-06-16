import { blog, changelog, docs } from "@/.source/server";
import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

export const blogSource = loader({
  baseUrl: "/blog",
  source: toFumadocsSource(blog, []),
});

export const changelogSource = loader({
  baseUrl: "/changelog",
  source: toFumadocsSource(changelog, []),
});
