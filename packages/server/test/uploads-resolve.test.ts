import { describe, expect, it } from "vitest";
import { resolveUpload } from "../src/routes/uploads.js";

// Magic-byte heads for the binary formats the gate sniffs.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from("%PDF-1.7\n");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const PARQUET = Buffer.from("PAR1____");

describe("resolveUpload", () => {
  it("keeps image/pdf as model-native kinds", () => {
    expect(resolveUpload("pic.png", PNG)).toEqual({
      kind: "image",
      mediaType: "image/png",
    });
    expect(resolveUpload("doc.pdf", PDF)).toEqual({
      kind: "file",
      mediaType: "application/pdf",
    });
  });

  it("treats zip-family as data, labelled by extension", () => {
    expect(resolveUpload("code.zip", ZIP)).toEqual({
      kind: "data",
      mediaType: "application/zip",
    });
    expect(resolveUpload("sheet.xlsx", ZIP)).toEqual({
      kind: "data",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    // PK bytes with an unknown extension still resolve to a generic zip.
    expect(resolveUpload("mystery", ZIP)?.mediaType).toBe("application/zip");
  });

  it("recognizes parquet by signature", () => {
    expect(resolveUpload("data.parquet", PARQUET)).toEqual({
      kind: "data",
      mediaType: "application/vnd.apache.parquet",
    });
  });

  it("accepts text formats via UTF-8 + extension allowlist", () => {
    const csv = Buffer.from("name,age\nalice,30\n");
    expect(resolveUpload("rows.csv", csv)).toEqual({
      kind: "data",
      mediaType: "text/csv",
    });
    const json = Buffer.from('{"a":1}');
    expect(resolveUpload("x.json", json)?.mediaType).toBe("application/json");
  });

  it("classifies svg as data, not a model-native image", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(resolveUpload("logo.svg", svg)).toEqual({
      kind: "data",
      mediaType: "image/svg+xml",
    });
  });

  it("rejects a binary blob renamed to a text extension", () => {
    const blob = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    expect(resolveUpload("evil.csv", blob)).toBeNull();
  });

  it("rejects unsupported types (text with a non-allowlisted extension)", () => {
    const html = Buffer.from("<html></html>");
    expect(resolveUpload("page.html", html)).toBeNull();
  });
});
