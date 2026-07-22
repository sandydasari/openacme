import { generateText, type UIMessage, type UIMessagePart } from "ai";
import { createHash, randomUUID } from "node:crypto";
import { getModel } from "@openacme/llm-provider";
import type { ModelConfig } from "@openacme/config";
import { extractErrorText } from "./error-classifier.js";
import type { CompressionConfig } from "./types.js";

/**
 * Internal "step view" of a UIMessage. Each user UIMessage flattens to
 * one Step. Each assistant UIMessage flattens to one or more Steps:
 * an assistant Step (with all tool-X parts collected into `toolCalls`)
 * followed by one tool Step per tool-X part that has an output. This
 * lets the algorithm — which was originally written against per-step
 * DB rows — operate unchanged. The Compressor flattens at entry,
 * coalesces back to UIMessages at exit.
 */
type Step = {
  /** Same id as the source UIMessage for assistant/user steps; synthetic
   *  for split-out tool result steps so they round-trip cleanly. */
  id: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
  toolName: string | null;
  /** Pristine source UIMessage parts, captured at flatten time. Used by
   *  the coalesce step to reconstitute non-text parts (FileUIPart, etc.)
   *  the algorithm doesn't otherwise round-trip — and by
   *  `messageBudgetLength` to count multimodal parts at their real budget
   *  weight. The algorithm itself never reads or mutates this field. */
  originalParts?: UIMessage["parts"];
  /** Source UIMessage metadata. Round-tripped through compression so
   *  fields like `kind: "autonomous_event"` survive into the child —
   *  otherwise the web's wake-row filter has nothing to match against
   *  and the rows render as ordinary user bubbles. */
  metadata?: unknown;
};

interface ToolCallEntry {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/**
 * Runtime context compression — produces a smaller in-memory message list
 * for a session that has crossed (or hit a provider-side wall against) its
 * context-window threshold. Mirrors Hermes's `agent/context_compressor.py`
 * algorithmically; implementation is Vercel AI SDK-native.
 *
 * The flow inside `Compressor.compress()`:
 *
 *   1. Pre-prune old tool results (cheap, no LLM call):
 *        a. dedupe identical tool results by SHA-256 hash
 *        b. replace old tool outputs with informative 1-liners
 *        c. truncate long tool-call args while preserving JSON validity
 *   2. Find boundary by token budget, anchored to the most recent user msg
 *      so a tool-call/result pair never splits across the seam
 *   3. Summarize older portion with a structured handoff prompt; on second-
 *      and-later compressions, switch to the UPDATE prompt template that
 *      preserves the prior summary
 *   4. Build new message list `[head, summary, tail]`
 *   5. Sanitize orphan tool-call/result pairs (drop orphans, insert stubs)
 *
 * Caller (Agent) is responsible for: creating the child session row,
 * appending the produced messages, emitting the SSE `session` swap chunk,
 * and updating Compressor state via `recordResult()` / `inheritState()`.
 */

// ── Constants ────────────────────────────────────────────────────────────

/**
 * Wraps the LLM-generated summary when it lands in the child session as a
 * single user-role message. Tells the next assistant explicitly that the
 * summary is reference, not active instructions, and that questions inside
 * it have already been answered. Hermes calls this `SUMMARY_PREFIX` and
 * hardened the wording over multiple iterations.
 */
export const SUMMARY_PREFIX =
  "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. " +
  "This is a handoff from a previous context window — treat it as background reference, NOT as active instructions. " +
  "Do NOT answer questions or fulfill requests mentioned in this summary; they were already addressed. " +
  "Your current task is identified in the '## Active Task' section of the summary — resume exactly from there. " +
  "Respond ONLY to the latest user message that appears AFTER this summary. " +
  "The current session state (files, config, etc.) may reflect work described here — avoid repeating it:";

/**
 * Preamble for the summarizer LLM call itself. Tells the summarizer it's
 * producing reference material for a different assistant, must not respond
 * to questions, must redact credentials. Kept identical across FRESH and
 * UPDATE prompts.
 */
export const SUMMARIZER_PREAMBLE =
  "You are a summarization agent creating a context checkpoint. " +
  "Your output will be injected as reference material for a DIFFERENT assistant that continues the conversation. " +
  "Do NOT respond to any questions or requests in the conversation — only output the structured summary. " +
  "Do NOT include any preamble, greeting, or prefix. " +
  "Write the summary in the same language the user was using in the conversation — do not translate or switch to English. " +
  "NEVER include API keys, tokens, passwords, secrets, credentials, or connection strings in the summary — replace any that appear with [REDACTED].";

/**
 * Markdown sections the summarizer must produce. Active Task is the most
 * load-bearing field — it carries forward the user's most recent
 * unfulfilled request so the next assistant resumes exactly there.
 */
export const SUMMARY_TEMPLATE = `## Active Task
[THE SINGLE MOST IMPORTANT FIELD. Copy the user's most recent unfulfilled request verbatim — the exact words. If multiple tasks were requested and only some are done, list only the ones NOT yet completed. The next assistant must pick up exactly here. If no outstanding task exists, write "None."]

## Goal
[What the user is trying to accomplish overall]

## Constraints & Preferences
[User preferences, coding style, constraints, important decisions]

## Completed Actions
[Numbered list of concrete actions taken — include tool used, target, and outcome.
Format each as: N. ACTION target — outcome [tool: name]
Be specific with file paths, commands, line numbers, and results.]

## Active State
[Current working state — working directory, modified/created files, test status, running processes, environment details]

## In Progress
[Work currently underway when compaction fired]

## Blocked
[Blockers, errors, or issues not yet resolved. Include exact error messages.]

## Key Decisions
[Important technical decisions and WHY]

## Resolved Questions
[Questions the user asked that were ALREADY answered — include the answer]

## Pending User Asks
[Questions or requests from the user that have NOT been answered or fulfilled. If none, write "None."]

## Relevant Files
[Files read, modified, or created — with brief note on each]

## Remaining Work
[What remains to be done — framed as context, not instructions]

## Critical Context
[Specific values, error messages, configuration details, or data that would be lost without explicit preservation. NEVER include API keys, tokens, passwords, or credentials.]
`;

/** Vercel AI SDK / Claude Code constant: a flat per-image token budget. */
export const IMAGE_TOKEN_ESTIMATE = 1600;
export const CHARS_PER_TOKEN = 4;
export const IMAGE_CHAR_EQUIVALENT = IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;

/**
 * Summary budget defaults. The actual ratio used is
 * `config.summaryTargetRatio` (schema default also 0.2); this constant
 * is kept only as the fallback when no config knob is provided.
 */
export const SUMMARY_RATIO_DEFAULT = 0.2;
export const SUMMARY_MIN_TOKENS = 2_000;
export const SUMMARY_TOKENS_CEILING = 12_000;

/**
 * Approximate per-message overhead — the role/metadata serialization
 * (`"role": "user"`, JSON wrapper, message separators) that the provider
 * tokenizes alongside content. Hermes uses 10 *tokens* per message
 * (`context_compressor.py:1185`); we express it in chars to match the
 * char-based budget walk: 10 tokens × 4 chars/token ≈ 40 chars.
 *
 * Used only by the boundary walk; the trigger check uses real
 * `usage.inputTokens` from the model response.
 */
const MESSAGE_OVERHEAD_TOKENS = 10;
const MESSAGE_OVERHEAD_CHARS = MESSAGE_OVERHEAD_TOKENS * CHARS_PER_TOKEN;

/** A misbehaving summarizer gets put in 10-min timeout — long enough that
 *  a flaky aux model doesn't burn budget on every turn, short enough that
 *  config fixes (rotated key, switched model) are picked up the same session. */
export const SUMMARY_FAILURE_COOLDOWN_MS = 600_000;

/** Substantial-enough threshold for a tool result to be worth pruning/dedup. */
const SIGNIFICANT_TOOL_RESULT_CHARS = 200;

/** Tool-call args body large enough to be worth truncating. */
const TOOL_CALL_ARGS_TRUNCATE_THRESHOLD = 500;
const TOOL_CALL_ARGS_STRING_HEAD = 200;

/** Summarizer-input render budgets per message (keeps summarizer prompt bounded). */
const SUMMARIZER_CONTENT_MAX = 6_000;
const SUMMARIZER_CONTENT_HEAD = 4_000;
const SUMMARIZER_CONTENT_TAIL = 1_500;
const SUMMARIZER_TOOL_ARGS_MAX = 1_500;
const SUMMARIZER_TOOL_ARGS_HEAD = 1_200;

const DUPLICATE_TOOL_PLACEHOLDER =
  "[Duplicate tool output — same content as a more recent call]";
const ORPHAN_TOOL_RESULT_STUB =
  "[Result from earlier conversation — see context summary above]";

// ── Multimodal-aware length ──────────────────────────────────────────────

/**
 * Char-equivalent length used for budget walks. Counts text by length and
 * images/files at a flat `IMAGE_CHAR_EQUIVALENT` so multimodal turns aren't
 * undercounted.
 *
 * Accepts the Vercel AI SDK `CoreMessage` content shape (`string |
 * Array<TextPart|ImagePart|FilePart|ToolCallPart|ToolResultPart|...>`) so
 * it's forward-compatible with multimodal user/tool messages. Today our DB
 * stores plain strings; this still works.
 */
export function contentLengthForBudget(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) {
    if (content == null) return 0;
    return String(content).length;
  }

