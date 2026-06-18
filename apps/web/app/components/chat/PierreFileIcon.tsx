import { getBuiltInSpriteSheet } from "@pierre/trees";
import { cn } from "@/app/lib/utils";

// Pierre ships the file-tree glyphs as an SVG sprite of `currentColor`
// <symbol>s (file-tree-builtin-<token>). We inject it once into the light DOM
// and `<use>` the symbols — same glyphs the @pierre/trees FileTree uses in
// FileBrowser, so attachment previews and the resource browser match.
let injected = false;
function ensureSprite() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const host = document.createElement("div");
  host.style.display = "none";
  host.setAttribute("data-pierre-sprite", "");
  host.innerHTML = getBuiltInSpriteSheet("complete");
  document.body.appendChild(host);
}

// Extension → Pierre built-in token (a subset of BuiltInFileIconToken).
const EXT_TOKEN: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "react",
  jsx: "react",
  css: "css",
  scss: "sass",
  sass: "sass",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  html: "html",
  htm: "html",
  svg: "svg",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  swift: "swift",
  wasm: "wasm",
  sh: "bash",
  bash: "bash",
  csv: "table",
  tsv: "table",
  xlsx: "table",
  xls: "table",
  parquet: "table",
  zip: "zip",
  tar: "zip",
  gz: "zip",
  yml: "yml",
  yaml: "yml",
  txt: "text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
};

// Token → brand color (Pierre's colored mode keys color on the token; we
// mirror the language brand colors so the glyphs read at a glance).
const TOKEN_COLOR: Record<string, string> = {
  javascript: "#f7df1e",
  typescript: "#3178c6",
  react: "#61dafb",
  css: "#2965f1",
  sass: "#cc6699",
  json: "#cbcb41",
  markdown: "#6c7986",
  python: "#3776ab",
  rust: "#dea584",
  go: "#00add8",
  ruby: "#cc342d",
  c: "#599eff",
  cpp: "#f34b7d",
  html: "#e34c26",
  svg: "#ffb13b",
  vue: "#41b883",
  svelte: "#ff3e00",
  astro: "#ff5d01",
  swift: "#f05138",
  wasm: "#654ff0",
  bash: "#4eaa25",
  table: "#21a366",
  zip: "#f7b93e",
  yml: "#cb171e",
  image: "#a074c4",
};

const FROM_MEDIA: Array<{ match: (mt: string) => boolean; token: string }> = [
  { match: (mt) => mt === "application/zip", token: "zip" },
  { match: (mt) => mt === "application/json", token: "json" },
  { match: (mt) => mt === "image/svg+xml", token: "svg" },
  {
    match: (mt) =>
      mt.includes("spreadsheet") ||
      mt === "text/csv" ||
      mt === "text/tab-separated-values" ||
      mt === "application/vnd.apache.parquet",
    token: "table",
  },
  { match: (mt) => mt.startsWith("image/"), token: "image" },
  { match: (mt) => mt === "text/yaml" || mt === "application/xml", token: "yml" },
];

function resolveToken(name?: string, mediaType?: string): string {
  if (mediaType) {
    const hit = FROM_MEDIA.find((m) => m.match(mediaType));
    if (hit) return hit.token;
  }
  const ext = name?.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TOKEN[ext] ?? "default";
}

/** A colored Pierre file-tree glyph for a file name / media type. */
export function PierreFileIcon({
  name,
  mediaType,
  className,
}: {
  name?: string;
  mediaType?: string;
  className?: string;
}) {
  ensureSprite();
  const token = resolveToken(name, mediaType);
  const color = TOKEN_COLOR[token];
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={cn("shrink-0", className)}
      style={color ? { color } : undefined}
    >
      <use href={`#file-tree-builtin-${token}`} />
    </svg>
  );
}
