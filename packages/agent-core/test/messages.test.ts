import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import type { UIMessage } from "ai";
import {
  ensureStepBoundaries,
  finalizeOrphanToolParts,
  inlineFileAttachments,
  parseAttachmentUrl,
  listZipEntries,
  readSpreadsheetPreview,
} from "../src/messages.js";

describe("listZipEntries", () => {
  it("filters macOS Finder cruft and lists real files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-zip-"));
    const zipPath = path.join(tmp, "site.zip");
    const zip = new AdmZip();
    zip.addFile("site/app.js", Buffer.from("console.log(1)"));
    zip.addFile("site/style.css", Buffer.from("body{}"));
    zip.addFile("__MACOSX/site/._app.js", Buffer.from("x"));
    zip.addFile("site/.DS_Store", Buffer.from("x"));
    zip.writeZip(zipPath);

    const entries = listZipEntries(zipPath).map((e) => e.path).sort();
    expect(entries).toEqual(["site/app.js", "site/style.css"]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("readSpreadsheetPreview", () => {
  it("returns sheet names and first cells via SheetJS", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-xlsx-"));
    const xlsxPath = path.join(tmp, "people.xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["name", "age"],
        ["alice", 30],
      ]),
      "People"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["metric"]]),
      "Totals"
    );
    fs.writeFileSync(xlsxPath, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

    const { sheets, rows } = readSpreadsheetPreview(xlsxPath);
    expect(sheets).toEqual(["People", "Totals"]);
    expect(rows[0]).toEqual(["name", "age"]);
    expect(rows[1]).toEqual(["alice", "30"]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("parseAttachmentUrl", () => {
  it("parses /api/attachments/<session>/<id>/<file>", () => {
    expect(
      parseAttachmentUrl("/api/attachments/sess-1/att-2/shot.png")
    ).toBe("sess-1/att-2/shot.png");
  });

  it("preserves filenames with dots", () => {
    expect(
      parseAttachmentUrl("/api/attachments/s/a/has.many.dots.pdf")
    ).toBe("s/a/has.many.dots.pdf");
  });

  it("returns null for data: URLs", () => {
    expect(parseAttachmentUrl("data:image/png;base64,iVBOR")).toBe(null);
  });

  it("returns null for external URLs", () => {
    expect(parseAttachmentUrl("https://example.com/image.png")).toBe(null);
  });

  it("returns null for malformed paths missing segments", () => {
    expect(parseAttachmentUrl("/api/attachments/onlyone")).toBe(null);
    expect(parseAttachmentUrl("/api/attachments/")).toBe(null);
  });
});

describe("inlineFileAttachments", () => {
  it("rewrites local attachment URLs to data: URLs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-msg-"));
    const root = path.join(tmp, "attachments");
    const rel = "sess-1/att-1/pixel.png";
    fs.mkdirSync(path.join(root, "sess-1/att-1"), { recursive: true });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(path.join(root, rel), bytes);

    const input: UIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [
          { type: "text", text: "hi" },
          {
            type: "file",
            url: `/api/attachments/${rel}`,
            mediaType: "image/png",
            filename: "pixel.png",
          },
        ],
      },
    ];
    const out = inlineFileAttachments(input, root);
    expect(out[0]!.parts[0]).toEqual({ type: "text", text: "hi" });
    const filePart = out[0]!.parts[1] as { type: string; url: string };
    expect(filePart.type).toBe("file");
    expect(filePart.url.startsWith("data:image/png;base64,")).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes through non-attachment URLs unchanged", () => {
    const input: UIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [
          {
            type: "file",
            url: "https://example.com/x.png",
            mediaType: "image/png",
          },
        ],
      },
    ];
    const out = inlineFileAttachments(input, "/tmp/no-such-root");
    expect((out[0]!.parts[0] as { url: string }).url).toBe(
      "https://example.com/x.png"
    );
  });

  it("substitutes a placeholder text part when the file is missing", () => {
    const input: UIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [
          {
            type: "file",
            url: "/api/attachments/missing/missing/missing.png",
            mediaType: "image/png",
            filename: "missing.png",
          },
        ],
      },
    ];
    const out = inlineFileAttachments(input, "/tmp/nope");
    const part = out[0]!.parts[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("attachment unavailable");
    expect(part.text).toContain("missing.png");
  });

  it("replaces a data file with a path+preview descriptor (not inlined)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-msg-"));
    const root = path.join(tmp, "attachments");
    const rel = "sess-1/att-1/rows.csv";
    fs.mkdirSync(path.join(root, "sess-1/att-1"), { recursive: true });
    const abs = path.join(root, rel);
    fs.writeFileSync(abs, "name,age\nalice,30\nbob,40\n");

    const input: UIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [
          {
            type: "file",
            url: `/api/attachments/${rel}`,
            mediaType: "text/csv",
            filename: "rows.csv",
          },
        ],
      },
    ];
    const out = inlineFileAttachments(input, root);
    const part = out[0]!.parts[0] as { type: string; text: string };
    expect(part.type).toBe("text"); // not a file part — never sent to provider
    expect(part.text).toContain("rows.csv");
    expect(part.text).toContain(abs); // absolute on-disk path for the agent
    expect(part.text).toContain("name,age"); // preview head
    expect(part.text).not.toContain("data:"); // no base64 inlining

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("treats svg as a readable data file, not an inlined image", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-msg-"));
    const root = path.join(tmp, "attachments");
    const rel = "sess-1/att-1/logo.svg";
    fs.mkdirSync(path.join(root, "sess-1/att-1"), { recursive: true });
    fs.writeFileSync(
      path.join(root, rel),
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'
    );

    const input: UIMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [
          {
            type: "file",
            url: `/api/attachments/${rel}`,
            mediaType: "image/svg+xml",
            filename: "logo.svg",
          },
        ],
      },
    ];
    const out = inlineFileAttachments(input, root);
    const part = out[0]!.parts[0] as { type: string; text?: string };
    expect(part.type).toBe("text"); // not inlined as a data: image
    expect(part.text).toContain("logo.svg");
    expect(part.text).toContain("<svg"); // markup shown as preview

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("only previews data files in the most recent user message", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-msg-"));
    const root = path.join(tmp, "attachments");
    const rel = "sess-1/att-1/old.csv";
    fs.mkdirSync(path.join(root, "sess-1/att-1"), { recursive: true });
    fs.writeFileSync(path.join(root, rel), "col\nval\n");

    const fileParts = [
      {
        type: "file" as const,
        url: `/api/attachments/${rel}`,
        mediaType: "text/csv",
        filename: "old.csv",
      },
    ];
    const input: UIMessage[] = [
      { id: "m1", role: "user", parts: [...fileParts] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] },
      { id: "m2", role: "user", parts: [{ type: "text", text: "again" }] },
    ];
    const out = inlineFileAttachments(input, root);
    // m1 is no longer the latest user msg → lean reference, no preview head.
    const part = out[0]!.parts[0] as { type: string; text: string };
    expect(part.text).toContain("old.csv");
    expect(part.text).not.toContain("col\nval");

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("finalizeOrphanToolParts", () => {
  it("rewrites input-available to output-error with [interrupted]", () => {
    const parts: UIMessage["parts"] = [
      { type: "text", text: "hi" } as UIMessage["parts"][number],
      {
        type: "tool-shell",
        toolCallId: "c1",
        state: "input-available",
        input: { cmd: "ls" },
      } as unknown as UIMessage["parts"][number],
    ];
    const out = finalizeOrphanToolParts(parts) as Array<{
      type: string;
      state?: string;
      errorText?: string;
      toolCallId?: string;
    }>;
    expect(out[0]!.type).toBe("text");
    expect(out[1]!.state).toBe("output-error");
    expect(out[1]!.errorText).toBe("[interrupted]");
    expect(out[1]!.toolCallId).toBe("c1");
  });

  it("rewrites input-streaming the same way", () => {
    const parts: UIMessage["parts"] = [
      {
        type: "tool-shell",
        toolCallId: "c1",
        state: "input-streaming",
      } as unknown as UIMessage["parts"][number],
    ];
    const out = finalizeOrphanToolParts(parts) as Array<{ state?: string }>;
    expect(out[0]!.state).toBe("output-error");
  });

  it("leaves output-available untouched", () => {
    const parts: UIMessage["parts"] = [
      {
        type: "tool-shell",
        toolCallId: "c1",
        state: "output-available",
        input: {},
        output: "ok",
      } as unknown as UIMessage["parts"][number],
    ];
    const out = finalizeOrphanToolParts(parts) as Array<{
      state?: string;
      output?: string;
    }>;
    expect(out[0]!.state).toBe("output-available");
    expect(out[0]!.output).toBe("ok");
  });

  it("leaves output-error untouched", () => {
    const parts: UIMessage["parts"] = [
      {
        type: "tool-shell",
        toolCallId: "c1",
        state: "output-error",
        input: {},
        errorText: "boom",
      } as unknown as UIMessage["parts"][number],
    ];
    const out = finalizeOrphanToolParts(parts) as Array<{ errorText?: string }>;
    expect(out[0]!.errorText).toBe("boom");
  });

  it("leaves non-tool parts untouched", () => {
    const parts: UIMessage["parts"] = [
      { type: "text", text: "hi" } as UIMessage["parts"][number],
    ];
    expect(finalizeOrphanToolParts(parts)).toEqual(parts);
  });
});