  let total = 0;
  for (const part of content) {
    if (typeof part === "string") {
      total += part.length;
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string; args?: unknown; result?: unknown; textDelta?: string };
    switch (p.type) {
      case "text":
        total += p.text?.length ?? 0;
        break;
      case "image":
      case "file":
        total += IMAGE_CHAR_EQUIVALENT;
        break;
      case "tool-call":
        total += JSON.stringify(p.args ?? null).length;
        break;
      case "tool-result":
        total +=
          typeof p.result === "string"
            ? p.result.length
            : JSON.stringify(p.result ?? null).length;
        break;
      case "reasoning":
        total += p.textDelta?.length ?? p.text?.length ?? 0;
        break;
      case "redacted-reasoning":
        // No visible text — signature only. Cost is nominal.
        break;
      default:
        // Forward-compatible silence: unknown parts contribute 0 instead of
        // breaking. New SDK part types will surface as zero-cost until we
        // add a case for them.
        break;
    }
  }
  return total;
}

/**
 * Length used by the boundary walker for one Step. Adds
 * `MESSAGE_OVERHEAD_CHARS` per step to approximate role/metadata tokens.
 *
 * When `originalParts` is set (user steps flattened from a UIMessage),
 * defer to `contentLengthForBudget` so multimodal parts (image / file /
 * reasoning) get charged their real per-part budget rather than the
 * ~30-char text marker the flatten leaves in `content`.
 */
export function messageBudgetLength(m: Step): number {
  if (m.originalParts) {
    return contentLengthForBudget(m.originalParts) + MESSAGE_OVERHEAD_CHARS;
  }
  return (
    (m.content?.length ?? 0) +
    (m.toolCalls?.length ?? 0) +
    MESSAGE_OVERHEAD_CHARS
  );
}

// ── Tool-result 1-liners ─────────────────────────────────────────────────

function safeArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof args === "object" && args !== null) {
    return args as Record<string, unknown>;
  }
  return {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function countLines(s: string): number {
  if (!s) return 0;
  // Trailing newline doesn't add an extra line.
  const stripped = s.endsWith("\n") ? s.slice(0, -1) : s;
  return stripped.length === 0 ? 0 : stripped.split("\n").length;
}

function countMatches(content: string): number {
  // Heuristic: count `:N:` line-number markers (grep-style output).
  const matches = content.match(/:\d+:/g);
  return matches?.length ?? countLines(content);
}

function countResults(content: string): number {
  // Look for "[1]", "[2]", … numbered list markers (web_search style).
  const matches = content.match(/\[\d+\]/g);
  return matches?.length ?? countLines(content);
}

/**
 * One-line summary of a tool call + result, used by the pre-pruning pass
 * to replace verbose tool outputs in the summarizable region. Tool-name
 * coverage matches our actual built-ins; everything else falls through to
 * a generic format.
 */
export function summarizeToolResult(
  toolName: string,
  args: unknown,
  content: string
): string {
  const a = safeArgs(args);
  const len = content.length;

  switch (toolName) {
    case "shell": {
      const cmd = (asString(a["command"]) ?? "").slice(0, 80);
      return `[shell] $ ${cmd} → ${countLines(content)} lines`;
    }
    case "read_file": {
      const path = asString(a["path"]) ?? "?";
      return `[read_file] ${path} (${len} chars)`;
    }
    case "write_file": {
      const path = asString(a["path"]) ?? "?";
      const wroteLen = asString(a["content"])?.length ?? "?";
      return `[write_file] ${path} (wrote ${wroteLen} chars)`;
    }
    case "edit": {
      const path = asString(a["path"]) ?? "?";
      const replacement =
        asString(a["replacement"]) ?? asString(a["new_string"]) ?? "";
      return `[edit] ${path} (replaced ${countLines(replacement)} lines)`;
    }
    case "apply_patch": {
      const patch = asString(a["patch"]) ?? "";
      return `[apply_patch] ${countLines(patch)} patch lines`;
    }
    case "list_files": {
      const path = asString(a["path"]) ?? "?";
      return `[list_files] ${path} (${countLines(content)} entries)`;
    }
    case "search_files": {
      const q = asString(a["query"]) ?? "?";
      const path = asString(a["path"]) ?? ".";
      return `[search_files] '${q}' in ${path} (${countMatches(content)} matches)`;
    }
    case "session_search": {
      const q = asString(a["query"]) ?? "?";
      return `[session_search] '${q}' (${countLines(content)} hits)`;
    }
    case "web_search": {
      const q = asString(a["query"]) ?? "?";
      return `[web_search] '${q}' (${countResults(content)} results)`;
    }
    case "web_extract": {
      const url = asString(a["url"]) ?? "?";
      return `[web_extract] ${url} (${len} chars)`;
    }
    default:
      return `[${toolName}] (${len} chars result)`;
  }
}

// ── JSON-safe tool-call args truncation ──────────────────────────────────

function shrinkStringLeaves(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > TOOL_CALL_ARGS_STRING_HEAD) {
      return value.slice(0, TOOL_CALL_ARGS_STRING_HEAD) + "...[truncated]";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(shrinkStringLeaves);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shrinkStringLeaves(v);
    }
    return out;
  }
  return value;
}

