import * as fs from "node:fs";
import * as path from "node:path";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import {
  convertToModelMessages,
  type UIMessage,
  type ModelMessage,
  type ToolSet,
} from "ai";

/**
 * Local URL contract: `/api/attachments/<sessionId>/<attachmentId>/<filename>`.
 * The path round-trips to a relative path under <dataDir>/attachments — no
 * sidecar table required to look up where on disk an attachment lives.
 */
const ATTACHMENT_URL_RE = /^\/api\/attachments\/([^/]+)\/([^/]+)\/(.+)$/;

/** Parse an `/api/attachments/<...>` URL into a relative path under the
 *  attachments root. Returns null for any other URL shape (`data:`, http,
 *  etc) so callers know to pass through. */
export function parseAttachmentUrl(url: string): string | null {
  const m = url.match(ATTACHMENT_URL_RE);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

/** Media a provider ingests natively — inlined as `data:` bytes. Everything
 *  else attached is a "data" file the agent reads off disk via its tools.
 *  SVG is `image/*` but providers reject it as vision input, so it's read as
 *  the XML text it is. */
function isModelNativeMedia(mediaType: string): boolean {
  if (mediaType === "image/svg+xml") return false;
  return mediaType.startsWith("image/") || mediaType === "application/pdf";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const XLSX_MEDIA =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MEDIA =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface ZipEntry {
  path: string;
  size: number;
}

/** Filtered, capped zip entry listing (central directory only — bomb-safe).
 *  Drops macOS Finder cruft (`__MACOSX/`, `._*`, `.DS_Store`). Shared by the
 *  agent-facing text preview and the web's file-tree render. */
export function listZipEntries(abs: string, limit = 500): ZipEntry[] {
  const out: ZipEntry[] = [];
  for (const e of new AdmZip(abs).getEntries()) {
    if (e.isDirectory) continue;
    const base = e.entryName.split("/").pop() ?? "";
    if (e.entryName.startsWith("__MACOSX/")) continue;
    if (base === ".DS_Store" || base.startsWith("._")) continue;
    out.push({ path: e.entryName, size: e.header.size });
    if (out.length >= limit) break;
  }
  return out;
}

export interface SpreadsheetPreview {
  sheets: string[];
  /** First sheet, first rows × cols (capped) as strings. */
  rows: string[][];
}

/** Real spreadsheet preview via SheetJS — sheet names + the first cells of the
 *  first sheet. Capped so a huge workbook stays cheap. */
export function readSpreadsheetPreview(
  abs: string,
  maxRows = 12,
  maxCols = 12
): SpreadsheetPreview {
  // Read the buffer ourselves — XLSX.readFile needs fs wired up under ESM.
  const wb = XLSX.read(fs.readFileSync(abs), { type: "buffer", sheetRows: maxRows });
  const sheets = wb.SheetNames;
  const first = sheets[0] ? wb.Sheets[sheets[0]] : undefined;
  const rows: string[][] = first
    ? (
        XLSX.utils.sheet_to_json(first, {
          header: 1,
          blankrows: false,
          defval: "",
          raw: false,
        }) as unknown[][]
      )
        .slice(0, maxRows)
        .map((r) => r.slice(0, maxCols).map((c) => String(c ?? "")))
    : [];
  return { sheets, rows };
}

function previewXlsx(abs: string): string {
  try {
    const { sheets, rows } = readSpreadsheetPreview(abs, 8, 8);
    const head = `Sheets (${sheets.length}): ${sheets.join(", ")}`;
    if (!rows.length) return head;
    const table = rows.map((r) => `  ${r.join(" | ")}`).join("\n");
    return `${head}\nFirst sheet "${sheets[0]}":\n${table}`;
  } catch {
    return "(xlsx — read cells with execute_code: pandas/openpyxl)";
  }
}

function previewDocx(abs: string): string {
  const doc = new AdmZip(abs).getEntry("word/document.xml");
  if (!doc) return "(docx — read with execute_code: python-docx)";
  const text = doc
    .getData()
    .toString("utf-8")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "(docx — read with execute_code: python-docx)";
  return `Preview:\n${text.slice(0, 500)}${text.length > 500 ? " ..." : ""}`;
}

/** A short, model-facing preview of a data file. Cheap + bomb-safe: zip/office
 *  read central-directory + small XML entries only (never decompress payloads),
 *  text reads a 4KB head. Exported so the web can show the same preview. */
export function previewDataAttachment(abs: string, mediaType: string): string {
  try {
    if (mediaType === "application/zip") {
      const entries = listZipEntries(abs);
      const shown = entries
        .slice(0, 50)
        .map((e) => `  ${e.path} (${formatBytes(e.size)})`);
      const tail =
        entries.length > 50 ? `\n  ... ${entries.length - 50} more` : "";
      return `Contents (zip, ${entries.length} entries):\n${shown.join("\n")}${tail}`;
    }
    if (mediaType === XLSX_MEDIA) return previewXlsx(abs);
    if (mediaType === DOCX_MEDIA) return previewDocx(abs);
    if (mediaType === "application/vnd.apache.parquet") {
      return "(parquet — read with execute_code: pandas/pyarrow)";
    }
    // Text-ish (csv/tsv/json/txt/md): first ~4KB / 30 lines.
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.alloc(4096);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, read).toString("utf-8");
      const lines = head.split("\n").slice(0, 30);
      const truncated = read === buf.length || head.split("\n").length > 30;
      return `Preview:\n${lines.join("\n")}${truncated ? "\n  ..." : ""}`;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "(preview unavailable)";
  }
}

/**
 * Most providers can't reach `127.0.0.1` URLs, so before handing
 * UIMessages to `convertToModelMessages` we walk every FileUIPart whose
 * URL is one of ours and either inline the bytes (model-native media) or
 * replace the part with a descriptor the agent acts on (data files).
 *
 * - Model-native (image / pdf): bytes inlined as a `data:` URL.
 * - Data files (zip / csv / xlsx / …): NOT sent to the provider — replaced
 *   by a text part carrying the file's absolute on-disk path + a preview, so
 *   the agent reads it with its tools (`read_file` / `shell` / `execute_code`).
 * - Other URLs (already-data, external https) pass through unchanged.
 * - Missing files yield a placeholder text part — the message still sends.
 */
export function inlineFileAttachments(
  messages: UIMessage[],
  attachmentsRoot: string
): UIMessage[] {
  // Only the newest user message previews its data files — it's where the model
  // first sees them. Earlier turns keep a lean path reference so we don't
  // re-parse every attached file in history on every turn.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return messages.map((m, idx) => ({
    ...m,
    parts: m.parts.map((p) => {
      if (p.type !== "file") return p;
      const rel = parseAttachmentUrl(p.url);
      if (!rel) return p;
      const abs = path.join(attachmentsRoot, rel);
      const name = p.filename ?? path.basename(rel);
      if (!isModelNativeMedia(p.mediaType)) {
        try {
          const size = fs.statSync(abs).size;
          if (idx !== lastUserIdx) {
            return {
              type: "text" as const,
              text: `[Attached file: ${name} (${formatBytes(size)}) — ${abs}]`,
            };
          }
          const preview = previewDataAttachment(abs, p.mediaType);
          return {
            type: "text" as const,
            text:
              `[Attached file: ${name} (${formatBytes(size)}) — ${abs}\n` +
              `${preview}\n` +
              `Read it with your tools (read_file / shell / execute_code).]`,
          };
        } catch {
          return {
            type: "text" as const,
            text: `[attachment unavailable: ${name}]`,
          };
        }
      }
      try {
        const bytes = fs.readFileSync(abs);
        return {
          ...p,
          url: `data:${p.mediaType};base64,${bytes.toString("base64")}`,
        };
      } catch {
        return {
          type: "text" as const,
          text: `[attachment unavailable: ${name}]`,
        };
      }
    }),
  }));
}