describe("ensureStepBoundaries", () => {
  it("inserts step-start before text that follows a tool", () => {
    const parts: UIMessage["parts"] = [
      { type: "text", text: "pre" } as UIMessage["parts"][number],
      {
        type: "tool-shell",
        toolCallId: "c1",
        state: "output-available",
        input: {},
        output: "ok",
      } as unknown as UIMessage["parts"][number],
      { type: "text", text: "post" } as UIMessage["parts"][number],
    ];
    const out = ensureStepBoundaries(parts) as Array<{ type: string }>;
    expect(out.map((p) => p.type)).toEqual([
      "text",
      "tool-shell",
      "step-start",
      "text",
    ]);
  });

  it("preserves existing step-start and skips re-injection", () => {
    const parts: UIMessage["parts"] = [
      { type: "step-start" } as unknown as UIMessage["parts"][number],
      { type: "text", text: "pre" } as UIMessage["parts"][number],
      {
        type: "tool-shell",
        toolCallId: "c1",
        state: "output-available",
      } as unknown as UIMessage["parts"][number],
      { type: "step-start" } as unknown as UIMessage["parts"][number],
      { type: "text", text: "post" } as UIMessage["parts"][number],
    ];
    const out = ensureStepBoundaries(parts) as Array<{ type: string }>;
    expect(out.map((p) => p.type)).toEqual([
      "step-start",
      "text",
      "tool-shell",
      "step-start",
      "text",
    ]);
  });

  it("no-op when there's no tool", () => {
    const parts: UIMessage["parts"] = [
      { type: "text", text: "hi" } as UIMessage["parts"][number],
    ];
    expect(ensureStepBoundaries(parts)).toEqual(parts);
  });

  it("handles back-to-back tools without injecting between them", () => {
    const parts: UIMessage["parts"] = [
      {
        type: "tool-a",
        toolCallId: "c1",
        state: "output-available",
      } as unknown as UIMessage["parts"][number],
      {
        type: "tool-b",
        toolCallId: "c2",
        state: "output-available",
      } as unknown as UIMessage["parts"][number],
      { type: "text", text: "after" } as UIMessage["parts"][number],
    ];
    const out = ensureStepBoundaries(parts) as Array<{ type: string }>;
    expect(out.map((p) => p.type)).toEqual([
      "tool-a",
      "tool-b",
      "step-start",
      "text",
    ]);
  });
});