/**
 * Shrink long string leaves inside the `args` of each tool-call entry while
 * keeping the JSON well-formed. Important: providers like MiniMax reject
 * malformed `tool_calls[].arguments` with a non-retryable 400, and the same
 * broken history gets sent every turn until the call falls out of the
 * window. Truncating at the parsed-structure level avoids the unterminated-
 * string trap that naive byte-level truncation creates.
 *
 * Our `tool_calls` column shape: JSON-stringified `[{toolCallId, toolName,
 * args}]`. We do NOT have OpenAI's nested `function.arguments` JSON-in-JSON.
 */
export function truncateToolCallArgs(
  toolCallsJson: string | null | undefined
): string | null {
  if (!toolCallsJson) return toolCallsJson ?? null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCallsJson);
  } catch {
    return toolCallsJson;
  }
  if (!Array.isArray(parsed)) return toolCallsJson;

  let modified = false;
  const next = parsed.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const e = entry as { args?: unknown };
    if (e.args === undefined) return entry;
    const argsLen = JSON.stringify(e.args).length;
    if (argsLen <= TOOL_CALL_ARGS_TRUNCATE_THRESHOLD) return entry;
    const shrunk = shrinkStringLeaves(e.args);
    if (JSON.stringify(shrunk).length === argsLen) return entry;
    modified = true;
    return { ...entry, args: shrunk };
  });

  return modified ? JSON.stringify(next) : toolCallsJson;
}

// ── Tool-result dedup ────────────────────────────────────────────────────

function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/**
 * Walk backward (newest to oldest); when a tool result's content hash has
 * already been seen at a more recent index, replace this older copy with a
 * back-reference placeholder. Saves token budget when the model reads the
 * same file or runs the same command repeatedly within a session.
 */
export function dedupeToolResults(messages: Step[]): {
  messages: Step[];
  deduped: number;
} {
  if (messages.length === 0) return { messages, deduped: 0 };
  const out = messages.map((m) => ({ ...m }));
  let deduped = 0;
  const seen = new Set<string>();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "tool") continue;
    if (typeof m.content !== "string") continue;
    if (m.content.length < SIGNIFICANT_TOOL_RESULT_CHARS) continue;
    if (m.content === DUPLICATE_TOOL_PLACEHOLDER) continue;
    const h = hashContent(m.content);
    if (seen.has(h)) {
      out[i] = { ...m, content: DUPLICATE_TOOL_PLACEHOLDER };
      deduped++;
    } else {
      seen.add(h);
    }
  }
  return { messages: out, deduped };
}

// ── Pre-pruning pre-pass ─────────────────────────────────────────────────

/**
 * Build a `tool_call_id → {toolName, args}` index by scanning all assistant
 * messages' tool_calls. Used by the 1-liner pass to look up the originating
 * call's name/args when summarizing a tool result.
 */
function buildCallIdIndex(
  messages: Step[]
): Map<string, { toolName: string; args: unknown }> {
  const idx = new Map<string, { toolName: string; args: unknown }>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    let calls: unknown;
    try {
      calls = JSON.parse(m.toolCalls);
    } catch {
      continue;
    }
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      if (!c || typeof c !== "object") continue;
      const e = c as { toolCallId?: string; toolName?: string; args?: unknown };
      if (e.toolCallId && e.toolName) {
        idx.set(e.toolCallId, { toolName: e.toolName, args: e.args });
      }
    }
  }
  return idx;
}

/**
 * Replace verbose tool outputs in `[0, pruneBoundary)` with informative
 * 1-liners; truncate long tool-call args in the same range while keeping
 * JSON validity. Runs after `dedupeToolResults` so duplicate placeholders
 * are skipped (no point summarizing a back-reference).
 */
export function pruneOldToolResults(
  messages: Step[],
  opts: { pruneBoundary: number }
): { messages: Step[]; pruned: number } {
  if (messages.length === 0 || opts.pruneBoundary <= 0) {
    return { messages, pruned: 0 };
  }
  const out = messages.map((m) => ({ ...m }));
  const idx = buildCallIdIndex(out);
  let pruned = 0;
  const boundary = Math.min(opts.pruneBoundary, out.length);

  // Pass A: 1-liner replacement on tool results.
  //
  // The size filter (>200 chars) is also our protection against re-pruning
  // an already-emitted 1-liner: real 1-liners produced by
  // `summarizeToolResult` are tens of chars and fall below the threshold
  // on a subsequent compression pass. We only short-circuit for our two
  // explicit placeholders.
  for (let i = 0; i < boundary; i++) {
    const m = out[i]!;
    if (m.role !== "tool") continue;
    if (typeof m.content !== "string") continue;
    if (m.content.length <= SIGNIFICANT_TOOL_RESULT_CHARS) continue;
    if (
      m.content === DUPLICATE_TOOL_PLACEHOLDER ||
      m.content === ORPHAN_TOOL_RESULT_STUB
    ) {
      continue;
    }
    const tn = m.toolName ?? idx.get(m.toolCallId ?? "")?.toolName ?? "unknown";
    const ta = idx.get(m.toolCallId ?? "")?.args ?? {};
    out[i] = { ...m, content: summarizeToolResult(tn, ta, m.content) };
    pruned++;
  }

  // Pass B: tool-call args truncation on assistant messages.
  for (let i = 0; i < boundary; i++) {
    const m = out[i]!;
    if (m.role !== "assistant" || !m.toolCalls) continue;
    const next = truncateToolCallArgs(m.toolCalls);
    if (next !== m.toolCalls) {
      out[i] = { ...m, toolCalls: next };
    }
  }

  return { messages: out, pruned };
}

// ── Boundary helpers ─────────────────────────────────────────────────────

/**
 * If `idx` lands on a tool result, slide forward past consecutive tool
 * results so the summarized region doesn't start mid-group.
 */
export function alignBoundaryForward(messages: Step[], idx: number): number {
  let i = idx;
  while (i < messages.length && messages[i]!.role === "tool") i++;
  return i;
}

