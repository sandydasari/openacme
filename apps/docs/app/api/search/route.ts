import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

// static export: the index is emitted as a JSON file at /api/search
export const revalidate = false;
export const { staticGET: GET } = createFromSource(source);
