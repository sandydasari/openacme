import { z } from 'zod';
import * as fs from "node:fs";
import * as path from "node:path";
import { registry } from "../registry.js";
import {
  getCurrentWorkspaceDir,
  getCurrentSessionId,
  getCurrentToolCallId,
  supportsCurrentToolResultMedia,
} from "../session-context.js";
import { resolveToolCallsDir } from "../spill.js";

/**
 * File tools — read, write, list, search files.
 * Mirrors Hermes tools/file_tools.py.
 */

const MAX_LINES_LIMIT = 10000;
const MAX_DEPTH_LIMIT = 10;
const MAX_SEARCH_RESULTS = 500;

const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** Per-media-kind size caps + the marker the prepareStep injector keys
 *  off. Image is broader than PDF because models tend to charge per-image
 *  at a flat token rate regardless of size, while PDFs are cheap but can
 *  be much longer. */
export type MediaKind = "image" | "pdf";

const MEDIA_BY_MIME: Record<string, { kind: MediaKind; max: number }> = {
  "image/png": { kind: "image", max: 5 * 1024 * 1024 },
  "image/jpeg": { kind: "image", max: 5 * 1024 * 1024 },
  "image/gif": { kind: "image", max: 5 * 1024 * 1024 },
  "image/webp": { kind: "image", max: 5 * 1024 * 1024 },
  "application/pdf": { kind: "pdf", max: 10 * 1024 * 1024 },
};

/** Relative paths resolve against the agent's workspace dir (when an
 *  agent context is active) or `process.cwd()` (for unit tests / other
 *  no-context callers). */
function resolveAgainstWorkspace(p: string): string {
  const base = getCurrentWorkspaceDir() ?? process.cwd();
  return path.resolve(base, p);
}

/** Magic-byte MIME sniff for the binary types we support as vision /
 *  document input. Returns null for anything we won't materialize as a
 *  user-message ImagePart/FilePart — the caller falls back to UTF-8 text
 *  reads (or an unknown-binary error). Mirrors `sniffMime` in
 *  packages/server/src/routes/uploads.ts (kept inline to avoid a
 *  cross-package dep). */
function sniffMime(head: Buffer): string | null {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
    return "image/gif";
  }
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) {
    return "image/webp";
  }
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) {
    return "application/pdf";
  }
  return null;
}

function readHead(filePath: string, n: number): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(n);
    const bytesRead = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Build an AI-SDK `ToolResultOutput` from a media-pointer handler return.
 *
 *   - Native paths (Anthropic, OpenAI Responses, Google for images):
 *     emit a `content` array with image-data / file-data so the model
 *     sees the bytes inline in `tool_result.content`. Cache-friendly:
 *     the bytes become part of the prefix on cache hits.
 *
 *   - Non-supporting paths (OpenAI Chat Completions, openai-compatible
 *     incl. OpenRouter; Google for PDFs): emit a text descriptor
 *     ("[image: foo.png, image/png, 804B, saved at /...]") so the model
 *     at least knows the file exists, its type, and where it is — same
 *     pattern Hermes uses to downgrade when the adapter can't carry
 *     list-content. No synthetic user message; the human reviewer
 *     still sees the actual image in the chat via the tool block's
 *     MediaPreview render.
 *
 * Adapter dispatch (verified per `@ai-sdk/*`):
 *   - `@ai-sdk/anthropic`           image ✓ PDF ✓
 *   - `@ai-sdk/openai` Responses    image ✓ PDF ✓
 *   - `@ai-sdk/google`              image ✓ PDF ✗ (drops with warning)
 *   - `@ai-sdk/openai` Chat         ✗ (stringifies)
 *   - `@ai-sdk/openai-compatible`   ✗ (stringifies)
 */
export function buildMediaToolModelOutput(opts: {
  toolCallId: string;
  input: Record<string, unknown>;
  output: string;
}): unknown {
  const { output } = opts;
  if (typeof output !== "string") return { type: "text", value: String(output) };
  let parsed: {
    _media?: "image" | "pdf";
    path?: string;
    mediaType?: string;
    bytes?: number;
  };
  try {
    parsed = JSON.parse(output) as never;
  } catch {
    return { type: "text", value: output };
  }
  if (!parsed._media || !parsed.path || !parsed.mediaType) {
    return { type: "text", value: output };
  }
  const basename = path.basename(parsed.path);
  const sizeLabel = parsed.bytes != null ? `${parsed.bytes}B` : "?";

  if (!supportsCurrentToolResultMedia(parsed._media)) {
    // Provider can't carry media in tool_result content. Tell the
    // model what we got (kind, type, location) so it can reason about
    // the file even without seeing it; the bytes stay on disk and
    // render in the human-facing UI via the tool block.
    return {
      type: "text",
      value: `[${parsed._media}: ${basename}, ${parsed.mediaType}, ${sizeLabel}, saved at ${parsed.path}; the active model does not support inline media in tool results — the bytes are available on disk but not visually attached to this turn]`,
    };
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(parsed.path);
  } catch {
    return { type: "text", value: output };
  }
  const data = bytes.toString("base64");
  const summary = `Read ${parsed.path} (${parsed.mediaType}, ${parsed.bytes ?? bytes.length}B)`;
  const mediaPart =
    parsed._media === "image"
      ? { type: "image-data", data, mediaType: parsed.mediaType }
      : { type: "file-data", data, mediaType: parsed.mediaType, filename: basename };
  return {
    type: "content",
    value: [{ type: "text", text: summary }, mediaPart],
  };
}