/**
 * If `idx` is in the middle of a tool-call/result group (consecutive tool
 * messages preceded by an assistant with toolCalls), pull the boundary
 * back before the assistant so the whole group is summarized together.
 * Without this we'd produce orphaned tool results in the tail.
 */
export function alignBoundaryBackward(messages: Step[], idx: number): number {
  if (idx <= 0 || idx >= messages.length) return idx;
  let check = idx - 1;
  while (check >= 0 && messages[check]!.role === "tool") check--;
  if (
    check >= 0 &&
    messages[check]!.role === "assistant" &&
    messages[check]!.toolCalls
  ) {
    return check;
  }
  return idx;
}

export function findLastUserMessageIdx(
  messages: Step[],
  headEnd: number
): number {
  for (let i = messages.length - 1; i >= headEnd; i--) {
    if (messages[i]!.role === "user") return i;
  }
  return -1;
}

/**
 * Guarantee the most recent user message lives in the protected tail.
 * Without this, `alignBoundaryBackward` can pull `cutIdx` past a user
 * message when keeping a tool group together, putting the active task into
 * the summarized region. The summary's "Pending User Asks" section
 * captures it, but `SUMMARY_PREFIX` tells the next assistant to respond
 * only to messages AFTER the summary — so the task disappears from the
 * active context. Hermes hit this in production (issue #10896).
 */
export function ensureLastUserMessageInTail(
  messages: Step[],
  cutIdx: number,
  headEnd: number
): number {
  const lastUserIdx = findLastUserMessageIdx(messages, headEnd);
  if (lastUserIdx < 0) return cutIdx;
  if (lastUserIdx >= cutIdx) return cutIdx;
  // Pull back to the user message directly. A user message is already a
  // clean boundary (can't be inside a tool group), so skip realigning
  // backward — that would unnecessarily widen the summarized region.
  //
  // Note: we return `lastUserIdx` rather than clamping to `headEnd + 1`.
  // If lastUserIdx === headEnd (the latest user is right at the head
  // boundary), returning `headEnd + 1` would mean tail = messages[headEnd+1:]
  // and the user message would be the only summarizable message — putting
  // the active task into the summarizer's input. The compressor already
  // handles `cutIdx <= headEnd` as a no-op, which is the right behavior.
  return lastUserIdx;
}

/**
 * Walk backward accumulating tokens until the soft ceiling
 * (`tailTokenBudget * 1.5`) is reached. Returns the index where the tail
 * starts.
 *
 * If the returned `cutIdx <= headEnd`, the caller treats it as a no-op
 * (nothing to summarize). That's the correct outcome when the user
 * anchor can't be respected without violating head protection — better
 * to skip compression than to put the active task into the summarized
 * region.
 */
export function findTailCutByTokens(
  messages: Step[],
  opts: { headEnd: number; tailTokenBudget: number }
): number {
  const n = messages.length;
  const { headEnd, tailTokenBudget } = opts;
  if (n - headEnd <= 1) return n;

  const minTail = Math.min(3, n - headEnd - 1);
  const softCeiling = Math.floor(tailTokenBudget * 1.5);
  let accumulated = 0;
  let cutIdx = n;

  for (let i = n - 1; i >= headEnd; i--) {
    const msg = messages[i]!;
    const charLen = messageBudgetLength(msg);
    const tokens = Math.floor(charLen / CHARS_PER_TOKEN);
    if (accumulated + tokens > softCeiling && n - i >= minTail) {
      break;
    }
    accumulated += tokens;
    cutIdx = i;
  }

  // Hard floor: never protect fewer than minTail messages.
  const fallbackCut = n - minTail;
  if (cutIdx > fallbackCut) cutIdx = fallbackCut;

  // Initial small-conversation force-cut: if the budget protected
  // everything, push the cut to just after the head so there's something
  // to summarize. Subsequent alignment / user-anchor passes may still
  // pull it back to ≤ headEnd, which the caller honors as a no-op.
  if (cutIdx <= headEnd) {
    cutIdx = Math.max(fallbackCut, headEnd + 1);
  }

  // Tool-group integrity, then user-message anchor.
  cutIdx = alignBoundaryBackward(messages, cutIdx);
  cutIdx = ensureLastUserMessageInTail(messages, cutIdx, headEnd);
  return cutIdx;
}

// ── Orphan tool-pair sanitization ────────────────────────────────────────

/**
 * After compression, scrub orphaned tool-call/result pairs from the new
 * message list. Two failure modes addressed:
 *
 *   1. A `tool` row references a `toolCallId` whose originating assistant
 *      tool-call was summarized away. Provider rejects with "no tool call
 *      found for tool result with id ...". → Drop the orphan.
 *   2. An assistant message has tool-calls whose results were dropped (or
 *      were never produced — model broke off mid-call). Provider rejects
 *      because every tool-call must be followed by a tool-result with the
 *      matching id. → Insert a stub result right after the assistant.
 *
 * Called once on the final `[head, summary, tail]` list before persisting
 * to the child session.
 */
export function sanitizeToolPairs(messages: Step[]): Step[] {
  const surviving = new Set<string>();
  const callIdToToolName = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    let calls: unknown;
    try {
      calls = JSON.parse(m.toolCalls);
    } catch {
      continue;
    }
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      if (!c || typeof c !== "object") continue;
      const e = c as { toolCallId?: string; toolName?: string };
      if (e.toolCallId) {
        surviving.add(e.toolCallId);
        if (e.toolName) callIdToToolName.set(e.toolCallId, e.toolName);
      }
    }
  }

  const seenResults = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) seenResults.add(m.toolCallId);
  }

  // 1. Drop orphaned tool results.
  const filtered = messages.filter((m) => {
    if (m.role !== "tool") return true;
    if (!m.toolCallId) return true;
    return surviving.has(m.toolCallId);
  });

  // 2. Insert stub results for tool-calls without a matching result.
  const missing = new Set<string>();
  for (const id of surviving) {
    if (!seenResults.has(id)) missing.add(id);
  }
  if (missing.size === 0) return filtered;

  const out: Step[] = [];
  for (const m of filtered) {
    out.push(m);
    if (m.role !== "assistant" || !m.toolCalls) continue;
    let calls: unknown;
    try {
      calls = JSON.parse(m.toolCalls);
    } catch {
      continue;
    }
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      if (!c || typeof c !== "object") continue;
      const e = c as { toolCallId?: string; toolName?: string };
      if (e.toolCallId && missing.has(e.toolCallId)) {
        out.push({
          id: `stub-${randomUUID()}`,
          role: "tool",
          content: ORPHAN_TOOL_RESULT_STUB,
          toolCalls: null,
          toolCallId: e.toolCallId,
          toolName: callIdToToolName.get(e.toolCallId) ?? e.toolName ?? "unknown",
        });
        missing.delete(e.toolCallId);
      }
    }
  }
  return out;
}

// ── Summarizer ───────────────────────────────────────────────────────────

