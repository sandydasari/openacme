/**
 * Post-turn extractor — safety net when the main agent didn't save to
 * memory itself. Forked subagent restricted to the memory tool. Never
 * throws; caller fires with `void`.
 */

import { stepCountIs } from "ai";
import type { UIMessage } from "ai";
import {
  formatMemoryManifest,
  scanMemoryFiles,
} from "@openacme/memory";
import type { Agent } from "./agent.js";
import { extractErrorText } from "./error-classifier.js";
import { runSubagent, type ForkedSubagentResult } from "./subagent.js";

const EXTRACTOR_STEP_CAP = 10;
const EXTRACTOR_TIMEOUT_MS = 120_000;
const EXTRACTOR_TOOLS = new Set(["memory"]);

export type ExtractorStatus =
  | "skipped-main-wrote"
  | "skipped-no-new-content"
  | "completed"
  | "timeout"
  | "aborted"
  | "failed";

export interface ExtractorResult {
  status: ExtractorStatus;
  fork?: ForkedSubagentResult;
  error?: string;
}

export interface RunExtractorArgs {
  agent: Agent;
  sessionId: string;
  sessionMessages: readonly UIMessage[];
  /** New-message count since the caller's extraction cursor (or full
   *  list size when no cursor exists). */
  newMessageCount: number;
  abortSignal?: AbortSignal;
}

/** True iff an assistant turn ran a write op (create/str_replace/insert). */
export function hasMemoryWritesIn(
  messages: readonly UIMessage[]
): boolean {
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.parts)) continue;
    for (const part of m.parts) {
      const p = part as { type?: unknown; input?: unknown; state?: unknown };
      if (typeof p.type !== "string") continue;
      if (p.type !== "tool-memory") continue;
      // Only count parts the SDK marks as actually run.
      if (p.state !== "input-available" && p.state !== "output-available") {
        continue;
      }
      const input = p.input as { command?: unknown } | undefined;
      const cmd = input?.command;
      if (cmd === "create" || cmd === "str_replace" || cmd === "insert") {
        return true;
      }
    }
  }
  return false;
}

// Manifest pre-injected so the fork doesn't burn a turn on `view ""`.
function buildExtractionPrompt(
  newMessageCount: number,
  existingManifest: string
): string {
  const manifestBlock =
    existingManifest.length > 0
      ? `\n\n## Existing memory files\n\n${existingManifest}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
      : "";
  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${newMessageCount} messages above and use them to update your persistent memory directory.`,
    "",
    "Available tool: `memory` (your standard six-op directory tool — `view`, `create`, `str_replace`, `insert`, `delete`, `rename`). The full memory protocol and convention from your system prompt apply: write durable facts as their own entry files with `name` + `description` frontmatter, and add a one-line pointer to `MEMORY.md`.",
    "",
    "You have a limited turn budget. The efficient strategy is: turn 1 — `view` the entries you might update (in parallel where the schema allows); turn 2 — `create` / `str_replace` for the writes. Do not interleave reads and writes across multiple turns.",
    "",
    "Use ONLY content from the recent messages above. Do not investigate further — no shell commands, no grepping source files, no verifying against current state. The job is extraction, not research.",
    "",
    "Save criteria — what to extract:",
    "- Durable facts about the user, the project, or recurring constraints.",
    "- Feedback the user gave (corrections OR confirmations of non-obvious choices).",
    "- Decisions whose rationale wouldn't be obvious from code / git history alone.",
    "- Pointers to where information lives in external systems.",
    "",
    "Save each as its own file with `name` + `description` frontmatter and a body that leads with the point, then `**Why:**` and `**How to apply:**` lines (see your system prompt for the convention). Add a one-line pointer to `MEMORY.md` after each new entry.",
    "",
    "What NOT to save:",
    "- Code patterns, architecture, file paths — re-derivable from the codebase.",
    "- Git history, recent changes, who-changed-what.",
    "- Debugging solutions — the fix is in the code; the commit message has context.",
    "- Ephemeral task state and current conversation context.",
    "",
    "If nothing in the recent messages is worth saving, do nothing and stop. Saving is opt-in; silence is a valid response.",
    manifestBlock,
  ].join("\n");
}

export async function runExtractor(
  args: RunExtractorArgs
): Promise<ExtractorResult> {
  if (args.newMessageCount <= 0) {
    return { status: "skipped-no-new-content" };
  }
  if (hasMemoryWritesIn(args.sessionMessages)) {
    return { status: "skipped-main-wrote" };
  }

  let manifest = "";
  try {
    const memoryDir = args.agent.memoryStore.dirPath(args.agent.config.id);
    const headers = await scanMemoryFiles(memoryDir, args.abortSignal);
    manifest = formatMemoryManifest(headers);
  } catch {
    // Scan failure: fork can `view ""` itself if needed.
  }

  const prompt = buildExtractionPrompt(args.newMessageCount, manifest);

  let fork: ForkedSubagentResult;
  try {
    fork = await runSubagent({
      mode: "forked",
      parent: args.agent,
      parentSessionId: args.sessionId,
      // Without this, "messages above" in the prompt refers to nothing.
      // Identical context across turns shares the prompt cache.
      contextMessages: args.sessionMessages,
      initialMessage: prompt,
      stopWhen: stepCountIs(EXTRACTOR_STEP_CAP),
      timeoutMs: EXTRACTOR_TIMEOUT_MS,
      abortSignal: args.abortSignal,
      toolFilter: EXTRACTOR_TOOLS,
      telemetryFunctionId: `${args.agent.config.id}:subagent.forked.extractor`,
      usageKind: "extractor",
    });
  } catch (e) {
    return {
      status: "failed",
      error: extractErrorText(e),
    };
  }

  return { status: fork.status, fork };
}

export const __test = { buildExtractionPrompt };
