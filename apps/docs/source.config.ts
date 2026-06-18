import {
  defineCollections,
  defineConfig,
  defineDocs,
  frontmatterSchema,
} from "fumadocs-mdx/config";
import { z } from "zod";

export const docs = defineDocs({
  dir: "content/docs",
});

export const blog = defineCollections({
  type: "doc",
  dir: "content/blog",
  schema: frontmatterSchema.extend({
    date: z.string(),
    author: z.string(),
    tags: z.array(z.string()).optional(),
    // Social share + list thumbnail. A 1200x630 raster (PNG/JPG); SVG won't
    // unfurl on X/Reddit. Falls back to the site default OG when absent.
    image: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

export const changelog = defineCollections({
  type: "doc",
  dir: "content/changelog",
  schema: frontmatterSchema.extend({
    version: z.string(),
    date: z.string().optional(),
    tags: z.array(z.string()).optional(),
    release: z.string().optional(),
  }),
});

export default defineConfig();