function truncateForSummarizer(content: string): string {
  if (content.length <= SUMMARIZER_CONTENT_MAX) return content;
  return (
    content.slice(0, SUMMARIZER_CONTENT_HEAD) +
    "\n...[truncated]...\n" +
    content.slice(-SUMMARIZER_CONTENT_TAIL)
  );
}

/**
 * Render the summarizable turns into labeled plain text. Includes tool
 * names + truncated args so the summarizer can surface specific details
 * (file paths, commands, error messages, line numbers).
 */
export function serializeForSummary(messages: Step[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const content = m.content ? truncateForSummarizer(m.content) : "";

    if (m.role === "tool") {
      const id = m.toolCallId ?? "?";
      parts.push(`[TOOL ${id}]: ${content}`);
      continue;
    }

    if (m.role === "assistant") {
      let body = `[ASSISTANT]: ${content}`;
      if (m.toolCalls) {
        try {
          const calls = JSON.parse(m.toolCalls) as Array<{
            toolName?: string;
            args?: unknown;
          }>;
          if (Array.isArray(calls) && calls.length > 0) {
            const callLines: string[] = [];
            for (const c of calls) {
              const name = c.toolName ?? "?";
              let argsStr = JSON.stringify(c.args ?? {});
              if (argsStr.length > SUMMARIZER_TOOL_ARGS_MAX) {
                argsStr = argsStr.slice(0, SUMMARIZER_TOOL_ARGS_HEAD) + "...";
              }
              callLines.push(`  ${name}(${argsStr})`);
            }
            body += `\n[Tool calls:\n${callLines.join("\n")}\n]`;
          }
        } catch {
          // Legacy shape — skip, body already has the text.
        }
      }
      parts.push(body);
      continue;
    }

    // user, system, etc.
    const label = m.role.toUpperCase();
    parts.push(`[${label}]: ${content}`);
  }
  return parts.join("\n\n");
}

/**
 * Build the summarizer prompt. UPDATE template if `previousSummary` is
 * provided (iterative compaction); FRESH template otherwise.
 */
export function buildSummaryPrompt(opts: {
  turns: Step[];
  previousSummary?: string;
  summaryBudget: number;
}): string {
  const rendered = serializeForSummary(opts.turns);
  const targetLine = `\nTarget ~${opts.summaryBudget} tokens. Be CONCRETE — include file paths, command outputs, error messages, line numbers, and specific values. Avoid vague descriptions like "made some changes" — say exactly what changed.\n\nWrite only the summary body. Do not include any preamble or prefix.`;
  const sections = SUMMARY_TEMPLATE + targetLine;

  if (opts.previousSummary) {
    return [
      SUMMARIZER_PREAMBLE,
      "",
      "You are updating a context compaction summary. A previous compaction produced the summary below. New conversation turns have occurred since then and need to be incorporated.",
      "",
      "PREVIOUS SUMMARY:",
      opts.previousSummary,
      "",
      "NEW TURNS TO INCORPORATE:",
      rendered,
      "",
      "Update the summary using this exact structure. PRESERVE all existing information that is still relevant. ADD new completed actions to the numbered list (continue numbering). Move items from \"In Progress\" to \"Completed Actions\" when done. Move answered questions to \"Resolved Questions\". Update \"Active State\" to reflect current state. Remove information only if it is clearly obsolete. CRITICAL: Update \"## Active Task\" to reflect the user's most recent unfulfilled request — this is the most important field for task continuity.",
      "",
      sections,
    ].join("\n");
  }

  return [
    SUMMARIZER_PREAMBLE,
    "",
    "Create a structured handoff summary for a different assistant that will continue this conversation after earlier turns are compacted. The next assistant should be able to understand what happened without re-reading the original turns.",
    "",
    "TURNS TO SUMMARIZE:",
    rendered,
    "",
    "Use this exact structure:",
    "",
    sections,
  ].join("\n");
}

/** Idempotent: prepends `SUMMARY_PREFIX` once even if already present. */
export function withSummaryPrefix(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.startsWith(SUMMARY_PREFIX)) return trimmed;
  return trimmed.length > 0 ? `${SUMMARY_PREFIX}\n${trimmed}` : SUMMARY_PREFIX;
}

// ── Token estimation / threshold resolution ─────────────────────────────

/**
 * Resolve the trigger threshold from config.
 *
 * Vercel AI SDK's `LanguageModelV1` does not expose a context window field —
 * only the AI Gateway has `getAvailableModels()`, and not every provider
 * goes through gateway. Rather than hardcode a model→context map that goes
 * stale every quarter, we require the user to specify the threshold
 * explicitly OR pair `thresholdPercent` with an explicit `contextWindow`.
 *
 * Resolution order:
 *   1. `thresholdTokens` is set → use it (absolute).
 *   2. Both `thresholdPercent` and `contextWindow` are set →
 *      `floor(contextWindow * thresholdPercent)`.
 *   3. Otherwise → null (proactive compression disabled; reactive on
 *      provider 413 / context_overflow still fires).
 */
export function resolveThreshold(
  c: CompressionConfig,
  contextWindowOverride?: number | null
): number | null {
  if (c.thresholdTokens != null) return c.thresholdTokens;
  const window = contextWindowOverride ?? c.contextWindow;
  if (c.thresholdPercent != null && window != null) {
    return Math.floor(window * c.thresholdPercent);
  }
  return null;
}

function totalCharLen(messages: Step[]): number {
  let total = 0;
  for (const m of messages) total += messageBudgetLength(m);
  return total;
}

/**
 * Drop oldest messages until total char-content fits `charBudget`. Used
 * to bound the summarizer's own input — the summarizer model has its
 * own context window, and the summarizable region of the parent could
 * be larger than that.
 */
function trimToCharBudget(messages: Step[], charBudget: number): Step[] {
  let total = totalCharLen(messages);
  if (total <= charBudget) return messages;
  const out = [...messages];
  while (total > charBudget && out.length > 1) {
    const dropped = out.shift()!;
    total -= messageBudgetLength(dropped);
  }
  return out;
}

function computeSummaryBudget(
  compressedTurns: Step[],
  contextWindow: number | null,
  ratio: number
): number {
  const contentTokens = Math.floor(totalCharLen(compressedTurns) / CHARS_PER_TOKEN);
  const target = Math.floor(contentTokens * ratio);
  // If we don't know the model's context window, just clamp to the global
  // ceiling. Prevents accidentally requesting a huge summary on a tiny
  // local model when contextWindow is unset.
  const ceiling =
    contextWindow != null
      ? Math.min(Math.floor(contextWindow * 0.05), SUMMARY_TOKENS_CEILING)
      : SUMMARY_TOKENS_CEILING;
  return Math.max(SUMMARY_MIN_TOKENS, Math.min(target, ceiling));
}

// ── Compressor (stateful entry point) ─────────────────────────────────────

interface SummaryFailureState {
  cooldownUntil: number;
  auxFallenBack: boolean;
  lastAuxFailureModel?: string;
  lastAuxFailureError?: string;
}

