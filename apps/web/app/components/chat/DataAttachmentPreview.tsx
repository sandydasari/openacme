import { useEffect, useState } from "react";
import { ChevronRight, Folder } from "lucide-react";
import { API_BASE } from "@/app/lib/api";
import { cn } from "@/app/lib/utils";
import { PierreFileIcon } from "@/app/components/chat/PierreFileIcon";
import { AttachmentChip } from "@/app/components/AttachmentChip";

interface Props {
  url: string;
  mediaType: string;
  filename: string;
}

interface ZipEntry {
  path: string;
  size: number;
}

interface PreviewResponse {
  size?: number;
  mediaType?: string | null;
  entries?: ZipEntry[]; // zip → file tree
  sheets?: string[]; // xlsx → sheet names
  rows?: string[][]; // xlsx → first sheet cells
  text?: string; // csv/json/txt/… → raw head
  preview?: string | null; // docx/parquet → note
}

const TABLE_TYPES = new Set(["text/csv", "text/tab-separated-values"]);

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function firstLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.length > n ? `${lines.slice(0, n).join("\n")}\n…` : text;
}

function prettyJson(text: string): string {
  try {
    return firstLines(JSON.stringify(JSON.parse(text), null, 2), 24);
  } catch {
    return firstLines(text, 16);
  }
}

// ── file tree (pierre-style) ──────────────────────────────────────────────
interface TreeNode {
  name: string;
  dir: boolean;
  size?: number;
  children: Map<string, TreeNode>;
}

function buildTree(entries: ZipEntry[]): TreeNode {
  const root: TreeNode = { name: "", dir: true, children: new Map() };
  for (const e of entries) {
    const parts = e.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((p, i) => {
      const leaf = i === parts.length - 1;
      let child = node.children.get(p);
      if (!child) {
        child = {
          name: p,
          dir: !leaf,
          size: leaf ? e.size : undefined,
          children: new Map(),
        };
        node.children.set(p, child);
      }
      node = child;
    });
  }
  return root;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) =>
    a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
  );
}

function TreeNodes({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <ul className="text-[11px] leading-relaxed">
      {sortedChildren(node).map((c) =>
        c.dir ? (
          <li key={c.name}>
            <details open={depth < 1}>
              <summary
                className="flex cursor-pointer list-none items-center gap-1 text-ink-soft marker:content-none hover:text-ink"
                style={{ paddingLeft: depth * 12 }}
              >
                <ChevronRight className="size-3 shrink-0 transition-transform [details[open]_&]:rotate-90" />
                <Folder className="size-3 shrink-0 text-plot-red/70" />
                <span className="truncate">{c.name}</span>
              </summary>
              <TreeNodes node={c} depth={depth + 1} />
            </details>
          </li>
        ) : (
          <li
            key={c.name}
            className="flex items-center gap-1 text-ink"
            style={{ paddingLeft: depth * 12 + 16 }}
          >
            <PierreFileIcon name={c.name} className="size-3.5" />
            <span className="truncate">{c.name}</span>
            <span className="ml-auto shrink-0 pl-2 font-mono text-ink-faint tabular-nums">
              {formatSize(c.size ?? 0)}
            </span>
          </li>
        )
      )}
    </ul>
  );
}

function CsvTable({ text, tsv }: { text: string; tsv: boolean }) {
  const sep = tsv ? "\t" : ",";
  const rows = text
    .split("\n")
    .filter((r) => r.trim().length > 0)
    .slice(0, 8)
    .map((r) => r.split(sep).slice(0, 8));
  return <RowsTable rows={rows} />;
}

function RowsTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return null;
  const [head, ...body] = rows;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {head!.map((cell, i) => (
              <th
                key={i}
                className="border border-paper-rule bg-paper-sunk px-1.5 py-0.5 text-left font-medium text-ink-soft"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {head!.map((_, ci) => (
                <td
                  key={ci}
                  className="border border-paper-rule px-1.5 py-0.5 text-ink tabular-nums"
                >
                  {r[ci] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A data-file attachment that shows a real preview, not a bland chip. One
 * `?preview=1` request returns the size plus the right shape: zip → file tree,
 * csv → table, json/text → code, xlsx/parquet → a note. Same data the agent
 * sees, rendered for the eye.
 */
export function DataAttachmentPreview({ url, mediaType, filename }: Props) {
  const full = `${API_BASE}${url}`;
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${full}?preview=1`);
        const j = (await res.json()) as PreviewResponse;
        if (alive) setData(j);
      } catch {
        /* leave null — header chip still renders */
      } finally {
        if (alive) setDone(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [full]);

  let preview: React.ReactNode = null;
  if (data?.entries) {
    preview = <TreeNodes node={buildTree(data.entries)} depth={0} />;
  } else if (data?.rows) {
    preview = (
      <div className="space-y-1">
        {data.sheets && data.sheets.length > 0 && (
          <div className="flex flex-wrap gap-1 text-[10px] text-ink-faint">
            {data.sheets.map((s, i) => (
              <span
                key={s}
                className={cn(
                  "border border-paper-rule px-1 py-px",
                  i === 0 && "bg-paper text-ink-soft"
                )}
              >
                {s}
              </span>
            ))}
          </div>
        )}
        <RowsTable rows={data.rows} />
      </div>
    );
  } else if (typeof data?.text === "string") {
    if (TABLE_TYPES.has(mediaType)) {
      preview = <CsvTable text={data.text} tsv={mediaType.includes("tab")} />;
    } else if (mediaType === "application/json") {
      preview = (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-snug text-ink">
          {prettyJson(data.text)}
        </pre>
      );
    } else {
      preview = (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-snug text-ink">
          {firstLines(data.text, 16)}
        </pre>
      );
    }
  } else if (data?.preview) {
    preview = (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-snug text-ink">
        {data.preview}
      </pre>
    );
  }

  return (
    <div className="max-w-full overflow-hidden border border-paper-rule bg-paper-sunk md:max-w-md">
      <div className="border-b border-paper-rule px-1.5 py-1">
        <AttachmentChip
          kind="data"
          mediaType={mediaType}
          size={data?.size ?? 0}
          name={filename}
          href={full}
        />
      </div>
      <div className="max-h-72 overflow-y-auto px-2 py-1.5 font-mono">
        {preview ??
          (done ? (
            <span className="text-[11px] text-ink-faint">
              No inline preview — open to view.
            </span>
          ) : (
            <span className="text-[11px] text-ink-faint">loading preview…</span>
          ))}
      </div>
    </div>
  );
}