/** Copy bytes from a source path into the per-session tool-calls dir so
 *  the chat UI can fetch them via the `/api/files/...` route. On-disk
 *  layout: `<agentDir>/sessions/<sessionId>/tool-calls/<toolCallId>-<basename>`
 *  — flat naming preserves the existing `sweepOverflow` /
 *  `deleteSessionToolCalls` cleanup semantics. Tries `linkSync` first
 *  (free hardlink on the same filesystem) and falls back to `copyFileSync`
 *  on EXDEV. Returns the public URL or null if no session/call context
 *  is set (tests, scripts). */
function exposeAsSessionFile(srcPath: string, basename: string): string | null {
  const dir = resolveToolCallsDir();
  const sessionId = getCurrentSessionId();
  const callId = getCurrentToolCallId();
  if (!dir || !sessionId || !callId) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${callId}-${basename}`);
    try {
      fs.linkSync(srcPath, dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // Same call retried — already exposed. Idempotent.
      } else {
        fs.copyFileSync(srcPath, dest);
      }
    }
    return `/api/files/${encodeURIComponent(sessionId)}/${encodeURIComponent(callId)}/${encodeURIComponent(basename)}`;
  } catch {
    return null;
  }
}

registry.register({
  name: "read_file",
  toolset: "filesystem",
  runtime: "worker",
  description:
    "Read a file by path. Handles text, images (PNG/JPEG/GIF/WebP), and PDFs. " +
    "Image and PDF content is delivered as a vision input on multimodal models " +
    "(inline in the tool result on Anthropic / OpenAI Responses / Google-images; " +
    "via a synthetic user message on OpenRouter / OpenAI Chat Completions). " +
    "Relative paths resolve against your agent's workspace dir.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative path to the file"),
    maxLines: z.number().min(1).max(MAX_LINES_LIMIT).optional().describe("Max lines to read (text files only; ignored for images/PDFs)."),
  }),
  emoji: "📄",
  parallelSafe: true,
  toModelOutput: buildMediaToolModelOutput,
  handler: async (args) => {
    const { path: filePath, maxLines } = args as {
      path: string;
      maxLines?: number;
    };
    try {
      const resolved = resolveAgainstWorkspace(filePath);
      const st = fs.statSync(resolved);
      if (!st.isFile()) {
        return JSON.stringify({ error: "not a regular file", path: resolved });
      }

      const head = readHead(resolved, 16);
      const mime = sniffMime(head);
      const media = mime ? MEDIA_BY_MIME[mime] : undefined;

      if (media) {
        if (st.size > media.max) {
          return JSON.stringify({
            error: `${media.kind} too large: ${st.size} bytes (cap ${media.max})`,
            path: resolved,
            bytes: st.size,
          });
        }
        const url = exposeAsSessionFile(resolved, path.basename(resolved));
        return JSON.stringify({
          success: true,
          path: resolved,
          mediaType: mime,
          bytes: st.size,
          _media: media.kind,
          ...(url ? { url } : {}),
        });
      }

      // Unknown magic — best-effort UTF-8 decode. Detect binary by
      // scanning for NUL bytes in the head; refuse if found (likely not
      // text).
      if (head.includes(0x00)) {
        return JSON.stringify({
          error:
            "binary file with unrecognized type — only PNG/JPEG/GIF/WebP/PDF are recognized as media. Use shell to inspect.",
          path: resolved,
          bytes: st.size,
        });
      }

      if (st.size > MAX_TEXT_BYTES) {
        return JSON.stringify({
          error: `text file too large: ${st.size} bytes (cap ${MAX_TEXT_BYTES}). Use shell head/tail or pass maxLines.`,
          path: resolved,
          bytes: st.size,
        });
      }

      const content = fs.readFileSync(resolved, "utf-8");
      if (maxLines) {
        const lines = content.split("\n").slice(0, maxLines).join("\n");
        return JSON.stringify({
          success: true,
          path: resolved,
          content: lines,
          truncated: content.split("\n").length > maxLines,
        });
      }
      return JSON.stringify({ success: true, path: resolved, content });
    } catch (error: unknown) {
      return JSON.stringify({
        error: (error as Error).message,
        path: filePath,
      });
    }
  },
});

// ── write_file ──
registry.register({
  name: "write_file",
  toolset: "filesystem",
  runtime: "worker",
  description:
    "Write content to a file. Creates the file and any parent directories " +
    "if they don't exist. Relative paths resolve against your agent's " +
    "workspace dir.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative path for the file"),
    content: z.string().describe("Content to write to the file"),
  }),
  emoji: "✍️",
  parallelSafe: false,
  handler: async (args) => {
    const { path: filePath, content } = args as {
      path: string;
      content: string;
    };
    try {
      const resolved = resolveAgainstWorkspace(filePath);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolved, content, "utf-8");
      return JSON.stringify({
        success: true,
        path: resolved,
        bytesWritten: Buffer.byteLength(content),
      });
    } catch (error: unknown) {
      return JSON.stringify({ error: (error as Error).message });
    }
  },
});

// ── list_files ──
registry.register({
  name: "list_files",
  toolset: "filesystem",
  runtime: "worker",
  description:
    "List files and directories at the given path. Returns names, types, " +
    "and sizes. Relative paths resolve against your agent's workspace dir.",
  parameters: z.object({
    path: z
      .string()
      .optional()
      .default(".")
      .describe("Directory path to list (default: workspace root)"),
    recursive: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, list recursively"),
    maxDepth: z.number().min(1).max(MAX_DEPTH_LIMIT).optional().default(3).describe("Max recursion depth (max 10)"),
  }),
  emoji: "📁",
  parallelSafe: true,
  handler: async (args) => {
    const {
      path: dirPath,
      recursive,
      maxDepth,
    } = args as {
      path: string;
      recursive: boolean;
      maxDepth: number;
    };

    function listDir(
      dir: string,
      depth: number
    ): Array<{ name: string; type: string; size?: number }> {
      const entries: Array<{ name: string; type: string; size?: number }> = [];
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (item.name.startsWith(".")) continue; // skip hidden
          const fullPath = path.join(dir, item.name);
          if (item.isDirectory()) {
            entries.push({ name: item.name + "/", type: "directory" });
            if (recursive && depth < maxDepth) {
              const children = listDir(fullPath, depth + 1);
              for (const child of children) {
                entries.push({
                  ...child,
                  name: item.name + "/" + child.name,
                });
              }
            }
          } else {
            const stat = fs.statSync(fullPath);
            entries.push({
              name: item.name,
              type: "file",
              size: stat.size,
            });
          }
        }
      } catch (error: unknown) {
        entries.push({
          name: `[error: ${(error as Error).message}]`,
          type: "error",
        });
      }
      return entries;
    }

    const resolved = resolveAgainstWorkspace(dirPath);
    const entries = listDir(resolved, 0);
    return JSON.stringify({
      success: true,
      path: resolved,
      entries,
      count: entries.length,
    });
  },
});

// ── search_files ──
registry.register({
  name: "search_files",
  toolset: "filesystem",
  runtime: "worker",
  description:
    "Search for a text pattern across files using grep. Returns matching " +
    "lines with file paths and line numbers. Relative paths resolve " +
    "against your agent's workspace dir.",
  parameters: z.object({
    pattern: z.string().describe("Text pattern or regex to search for"),
    path: z
      .string()
      .optional()
      .default(".")
      .describe("Directory to search in (default: workspace root)"),
    fileGlob: z
      .string()
      .optional()
      .describe("File glob pattern to filter (e.g. '*.ts')"),
    maxResults: z.number().min(1).max(MAX_SEARCH_RESULTS).optional().default(50).describe("Max results (max 500)"),
  }),
  emoji: "🔍",
  parallelSafe: true,
  handler: async (args) => {
    const { pattern, path: searchPath, fileGlob, maxResults } = args as {
      pattern: string;
      path: string;
      fileGlob?: string;
      maxResults: number;
    };

    try {
      const { execSync } = await import("node:child_process");
      const resolved = resolveAgainstWorkspace(searchPath);

      // Escape shell special characters in user input
      const escapeShellArg = (arg: string): string =>
        arg.replace(/[\\"`$]/g, "\\$&");

      let cmd = `grep -rnI --max-count=${maxResults}`;
      if (fileGlob) {
        // Validate fileGlob doesn't contain shell injection characters
        if (/[;&|`$(){}]/.test(fileGlob)) {
          return JSON.stringify({
            error: "Invalid fileGlob: contains disallowed characters",
            pattern,
          });
        }
        cmd += ` --include="${escapeShellArg(fileGlob)}"`;
      }
      cmd += ` "${escapeShellArg(pattern)}" "${escapeShellArg(resolved)}"`;

      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }).trim();

      const matches = output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(.+?):(\d+):(.*)$/);
          if (match) {
            return {
              file: match[1],
              line: parseInt(match[2]!, 10),
              content: match[3]!.trim(),
            };
          }
          return { file: "", line: 0, content: line };
        });

      return JSON.stringify({
        success: true,
        pattern,
        matches,
        count: matches.length,
      });
    } catch {
      return JSON.stringify({
        success: true,
        pattern,
        matches: [],
        count: 0,
        note: "No matches found",
      });
    }
  },
});