interface CompressorRunState {
  previousSummary?: string;
  recentSavings: number[];        // last 2 ratios, [0..1]
  failure: SummaryFailureState;
}

function emptyState(): CompressorRunState {
  return {
    previousSummary: undefined,
    recentSavings: [],
    failure: { cooldownUntil: 0, auxFallenBack: false },
  };
}

function modelLabel(m: ModelConfig): string {
  return `${m.provider}/${m.model}`;
}

function errorMessage(e: unknown): string {
  return extractErrorText(e);
}

export interface CompressOpts {
  /** The session whose history we're summarizing. */
  parentSessionId: string;
  /** Full conversation history of the parent session as persisted UIMessages. */
  parentMessages: UIMessage[];
  /** Compression knobs from agent config. */
  config: CompressionConfig;
  /** Main agent model — used for tail/threshold sizing AND as the
   *  fallback summarizer if the configured `summarizerModel` fails. */
  mainModel: ModelConfig;
  /** Why we're compressing — useful for logging and edge-case handling. */
  reason: "proactive" | "payload_too_large" | "context_overflow";
  /** Usage-ledger sink for the summarizer's generateText call(s). One
   *  invocation per attempt (aux + fallback both report). Never throws
   *  into the compression path — caller wraps. */
  onUsage?: (report: {
    model: ModelConfig;
    tokens: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
    };
    durationMs: number;
  }) => void;
}

export interface CompressResult {
  /** The new child's ordered UIMessages, ready for `MessageStore.appendMany`.
   *  The Compressor flattens parent UIMessages into Steps internally, runs
   *  the boundary walk + summarization, then coalesces back to UIMessages. */
  childMessages: UIMessage[];
  /** Generated summary content (without `SUMMARY_PREFIX`). null when the
   *  summarizer failed and we fell back to a placeholder, or when the
   *  history was too short to compress. */
  summary: string | null;
  /** Compression effectiveness in [0, 1]. 0 = no savings; 1 = everything
   *  removed. Used by anti-thrashing. */
  savingsRatio: number;
  /** True if the configured `summarizerModel` failed and we used the
   *  main model instead. Caller may surface a warning to the user. */
  usedFallback: boolean;
  /** True when no compression was performed (history too short, etc.). */
  noOp: boolean;
  /** Diagnostic hooks for surfacing aux-model misconfig to the user. */
  diagnostics: {
    auxFailureModel?: string;
    auxFailureError?: string;
  };
}

/**
 * Stateful compressor. One instance per Agent (the Agent owns it). State
 * is keyed by sessionId so chained compressions on the same parent →
 * child → grandchild → ... carry forward `previousSummary`, anti-thrash
 * ratios, and failure cooldown.
 */
export class Compressor {
  private readonly state = new Map<string, CompressorRunState>();

  /** Returns true iff a fresh compression should fire on this turn. */
  shouldCompress(
    sessionId: string,
    inputTokens: number,
    threshold: number | null
  ): boolean {
    if (threshold === null) return false;
    if (inputTokens < threshold) return false;
    const s = this.state.get(sessionId);
    const recent = s?.recentSavings ?? [];
    if (recent.length >= 2 && recent.every((r) => r < 0.1)) return false;
    return true;
  }

  /** Get state for a session, creating a fresh entry if needed. */
  private getOrCreate(sessionId: string): CompressorRunState {
    let s = this.state.get(sessionId);
    if (!s) {
      s = emptyState();
      this.state.set(sessionId, s);
    }
    return s;
  }

  /**
   * Move state from parent to child after a successful fork. The new
   * compression's savings ratio is appended via `recordResult`; this
   * function only carries forward what already existed.
   */
  inheritState(parentSessionId: string, childSessionId: string): void {
    const parent = this.state.get(parentSessionId);
    if (!parent) return;
    this.state.set(childSessionId, {
      previousSummary: parent.previousSummary,
      recentSavings: [...parent.recentSavings],
      failure: { ...parent.failure },
    });
    this.state.delete(parentSessionId);
  }

  /**
   * Record the new compression's outcome so the next compression on this
   * (now-child) session sees correct previousSummary + savings history.
   */
  recordResult(
    childSessionId: string,
    savingsRatio: number,
    summary: string | null
  ): void {
    const s = this.getOrCreate(childSessionId);
    s.recentSavings = [...s.recentSavings, savingsRatio].slice(-2);
    if (summary !== null) s.previousSummary = summary;
  }

  resetSession(sessionId: string): void {
    this.state.delete(sessionId);
  }

  getDiagnostics(sessionId: string): {
    auxFailureModel?: string;
    auxFailureError?: string;
  } {
    const s = this.state.get(sessionId);
    return {
      auxFailureModel: s?.failure.lastAuxFailureModel,
      auxFailureError: s?.failure.lastAuxFailureError,
    };
  }

