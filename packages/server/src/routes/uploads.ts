import type { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "@openacme/config/logger";
import {
  previewDataAttachment,
  listZipEntries,
  readSpreadsheetPreview,
} from "@openacme/agent-core";
import type { AgentManager } from "../agent-manager.js";
import { serveFileWithRange } from "./_serve-helpers.js";

const log = createLogger("server.uploads");

// Model-native media (image/pdf) is inlined to the provider, so it stays small.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
// "data" files (zip/csv/xlsx/…) never reach the provider — the agent reads them
// off disk — so they get a roomier cap (a codebase.zip / dataset is bigger).
export const MAX_DATA_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
export const MAX_FILES = 10;
export const PENDING_TTL_MS = 30 * 60 * 1000;

type AttachmentKind = "image" | "file" | "data";

const ALLOWED_MIME: Record<string, AttachmentKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "application/pdf": "file",
};

// Agent-readable data files. Extension → label mediaType. Binary types
// (zip-family, parquet) are confirmed by magic bytes; OOXML (xlsx/docx) shares
// the zip signature, so the extension picks the label. Text types (csv/json/…)
// have no signature — accepted via a UTF-8 check keyed on these extensions.
const DATA_EXT_MIME: Record<string, string> = {
  ".zip": "application/zip",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".parquet": "application/vnd.apache.parquet",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  // SVG is XML text — providers don't accept it as vision input, so it's a
  // data file the agent reads as markup (and the web renders inline).
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

const TEXT_DATA_EXTS = new Set([
  ".csv",
  ".tsv",
  ".json",
  ".txt",
  ".md",
  ".svg",
  ".xml",
  ".yaml",
  ".yml",
]);

export interface PendingEntry {
  pendingId: string;
  /** absolute path to the file under <attachmentsRoot>/__pending__/<id>/<name> */
  absPath: string;
  filename: string;
  kind: AttachmentKind;
  mediaType: string;
  size: number;
  createdAt: number;
}

/**
 * Sniff mime type by magic bytes — browser-supplied `file.type` is a UA
 * hint we don't trust.
 */
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

// zip local-file/empty/spanned headers all start `PK` then 03/05/07 04/06/08.
function isZipSig(h: Buffer): boolean {
  return (
    h.length >= 4 &&
    h[0] === 0x50 &&
    h[1] === 0x4b &&
    (h[2] === 0x03 || h[2] === 0x05 || h[2] === 0x07) &&
    (h[3] === 0x04 || h[3] === 0x06 || h[3] === 0x08)
  );
}

function isParquetSig(h: Buffer): boolean {
  // "PAR1" magic (present at both ends of a parquet file).
  return (
    h.length >= 4 &&
    h[0] === 0x50 &&
    h[1] === 0x41 &&
    h[2] === 0x52 &&
    h[3] === 0x31
  );
}

// Text has no magic bytes — accept only if it decodes cleanly as UTF-8 and
// carries no NUL (binaries do; text doesn't). Caps the sniff at 4KB.
function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  if (sample.includes(0x00)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an upload to its kind + label mediaType, or null if unsupported.
 * Trust comes from the bytes (sniff / UTF-8 check), never the filename — the
 * extension only labels and policy-gates an already-validated file.
 * Exported for unit tests.
 */
export function resolveUpload(
  filename: string,
  bytes: Buffer
): { kind: AttachmentKind; mediaType: string } | null {
  const head = bytes.subarray(0, 16);

  // Model-native: image / pdf, confirmed by signature.
  const sniffed = sniffMime(head);
  if (sniffed && ALLOWED_MIME[sniffed]) {
    return { kind: ALLOWED_MIME[sniffed]!, mediaType: sniffed };
  }

  const ext = path.extname(filename).toLowerCase();

  // Data binary: zip-family (label by extension) + parquet.
  if (isZipSig(head)) {
    return { kind: "data", mediaType: DATA_EXT_MIME[ext] ?? "application/zip" };
  }
  if (isParquetSig(head)) {
    return { kind: "data", mediaType: "application/vnd.apache.parquet" };
  }

  // Data text: UTF-8 + extension allowlist.
  if (TEXT_DATA_EXTS.has(ext) && looksLikeText(bytes)) {
    return { kind: "data", mediaType: DATA_EXT_MIME[ext]! };
  }

  return null;
}

/** Human-readable accepted-types list for reject messages + UI hints. */
export const ACCEPTED_UPLOAD_TYPES = [
  ...Object.keys(ALLOWED_MIME),
  ...Object.keys(DATA_EXT_MIME),
];

function sanitizeBasename(name: string): string {
  const base = name.replace(/[\\/\x00]/g, "_").replace(/^\.+/, "");
  if (!base || base === "." || base === "..") return "file";
  return base.length > 200 ? base.slice(0, 200) : base;
}

export interface UploadsContext {
  /** pendingId → on-disk metadata; used by /api/chat to commit + rewrite URL. */
  pending: Map<string, PendingEntry>;
  attachmentsRoot: string;
  pendingRoot: string;
  /**
   * Move a pending file under the session's directory and remove it from
   * the pending map. Returns the committed `/api/attachments/<...>` URL,
   * or null if the pendingId is unknown.
   */
  commit(pendingId: string, sessionId: string): {
    url: string;
    filename: string;
    mediaType: string;
    kind: AttachmentKind;
    size: number;
  } | null;
}

/**
 * Register `/api/uploads` (multipart upload to a pending area) and
 * `/api/attachments/:sessionId/:attachmentId/:filename` (static-file
 * serving from disk). The pending file is moved under the real session
 * dir at chat-send time by `commit()`.
 *
 * No DB sidecar — the URL alone resolves to disk: `/api/attachments/`
 * concat with `<sessionId>/<attId>/<filename>` is the relative path
 * under `<attachmentsRoot>`.
 */
export function registerUploadsRoutes(
  app: Hono,
  manager: AgentManager
): UploadsContext {
  const attachmentsRoot = manager.attachmentsRoot;
  const pendingRoot = path.join(attachmentsRoot, "__pending__");
  const pending = new Map<string, PendingEntry>();

  // Boot-time sweep: anything left over from a previous process is gone.
  try {
    fs.rmSync(pendingRoot, { recursive: true, force: true });
  } catch (e) {
    log.error({ err: e, dir: pendingRoot }, "failed to clear pending dir");
  }
  try {
    fs.mkdirSync(pendingRoot, { recursive: true });
  } catch (e) {
    log.error({ err: e, dir: pendingRoot }, "failed to create pending dir");
  }

  // TTL sweep every 5 min.
  const sweepHandle = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of pending) {
      if (now - entry.createdAt < PENDING_TTL_MS) continue;
      pending.delete(id);
      try {
        fs.rmSync(path.dirname(entry.absPath), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }, 5 * 60 * 1000);
  if (typeof sweepHandle.unref === "function") sweepHandle.unref();

  app.post("/api/uploads", async (c) => {
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: "Expected multipart/form-data" }, 400);
    }

    const files: File[] = [];
    for (const value of Object.values(form)) {
      const arr = Array.isArray(value) ? value : [value];
      for (const v of arr) {
        if (v instanceof File) files.push(v);
      }
    }
    if (files.length === 0) return c.json({ error: "No files in upload" }, 400);
    if (files.length > MAX_FILES) {
      return c.json({ error: `Too many files (max ${MAX_FILES})` }, 400);
    }

    const created: Array<{
      pendingId: string;
      kind: AttachmentKind;
      mediaType: string;
      size: number;
      filename: string;
      url: string;
    }> = [];

    let totalBytes = 0;
    for (const f of files) {
      const bytes = Buffer.from(await f.arrayBuffer());
      const resolved = resolveUpload(f.name, bytes);
      if (!resolved) {
        return c.json(
          {
            error: `File '${f.name}' has unsupported type`,
            allowed: ACCEPTED_UPLOAD_TYPES,
          },
          400
        );
      }
      const cap =
        resolved.kind === "data" ? MAX_DATA_FILE_BYTES : MAX_FILE_BYTES;
      if (f.size > cap) {
        return c.json(
          { error: `File '${f.name}' exceeds ${cap} bytes` },
          413
        );
      }
      totalBytes += f.size;
      if (totalBytes > MAX_REQUEST_BYTES) {
        return c.json(
          { error: `Upload exceeds ${MAX_REQUEST_BYTES} bytes` },
          413
        );
      }
      const pendingId = `pend_${randomUUID()}`;
      const safeName = sanitizeBasename(f.name);
      const dir = path.join(pendingRoot, pendingId);
      const abs = path.join(dir, safeName);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(abs, bytes);
      } catch (e) {
        return c.json(
          {
            error: `Failed to write upload: ${
              e instanceof Error ? e.message : String(e)
            }`,
          },
          500
        );
      }
      const entry: PendingEntry = {
        pendingId,
        absPath: abs,
        filename: safeName,
        kind: resolved.kind,
        mediaType: resolved.mediaType,
        size: f.size,
        createdAt: Date.now(),
      };
      pending.set(pendingId, entry);
      // Pending URL — the client uses this in the FileUIPart it sends
      // back to /api/chat. The chat handler's `commit` rewrites it to
      // the real /api/attachments/<sessionId>/<attId>/<filename> form
      // before persisting the message.
      created.push({
        pendingId,
        kind: entry.kind,
        mediaType: entry.mediaType,
        size: entry.size,
        filename: entry.filename,
        url: `/api/attachments/__pending__/${pendingId}/${safeName}`,
      });
    }

    return c.json({ attachments: created });
  });

  // Static-style serve. `:filename` is the last path segment of the URL
  // we wrote into the FileUIPart — round-trips against disk under
  // <attachmentsRoot>/<sessionId>/<attachmentId>/<filename>. Pending
  // attachments (sessionId === "__pending__") use the same path layout.
  app.get(
    "/api/attachments/:sessionId/:attachmentId/:filename",
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const attachmentId = c.req.param("attachmentId");
      const filename = c.req.param("filename");
      const rel = path.join(sessionId, attachmentId, filename);
      const abs = path.resolve(path.join(attachmentsRoot, rel));
      if (!abs.startsWith(path.resolve(attachmentsRoot) + path.sep)) {
        return c.json({ error: "Path escapes root" }, 400);
      }
      // `?preview=1` returns structured preview data (size + zip entries for a
      // file tree, raw text head for csv/json/…, or a note for xlsx/parquet)
      // instead of bytes — so the web renders a real preview for data files it
      // can't parse itself. One request carries size too (file parts don't).
      if (c.req.query("preview")) {
        try {
          const mediaType =
            DATA_EXT_MIME[path.extname(filename).toLowerCase()] ?? null;
          const size = fs.statSync(abs).size;
          if (mediaType === "application/zip") {
            return c.json({ size, mediaType, entries: listZipEntries(abs) });
          }
          if (
            mediaType ===
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          ) {
            const { sheets, rows } = readSpreadsheetPreview(abs);
            return c.json({ size, mediaType, sheets, rows });
          }
          if (mediaType && TEXT_DATA_EXTS.has(path.extname(filename).toLowerCase())) {
            const fd = fs.openSync(abs, "r");
            try {
              const buf = Buffer.alloc(65536);
              const read = fs.readSync(fd, buf, 0, buf.length, 0);
              return c.json({
                size,
                mediaType,
                text: buf.subarray(0, read).toString("utf-8"),
              });
            } finally {
              fs.closeSync(fd);
            }
          }
          return c.json({
            size,
            mediaType,
            preview: previewDataAttachment(
              abs,
              mediaType ?? "application/octet-stream"
            ),
          });
        } catch {
          return c.json({ preview: null });
        }
      }
      return serveFileWithRange(c, abs, filename);
    }
  );

  return {
    pending,
    attachmentsRoot,
    pendingRoot,
    commit(pendingId, sessionId) {
      const entry = pending.get(pendingId);
      if (!entry) return null;
      const newAttId = `att_${randomUUID()}`;
      const destDir = path.join(attachmentsRoot, sessionId, newAttId);
      const destAbs = path.join(destDir, entry.filename);
      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(entry.absPath, destAbs);
        // Rename leaves the pending dir empty — clean up.
        try {
          fs.rmdirSync(path.dirname(entry.absPath));
        } catch {
          // best-effort
        }
      } catch (e) {
        log.error({ err: e, pendingId }, "failed to commit attachment");
        // Leave the pending entry in place; sweeper will eventually
        // clean it up. Caller falls back to surfacing an error.
        return null;
      }
      pending.delete(pendingId);
      return {
        url: `/api/attachments/${sessionId}/${newAttId}/${entry.filename}`,
        filename: entry.filename,
        mediaType: entry.mediaType,
        kind: entry.kind,
        size: entry.size,
      };
    },
  };
}
