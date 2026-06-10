import { z } from 'zod';
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { registry } from "../registry.js";
import { lock } from "../internal/lock.js";
import { getCurrentWorkspaceDir } from "../session-context.js";
import {
  parsePatch,
  deriveNewContentsFromString,
  joinBom,
  type Hunk,
} from "../patch/parser.js";

interface StagedChange {
  type: "add" | "update" | "delete" | "move";
  path: string;
  movePath?: string;
  content?: string;
  bom?: boolean;
}

const BOM = "﻿";

function splitBom(text: string): { text: string; bom: boolean } {
  if (text.startsWith(BOM)) return { text: text.slice(1), bom: true };
  return { text, bom: false };
}

async function stage(
  hunks: Hunk[],
  cwd: string,
): Promise<StagedChange[]> {
  const staged: StagedChange[] = [];

  for (const hunk of hunks) {
    const target = path.resolve(cwd, hunk.path);

    switch (hunk.type) {
      case "add": {
        let exists = false;
        try {
          await fs.access(target);
          exists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        if (exists) {
          throw new Error(`Cannot add ${hunk.path}: file already exists`);
        }
        const content = hunk.contents.endsWith("\n")
          ? hunk.contents
          : hunk.contents + "\n";
        staged.push({ type: "add", path: target, content, bom: false });
        break;
      }

      case "delete": {
        try {
          await fs.access(target);
        } catch {
          throw new Error(`Cannot delete ${hunk.path}: file not found`);
        }
        staged.push({ type: "delete", path: target });
        break;
      }

      case "update": {
        let raw: string;
        try {
          raw = await fs.readFile(target, "utf-8");
        } catch {
          throw new Error(`Cannot update ${hunk.path}: file not found`);
        }
        const split = splitBom(raw);
        const update = deriveNewContentsFromString(
          split.text,
          target,
          hunk.chunks,
          split.bom,
        );
        const movePath = hunk.move_path
          ? path.resolve(cwd, hunk.move_path)
          : undefined;
        staged.push({
          type: movePath ? "move" : "update",
          path: target,
          movePath,
          content: update.content,
          bom: update.bom,
        });
        break;
      }
    }
  }

  return staged;
}

async function commit(staged: StagedChange[]): Promise<void> {
  for (const change of staged) {
    switch (change.type) {
      case "add":
        await fs.mkdir(path.dirname(change.path), { recursive: true });
        await fs.writeFile(change.path, joinBom(change.content!, change.bom!), "utf-8");
        break;
      case "update":
        await fs.writeFile(change.path, joinBom(change.content!, change.bom!), "utf-8");
        break;
      case "delete":
        await fs.unlink(change.path);
        break;
      case "move":
        await fs.mkdir(path.dirname(change.movePath!), { recursive: true });
        await fs.writeFile(
          change.movePath!,
          joinBom(change.content!, change.bom!),
          "utf-8",
        );
        await fs.unlink(change.path);
        break;
    }
  }
}

function summarize(staged: StagedChange[], cwd: string) {
  return staged.map((c) => ({
    type: c.type,
    path: path.relative(cwd, c.movePath ?? c.path) || c.movePath || c.path,
  }));
}

registry.register({
  name: "apply_patch",
  toolset: "filesystem",
  runtime: "worker",
  description:
    "Apply a multi-file V4A patch (the *** Begin Patch / *** Update File: format used by Codex/Anthropic Cookbook). " +
    "Supports add, update, delete, and move-with-edit in one atomic call: if any hunk fails to apply, no files are written.",
  parameters: z.object({
    patchText: z
      .string()
      .describe(
        "The patch envelope, including '*** Begin Patch' and '*** End Patch' markers.",
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        "Base directory for relative paths (default: your agent's workspace dir)"
      ),
  }),
  emoji: "🩹",
  parallelSafe: false,
  handler: async (args) => {
    const { patchText, cwd } = args as { patchText: string; cwd?: string };
    const baseCwd = getCurrentWorkspaceDir() ?? process.cwd();
    const baseDir = cwd ? path.resolve(cwd) : baseCwd;

    let hunks: Hunk[];
    try {
      hunks = parsePatch(patchText).hunks;
    } catch (error) {
      return JSON.stringify({
        error: `Patch parse error: ${(error as Error).message}`,
      });
    }

    if (hunks.length === 0) {
      return JSON.stringify({ error: "Patch contained no hunks" });
    }

    // Acquire a per-file lock for every path the patch touches (sorted to
    // avoid deadlock between concurrent apply_patch calls). The same lock
    // keys are used by `edit`, so concurrent edit + apply_patch on the same
    // file are properly serialized.
    const affected = new Set<string>();
    for (const h of hunks) {
      affected.add(path.resolve(baseDir, h.path));
      if (h.type === "update" && h.move_path) {
        affected.add(path.resolve(baseDir, h.move_path));
      }
    }
    const sortedKeys = [...affected].sort();

    const run = async (): Promise<string> => {
      let staged: StagedChange[];
      try {
        staged = await stage(hunks, baseDir);
      } catch (error) {
        return JSON.stringify({ error: (error as Error).message });
      }

      try {
        await commit(staged);
      } catch (error) {
        return JSON.stringify({
          error: `Patch partially applied — write failed: ${(error as Error).message}`,
        });
      }

      return JSON.stringify({
        success: true,
        files: summarize(staged, baseDir),
      });
    };

    // Nest locks: lock(k1, () => lock(k2, () => ... run())) — sequential
    // acquisition in sorted order keeps it deadlock-free.
    const acquire = sortedKeys.reduceRight<() => Promise<string>>(
      (inner, key) => () => lock(key, inner),
      run,
    );
    return acquire();
  },
});