  /**
   * Run the full compression pipeline on `parentMessages`. Returns the
   * new child's messages plus diagnostics. Pure with respect to the DB —
   * caller persists.
   */
  async compress(opts: CompressOpts): Promise<CompressResult> {
    const { parentMessages, config, mainModel, parentSessionId } = opts;
    const state = this.getOrCreate(parentSessionId);

    // Flatten parent UIMessages into the per-step shape the algorithm
    // operates on. Coalesce back to UIMessages right before returning.
    const parentSteps = flattenUIMessages(parentMessages);

    const minForCompress = config.protectFirstN + 3 + 1;
    if (parentSteps.length <= minForCompress) {
      return {
        childMessages: [],
        summary: null,
        savingsRatio: 0,
        usedFallback: false,
        noOp: true,
        diagnostics: {},
      };
    }

    // Phase 0: Quick boundary probe on raw messages. If the user-anchor
    // pulls cutIdx ≤ headEnd (e.g. the latest user message lives at the
    // head boundary, which happens in long agent-loop sessions where the
    // user said "go" once), there's nothing to summarize. Skip the
    // pre-pruning pass entirely — running it just to throw the result
    // away wastes CPU on every turn that triggers compression.
    const tailTokenBudget = config.tailTokenBudget;
    {
      const rawHeadEnd = alignBoundaryForward(parentSteps, config.protectFirstN);
      const rawCut = findTailCutByTokens(parentSteps, {
        headEnd: rawHeadEnd,
        tailTokenBudget,
      });
      if (rawHeadEnd >= rawCut) {
        return {
          childMessages: [],
          summary: null,
          savingsRatio: 0,
          usedFallback: false,
          noOp: true,
          diagnostics: {},
        };
      }
    }

    // Phase 1: Pre-prune (dedup → 1-liners + JSON-safe arg trim).
    const { messages: dedupedMessages } = dedupeToolResults(parentSteps);
    const provisionalCut = findTailCutByTokens(dedupedMessages, {
      headEnd: config.protectFirstN,
      tailTokenBudget,
    });
    const { messages: working } = pruneOldToolResults(dedupedMessages, {
      pruneBoundary: provisionalCut,
    });

    // Phase 2: Re-find boundary on pruned messages — pre-pruning shrinks
    // older tool results, so the tail boundary may shift forward.
    const headEnd = alignBoundaryForward(working, config.protectFirstN);
    const cutEnd = findTailCutByTokens(working, { headEnd, tailTokenBudget });
    if (headEnd >= cutEnd) {
      return {
        childMessages: [],
        summary: null,
        savingsRatio: 0,
        usedFallback: false,
        noOp: true,
        diagnostics: {},
      };
    }

    const summarizable = working.slice(headEnd, cutEnd);
    const head = working.slice(0, headEnd);
    const tail = working.slice(cutEnd);

    // Phase 3: Summarize.
    const summaryBudget = computeSummaryBudget(
      summarizable,
      config.contextWindow ?? null,
      config.summaryTargetRatio ?? SUMMARY_RATIO_DEFAULT
    );
    const summarizerModel = config.summarizerModel ?? mainModel;

    // Cap how much summarizer-input we send. If the summarizable region
    // is huge, drop the OLDEST messages until we fit — the head + recent
    // tail were already protected; everything getting summarized is
    // older than that, and dropping the oldest is the least-bad signal
    // loss when the summarizer model has its own context limits.
    const trimmedSummarizable = trimToCharBudget(
      summarizable,
      config.summarizerInputCharBudget
    );

    const summaryOutcome = await this.summarizeMessages({
      sessionId: parentSessionId,
      turns: trimmedSummarizable,
      previousSummary: state.previousSummary,
      summaryBudget,
      primaryModel: summarizerModel,
      fallbackModel: mainModel,
      onUsage: opts.onUsage,
    });

    // Phase 4: Build child message list.
    let summaryStep: Step | null = null;
    let summaryText: string | null = null;
    let usedFallback = false;

    if (summaryOutcome.kind === "ok") {
      summaryText = summaryOutcome.summary;
      usedFallback = summaryOutcome.usedFallback;
      summaryStep = {
        id: `summary-${randomUUID()}`,
        role: "user",
        content: withSummaryPrefix(summaryOutcome.summary),
        toolCalls: null,
        toolCallId: null,
        toolName: null,
      };
    } else if (opts.reason !== "proactive") {
      // Reactive failure — must compress to recover from 4xx; insert a
      // placeholder so the model knows context was truncated even though
      // we couldn't generate a real summary.
      summaryStep = {
        id: `summary-${randomUUID()}`,
        role: "user",
        content:
          `${SUMMARY_PREFIX}\n[Earlier conversation summary unavailable: ${summaryOutcome.error}. Continue with caution; refer to recent turns and ask if unsure.]`,
        toolCalls: null,
        toolCallId: null,
        toolName: null,
      };
    } else {
      // Proactive failure — give up this pass; cooldown prevents thrash.
      // Caller treats noOp:true as "stay on parent".
      return {
        childMessages: [],
        summary: null,
        savingsRatio: 0,
        usedFallback: false,
        noOp: true,
        diagnostics: this.getDiagnostics(parentSessionId),
      };
    }

    let combined: Step[] = [...head, summaryStep, ...tail];

    // Phase 5: Sanitize orphan tool pairs introduced by summarization.
    combined = sanitizeToolPairs(combined);

    const parentTotal = totalCharLen(parentSteps);
    const childTotal = totalCharLen(combined);
    const savingsRatio =
      parentTotal === 0 ? 0 : 1 - childTotal / parentTotal;

    const childMessages = stepsToUIMessages(combined);

    return {
      childMessages,
      summary: summaryText,
      savingsRatio,
      usedFallback,
      noOp: false,
      diagnostics: this.getDiagnostics(parentSessionId),
    };
  }

  /**
   * Generate a summary with cooldown + aux-fallback handling. Internal —
   * exposed only for tests via the `Compressor` class API.
   */
  private async summarizeMessages(opts: {
    sessionId: string;
    turns: Step[];
    previousSummary?: string;
    summaryBudget: number;
    primaryModel: ModelConfig;
    fallbackModel: ModelConfig;
    onUsage?: CompressOpts["onUsage"];
  }): Promise<
    | { kind: "ok"; summary: string; usedFallback: boolean }
    | { kind: "err"; error: string }
  > {
    const state = this.getOrCreate(opts.sessionId);
    const now = Date.now();
    if (now < state.failure.cooldownUntil) {
      const remaining = Math.round((state.failure.cooldownUntil - now) / 1000);
      return { kind: "err", error: `summarizer cooldown ${remaining}s remaining` };
    }

    const useAux =
      !state.failure.auxFallenBack &&
      modelLabel(opts.primaryModel) !== modelLabel(opts.fallbackModel);

    const prompt = buildSummaryPrompt({
      turns: opts.turns,
      previousSummary: opts.previousSummary,
      summaryBudget: opts.summaryBudget,
    });

    const tryGen = async (m: ModelConfig): Promise<string> => {
      const startedAt = Date.now();
      const res = await generateText({
        model: getModel(m),
        prompt,
        maxOutputTokens: Math.floor(opts.summaryBudget * 1.3),
        experimental_telemetry: {
          isEnabled: true,
          functionId: "compression-summarizer",
          metadata: { model: modelLabel(m) },
        },
      });
      try {
        if (res.usage) {
          opts.onUsage?.({
            model: m,
            tokens: {
              inputTokens: res.usage.inputTokens,
              outputTokens: res.usage.outputTokens,
              totalTokens: res.usage.totalTokens,
              cachedInputTokens: res.usage.inputTokenDetails?.cacheReadTokens,
              cacheWriteTokens: res.usage.inputTokenDetails?.cacheWriteTokens,
              reasoningTokens: res.usage.outputTokenDetails?.reasoningTokens,
            },
            durationMs: Date.now() - startedAt,
          });
        }
      } catch {
        // Ledger reporting must never fail a summarization attempt.
      }
      return res.text.trim();
    };

    const modelToUse = useAux ? opts.primaryModel : opts.fallbackModel;
    try {
      const summary = await tryGen(modelToUse);
      // Reset transient cooldown on success; keep auxFallenBack sticky.
      state.failure = {
        ...state.failure,
        cooldownUntil: 0,
        lastAuxFailureModel: state.failure.lastAuxFailureModel,
        lastAuxFailureError: state.failure.lastAuxFailureError,
      };
      return { kind: "ok", summary, usedFallback: !useAux };
    } catch (err) {
      const errStr = errorMessage(err);
      if (useAux) {
        // Aux failure → record + fall back to main model once.
        state.failure.auxFallenBack = true;
        state.failure.lastAuxFailureModel = modelLabel(opts.primaryModel);
        state.failure.lastAuxFailureError = errStr.slice(0, 220);
        try {
          const summary = await tryGen(opts.fallbackModel);
          state.failure.cooldownUntil = 0;
          return { kind: "ok", summary, usedFallback: true };
        } catch (err2) {
          state.failure.cooldownUntil = now + SUMMARY_FAILURE_COOLDOWN_MS;
          return { kind: "err", error: errorMessage(err2) };
        }
      }
      // Already on main, OR primary === fallback (single model) → cooldown.
      state.failure.cooldownUntil = now + SUMMARY_FAILURE_COOLDOWN_MS;
      return { kind: "err", error: errStr };
    }
  }
}