/**
 * A `tool-${name}` part stuck in `input-streaming` or `input-available`
 * is an aborted tool call — model emitted the call but the result never
 * arrived (user hit Stop, request timed out, etc). Sending it to the
 * provider unchanged trips the tool_use/tool_result pairing check.
 *
 * Rewrite it to `output-error` so `convertToModelMessages` emits the
 * matching tool-result with an interrupt marker the model can see.
 */
const INTERRUPT_MARKER = "[interrupted]";
export function finalizeOrphanToolParts(
  parts: UIMessage["parts"]
): UIMessage["parts"] {
  return parts.map((p) => {
    const tp = p as { type?: string; state?: string };
    if (!tp.type?.startsWith("tool-")) return p;
    if (tp.state !== "input-streaming" && tp.state !== "input-available") return p;
    return {
      ...(p as object),
      state: "output-error",
      errorText: INTERRUPT_MARKER,
    } as UIMessage["parts"][number];
  });
}

/**
 * Inject `step-start` parts before any text that follows a tool part
 * without one already present. `convertToModelMessages` uses
 * `step-start` as the split marker; without it, an assistant message
 * shaped `[text, tool, text]` collapses into a single model assistant
 * message and Anthropic rejects with "tool_use ... without tool_result
 * blocks immediately after" because the post-tool text means the model
 * "continued without waiting."
 *
 * Idempotent: pre-existing step-start parts are preserved and reset
 * the "needs boundary" flag.
 */
export function ensureStepBoundaries(
  parts: UIMessage["parts"]
): UIMessage["parts"] {
  const out: UIMessage["parts"] = [];
  let unbalancedTool = false;
  for (const p of parts) {
    const tp = p as { type?: string };
    if (tp.type === "step-start") {
      out.push(p);
      unbalancedTool = false;
      continue;
    }
    if (tp.type === "text" && unbalancedTool) {
      out.push({ type: "step-start" } as UIMessage["parts"][number]);
      unbalancedTool = false;
    }
    out.push(p);
    if (tp.type?.startsWith("tool-")) {
      unbalancedTool = true;
    }
  }
  return out;
}

