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