// ── Re-exports for `Agent.compress()` ────────────────────────────────────

export type { ModelConfig } from "@openacme/config";

// ── Flatten / coalesce between UIMessage[] and Step[] ─────────────────────

/**
 * Walk one UIMessage's parts, accumulating text into the current step
 * and split out a new assistant Step + tool result Steps for each
 * tool-${name} part with output. Multiple consecutive text parts in
 * the same UIMessage join with newlines.
 */
function flattenUIMessage(m: UIMessage): Step[] {
  if (m.role === "user") {
    // Concatenate text-parts into `content` so the algorithm's
    // hash/dedup/serialize-for-summary paths see the user's prose. Stash
    // the pristine parts in `originalParts` so coalesce can restore
    // non-text parts (FileUIPart in particular). The algorithm itself
    // never reads this field; only the boundary walker (via
    // messageBudgetLength) and the coalesce do.
    let text = "";
    for (const p of m.parts) {
      if ((p as { type?: string }).type === "text") {
        const t = (p as { text?: string }).text ?? "";
        text += text ? `\n${t}` : t;
      }
    }
    return [
      {
        id: m.id,
        role: "user",
        content: text,
        toolCalls: null,
        toolCallId: null,
        toolName: null,
        originalParts: m.parts,
        metadata: (m as { metadata?: unknown }).metadata,
      },
    ];
  }

  // assistant: collect text spans + tool parts in order. We emit one
  // assistant Step carrying ALL tool-call entries, then one tool Step
  // per tool-${name} part that has an output. Order within the assistant
  // step follows the source UIMessage ordering of tool calls.
  let text = "";
  const calls: ToolCallEntry[] = [];
  const toolSteps: Step[] = [];
  for (const p of m.parts) {
    const tp = p as { type?: string };
    if (tp.type === "text") {
      const t = (p as { text?: string }).text ?? "";
      text += text ? `\n${t}` : t;
      continue;
    }
    if (typeof tp.type === "string" && tp.type.startsWith("tool-")) {
      const tool = p as {
        type: string;
        toolCallId?: string;
        state?: string;
        input?: unknown;
        output?: unknown;
        errorText?: string;
      };
      const toolName = tool.type.slice("tool-".length);
      const toolCallId = tool.toolCallId ?? `c-${randomUUID()}`;
      calls.push({ toolCallId, toolName, args: tool.input });
      // Only output-available / output-error produce a tool Step (input-
      // streaming and input-available mean the call hasn't completed).
      const out =
        tool.state === "output-available"
          ? tool.output
          : tool.state === "output-error"
            ? tool.errorText
            : undefined;
      if (out !== undefined) {
        toolSteps.push({
          id: `tool-${toolCallId}`,
          role: "tool",
          content: typeof out === "string" ? out : JSON.stringify(out),
          toolCalls: null,
          toolCallId,
          toolName,
        });
      }
    }
  }
  const out: Step[] = [
    {
      id: m.id,
      role: "assistant",
      content: text || null,
      toolCalls: calls.length > 0 ? JSON.stringify(calls) : null,
      toolCallId: null,
      toolName: null,
      metadata: (m as { metadata?: unknown }).metadata,
    },
    ...toolSteps,
  ];
  return out;
}

export function flattenUIMessages(messages: UIMessage[]): Step[] {
  const out: Step[] = [];
  for (const m of messages) out.push(...flattenUIMessage(m));
  return out;
}

/**
 * Coalesce Steps back into UIMessages. assistant + following tool steps
 * fold into one UIMessage with parts `[text-part, tool-X(output-available),
 * tool-Y(output-available), ...]`. user steps map 1:1.
 *
 * For user steps with `originalParts` (verbatim head/tail copies), we
 * restore the pristine parts — this preserves FileUIParts and any other
 * non-text content the algorithm doesn't touch. Synthetic user steps
 * (the summary insert, etc.) have no `originalParts` and fall back to
 * a single text part built from the current `content` field.
 */
export function stepsToUIMessages(steps: Step[]): UIMessage[] {
  const out: UIMessage[] = [];
  let i = 0;
  while (i < steps.length) {
    const s = steps[i]!;
    if (s.role === "user") {
      const parts: UIMessage["parts"] = s.originalParts
        ? (s.originalParts as UIMessage["parts"])
        : s.content
          ? [{ type: "text", text: s.content } as UIMessage["parts"][number]]
          : [];
      const msg: UIMessage = { id: s.id, role: "user", parts } as UIMessage;
      if (s.metadata != null) {
        (msg as { metadata?: unknown }).metadata = s.metadata;
      }
      out.push(msg);
      i++;
      continue;
    }
    if (s.role === "assistant") {
      const parts: UIMessage["parts"] = [];
      if (s.content) parts.push({ type: "text", text: s.content } as UIMessage["parts"][number]);
      // Index calls by id so we can pair with the tool steps that follow.
      const calls = parseCalls(s.toolCalls);
      const callsById = new Map<string, ToolCallEntry>();
      for (const c of calls) callsById.set(c.toolCallId, c);
      // Walk forward consuming tool steps until the next non-tool.
      let j = i + 1;
      const toolOutputs = new Map<string, string>();
      while (j < steps.length && steps[j]!.role === "tool") {
        const ts = steps[j]!;
        if (ts.toolCallId) toolOutputs.set(ts.toolCallId, ts.content ?? "");
        j++;
      }
      for (const c of calls) {
        const output = toolOutputs.get(c.toolCallId);
        parts.push({
          type: `tool-${c.toolName}`,
          toolCallId: c.toolCallId,
          state: output !== undefined ? "output-available" : "input-available",
          input: c.args,
          output,
        } as unknown as UIMessage["parts"][number]);
      }
      const msg: UIMessage = { id: s.id, role: "assistant", parts } as UIMessage;
      if (s.metadata != null) {
        (msg as { metadata?: unknown }).metadata = s.metadata;
      }
      out.push(msg);
      i = j;
      continue;
    }
    // A standalone tool step with no preceding assistant — drop it
    // (sanitizeToolPairs removes orphans, but in case any survived).
    i++;
  }
  return out;
}

function parseCalls(json: string | null): ToolCallEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is ToolCallEntry =>
          !!e &&
          typeof e === "object" &&
          typeof (e as { toolCallId?: unknown }).toolCallId === "string" &&
          typeof (e as { toolName?: unknown }).toolName === "string"
      )
      .map((e) => ({
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        args: (e as { args?: unknown }).args,
      }));
  } catch {
    return [];
  }
}