/**
 * Apply `finalizeOrphanToolParts` + `ensureStepBoundaries` to each
 * message in a stored-history list. Handles legacy DB rows (process
 * crashed mid-tool, abort path that pre-dated this fix, CLI assembly
 * path that pre-dated step-start support, etc.) so the rendered +
 * replayed view is always pair-consistent without mutating disk.
 *
 * Generic over the row shape so callers don't have to widen their
 * `StoredUIMessage` to a full `UIMessage`.
 */
export function sanitizeStoredHistory<M extends { parts: unknown[] }>(
  messages: M[]
): M[] {
  return messages.map((m) => ({
    ...m,
    parts: ensureStepBoundaries(
      finalizeOrphanToolParts(m.parts as UIMessage["parts"])
    ) as unknown[],
  }));
}

// Prepend `modelContent` from any `data-relevant-memory` parts on user
// messages as a leading text part — the SDK strips `data-*` so without
// this the recall never reaches the model. Bytes pre-rendered at recall
// time stay byte-stable across turns → prefix cache hits.
function materializeRecallContext(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.parts)) return m;
    const recallTexts: string[] = [];
    const otherParts: UIMessage["parts"] = [];
    for (const p of m.parts) {
      if ((p as { type?: unknown }).type === "data-relevant-memory") {
        const content = (p as { data?: { modelContent?: unknown } }).data
          ?.modelContent;
        if (typeof content === "string" && content.length > 0) {
          recallTexts.push(content);
        }
      } else {
        otherParts.push(p);
      }
    }
    if (recallTexts.length === 0) return m;
    const leadingText = {
      type: "text" as const,
      text: recallTexts.join("\n\n"),
    } as UIMessage["parts"][number];
    return { ...m, parts: [leadingText, ...otherParts] };
  });
}

// Materialize the ambient-Acme view snapshot (`data-ui-context`). Unlike
// recall, only the LATEST user message's snapshot reaches the model — the view
// is "where the user is right now"; replaying an older snapshot would mislead
// (Acme may have edited it since) and bloat the turn. The part is stripped from
// every message either way (the SDK drops `data-*` anyway; this also keeps the
// stale snapshots out before conversion).
function materializeUiContext(messages: UIMessage[]): UIMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return messages.map((m, i) => {
    if (!Array.isArray(m.parts)) return m;
    const hasUiCtx = m.parts.some(
      (p) => (p as { type?: unknown }).type === "data-ui-context"
    );
    if (!hasUiCtx) return m;
    const otherParts = m.parts.filter(
      (p) => (p as { type?: unknown }).type !== "data-ui-context"
    );
    if (i === lastUserIdx) {
      const texts: string[] = [];
      for (const p of m.parts) {
        if ((p as { type?: unknown }).type !== "data-ui-context") continue;
        const content = (p as { data?: { modelContent?: unknown } }).data
          ?.modelContent;
        if (typeof content === "string" && content.length > 0) texts.push(content);
      }
      if (texts.length > 0) {
        const leadingText = {
          type: "text" as const,
          text: texts.join("\n\n"),
        } as UIMessage["parts"][number];
        return { ...m, parts: [leadingText, ...otherParts] };
      }
    }
    return { ...m, parts: otherParts };
  });
}

// Prepend `modelContent` from any `data-skill-ref` parts on user messages as a
// leading text part — the SDK strips `data-*` so without this the marker never
// reaches the model. Per-message (not latest-only): a skill referenced in an
// earlier turn may still apply, and the marker is one short line.
function materializeSkillRef(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.parts)) return m;
    const markers: string[] = [];
    const otherParts: UIMessage["parts"] = [];
    for (const p of m.parts) {
      if ((p as { type?: unknown }).type === "data-skill-ref") {
        const content = (p as { data?: { modelContent?: unknown } }).data
          ?.modelContent;
        if (typeof content === "string" && content.length > 0) {
          markers.push(content);
        }
      } else {
        otherParts.push(p);
      }
    }
    if (markers.length === 0) return m;
    const leadingText = {
      type: "text" as const,
      text: markers.join("\n\n"),
    } as UIMessage["parts"][number];
    return { ...m, parts: [leadingText, ...otherParts] };
  });
}

export async function uiToModelMessages(
  messages: UIMessage[],
  opts: { attachmentsRoot: string; tools?: ToolSet }
): Promise<ModelMessage[]> {
  const withRecall = materializeRecallContext(messages);
  const withSkills = materializeSkillRef(withRecall);
  const withUi = materializeUiContext(withSkills);
  const inlined = inlineFileAttachments(withUi, opts.attachmentsRoot);
  const sanitized = inlined.map((m) => ({
    ...m,
    parts: ensureStepBoundaries(finalizeOrphanToolParts(m.parts)),
  }));
  return convertToModelMessages(sanitized, { tools: opts.tools });
}

export const __test = {
  materializeRecallContext,
  materializeUiContext,
  materializeSkillRef,
};
