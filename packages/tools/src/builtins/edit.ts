import { z } from 'zod';
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { registry } from "../registry.js";
import { lock } from "../internal/lock.js";
import { getCurrentWorkspaceDir } from "../session-context.js";

type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

const LineTrimmedReplacer: Replacer = function* (content, find) {
  const original = content.split("\n");
  const search = find.split("\n");
  if (search[search.length - 1] === "") search.pop();

  for (let i = 0; i <= original.length - search.length; i++) {
    let ok = true;
    for (let j = 0; j < search.length; j++) {
      if (original[i + j]!.trim() !== search[j]!.trim()) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    let start = 0;
    for (let k = 0; k < i; k++) start += original[k]!.length + 1;
    let end = start;
    for (let k = 0; k < search.length; k++) {
      end += original[i + k]!.length;
      if (k < search.length - 1) end += 1;
    }
    yield content.substring(start, end);
  }
};

// Match by first+last line anchors with a similarity check on middle content.
// Recovers cases where the model dropped or reformatted middle lines but
// preserved the surrounding scaffolding.
const BlockAnchorReplacer: Replacer = function* (content, find) {
  const original = content.split("\n");
  const search = find.split("\n");
  if (search.length < 3) return;
  if (search[search.length - 1] === "") search.pop();

  const firstSearch = search[0]!.trim();
  const lastSearch = search[search.length - 1]!.trim();

  for (let i = 0; i < original.length; i++) {
    if (original[i]!.trim() !== firstSearch) continue;
    for (let j = i + 2; j < original.length; j++) {
      if (original[j]!.trim() !== lastSearch) continue;

      const blockSize = j - i + 1;
      if (blockSize !== search.length) {
        break;
      }

      let matchingMiddle = 0;
      let totalMiddle = 0;
      for (let k = 1; k < search.length - 1; k++) {
        const o = original[i + k]!.trim();
        const s = search[k]!.trim();
        if (o.length > 0 || s.length > 0) {
          totalMiddle++;
          if (o === s) matchingMiddle++;
        }
      }

      if (totalMiddle === 0 || matchingMiddle / totalMiddle >= 0.5) {
        let start = 0;
        for (let k = 0; k < i; k++) start += original[k]!.length + 1;
        let end = start;
        for (let k = i; k <= j; k++) {
          end += original[k]!.length;
          if (k < j) end += 1;
        }
        yield content.substring(start, end);
      }
      break;
    }
  }
};

const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = norm(find);
  const findLines = find.split("\n");

  if (findLines.length === 1) {
    const lines = content.split("\n");
    for (const line of lines) {
      if (norm(line) === target) yield line;
    }
    return;
  }

  const lines = content.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (norm(block) === target) yield block;
  }
};

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function applyLineEnding(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\n" ? text : text.replaceAll("\n", "\r\n");
}

const BOM = "﻿";

function splitBom(text: string): { text: string; bom: boolean } {
  if (text.startsWith(BOM)) return { text: text.slice(1), bom: true };
  return { text, bom: false };
}

export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (oldString === newString) {
    throw new Error("oldString and newString are identical — no change to apply.");
  }

  const cascade: Replacer[] = [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
  ];

  let foundAny = false;

  for (const replacer of cascade) {
    for (const candidate of replacer(content, oldString)) {
      const idx = content.indexOf(candidate);
      if (idx === -1) continue;
      foundAny = true;

      if (replaceAll) {
        return content.replaceAll(candidate, newString);
      }

      const last = content.lastIndexOf(candidate);
      if (idx !== last) continue;

      return content.slice(0, idx) + newString + content.slice(idx + candidate.length);
    }
  }

  if (!foundAny) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
    );
  }
  throw new Error(
    "Found multiple matches for oldString. Provide more surrounding context to make the match unique, or set replaceAll=true.",
  );
}

registry.register({
  name: "edit",
  toolset: "filesystem",
  runtime: "worker",
  description:
    "Edit a single file by replacing oldString with newString. Faster than apply_patch for small targeted changes. " +
    "If oldString is empty and the file does not exist, the file is created with newString as its content. " +
    "If multiple matches exist, supply more surrounding context or set replaceAll=true.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative path to the file"),
    oldString: z.string().describe("Exact text to replace (empty to create a new file)"),
    newString: z.string().describe("Replacement text"),
    replaceAll: z
      .boolean()
      .optional()
      .default(false)
      .describe("Replace every occurrence of oldString instead of requiring a unique match"),
  }),
  emoji: "✏️",
  parallelSafe: false,
  handler: async (args) => {
    const { path: filePath, oldString, newString, replaceAll } = args as {
      path: string;
      oldString: string;
      newString: string;
      replaceAll: boolean;
    };

    if (oldString === newString) {
      return JSON.stringify({
        error: "oldString and newString are identical — no change to apply.",
      });
    }

    const baseCwd = getCurrentWorkspaceDir() ?? process.cwd();
    const resolved = path.resolve(baseCwd, filePath);

    return lock(resolved, async () => {
      let exists = true;
      try {
        await fs.access(resolved);
      } catch {
        exists = false;
      }

      if (oldString === "") {
        if (exists) {
          return JSON.stringify({
            error: `File already exists: ${resolved}. Use a non-empty oldString to edit it.`,
          });
        }
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, newString, "utf-8");
        return JSON.stringify({
          success: true,
          path: resolved,
          mode: "created",
          bytesWritten: Buffer.byteLength(newString),
        });
      }

      if (!exists) {
        return JSON.stringify({ error: `File not found: ${resolved}` });
      }

      const raw = await fs.readFile(resolved, "utf-8");
      const split = splitBom(raw);
      const ending = detectLineEnding(split.text);
      const normalizedSource = normalizeLineEndings(split.text);
      const normalizedOld = normalizeLineEndings(oldString);
      const normalizedNew = normalizeLineEndings(newString);

      let updated: string;
      try {
        updated = replace(normalizedSource, normalizedOld, normalizedNew, replaceAll);
      } catch (error) {
        return JSON.stringify({ error: (error as Error).message });
      }

      const final = (split.bom ? BOM : "") + applyLineEnding(updated, ending);
      await fs.writeFile(resolved, final, "utf-8");

      return JSON.stringify({
        success: true,
        path: resolved,
        mode: "edited",
        bytesWritten: Buffer.byteLength(final),
      });
    });
  },
});
