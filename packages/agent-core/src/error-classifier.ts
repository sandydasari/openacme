import { inspect } from "node:util";
import { APICallError } from "ai";

/**
 * Decide whether an error from a model call should trigger reactive
 * compression + retry. Three branches:
 *
 *   - 413 / `request entity too large` → payload_too_large
 *   - 400 + context-overflow phrasing → context_overflow
 *   - 429 + "extra usage" + "long context" → Anthropic long-context tier
 *     gate, recovered the same way as a plain context overflow
 */

export type CompressionReason = "payload_too_large" | "context_overflow";

export interface ClassifiedError {
  /** Non-null iff this error should trigger reactive compression + retry. */
  compressionReason: CompressionReason | null;
}

const PAYLOAD_TOO_LARGE_PATTERNS = [
  "request entity too large",
  "payload too large",
  "error code: 413",
];

// English + code-style + CJK + Bedrock variants. We pattern-match on a
// lowercased concatenation of `error.message` and `responseBody`, so
// underscore-separated error codes (e.g. `context_length_exceeded`) need
// their own entries — `"context length exceeded"` (spaced) won't match
// them. Over-triggering compression is much less harmful than missing a
// signal and getting stuck in a retry loop.
const CONTEXT_OVERFLOW_PATTERNS = [
  "context length",
  "context size",
  "maximum context",
  "token limit",
  "too many tokens",
  "reduce the length",
  "exceeds the limit",
  "context window",
  "prompt is too long",
  "prompt exceeds max length",
  "max_tokens",
  "maximum number of tokens",
  // Code-style variants (OpenAI / OpenRouter `error.code` strings)
  "context_length_exceeded",
  "max_tokens_exceeded",
  // vLLM / local inference
  "exceeds the max_model_len",
  "max_model_len",
  "prompt length",
  "input is too long",
  "maximum model length",
  // Ollama
  "context length exceeded",
  "truncating input",
  // llama.cpp / llama-server
  "slot context",
  "n_ctx_slot",
  // CJK error messages from some Asian providers (DashScope, Qwen, etc.)
  "超过最大长度",
  "上下文长度",
  // AWS Bedrock Converse
  "max input token",
  "input token",
  "exceeds the maximum number of input tokens",
];

export function extractStatusCode(err: unknown): number | undefined {
  if (APICallError.isInstance(err)) return err.statusCode;
  if (err && typeof err === "object") {
    const e = err as { status?: number; statusCode?: number; cause?: unknown };
    if (typeof e.statusCode === "number") return e.statusCode;
    if (typeof e.status === "number" && e.status >= 100 && e.status < 600) {
      return e.status;
    }
    // One-hop cause walk for wrapped APICallErrors.
    if (e.cause && e.cause !== err) return extractStatusCode(e.cause);
  }
  return undefined;
}

/** Original-case error text for surfacing to humans. Handles SDK Error /
 *  APICallError instances and nested provider error objects. If no semantic
 *  error text can be found, falls back to `dumpUnknown()` so plain objects
 *  never surface as `[object Object]`. */
const DUMP_MAX_CHARS = 4096;

function isUsefulErrorText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed !== "[object Object]";
}

function truncateDump(text: string): string {
  return text.length > DUMP_MAX_CHARS
    ? `${text.slice(0, DUMP_MAX_CHARS)}...[truncated]`
    : text;
}

function objectEntries(value: object): Array<[string, unknown]> {
  return Object.keys(value).map((key) => {
    try {
      return [key, (value as Record<string, unknown>)[key]];
    } catch (e) {
      return [key, `[threw while reading property: ${String(e)}]`];
    }
  });
}

function normalizeForDump(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Error) {
    const errorDump: Record<string, unknown> = {
      name: value.name || "Error",
    };
    if (isUsefulErrorText(value.message)) errorDump.message = value.message;
    if (value.cause && value.cause !== value) {
      errorDump.cause = normalizeForDump(value.cause, seen);
    }
    for (const [key, child] of objectEntries(value)) {
      if (!(key in errorDump)) errorDump[key] = normalizeForDump(child, seen);
    }
    return errorDump;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForDump(item, seen));
  }

  const dump: Record<string, unknown> = {};
  for (const [key, child] of objectEntries(value)) {
    dump[key] = normalizeForDump(child, seen);
  }
  return dump;
}

function dumpUnknown(value: unknown): string {
  try {
    const normalized = normalizeForDump(value, new WeakSet<object>());
    const json = JSON.stringify(normalized);
    if (json && isUsefulErrorText(json)) return truncateDump(json);
  } catch {
    // Fall through to inspect/String.
  }

  try {
    const inspected = inspect(value, {
      breakLength: 120,
      colors: false,
      depth: 6,
      getters: false,
      maxArrayLength: 50,
      maxStringLength: DUMP_MAX_CHARS,
    });
    if (isUsefulErrorText(inspected)) return truncateDump(inspected);
  } catch {
    // Fall through to String(value).
  }

  const text = String(value);
  return isUsefulErrorText(text) ? truncateDump(text) : "Unknown error";
}

function extractNestedErrorText(
  value: unknown,
  seen: WeakSet<object>
): string {
  if (value == null) return "";
  const inner = extractErrorTextInner(value, seen);
  return isUsefulErrorText(inner) ? inner : "";
}

function extractErrorTextInner(
  err: unknown,
  seen: WeakSet<object>
): string {
  if (typeof err === "string") return err;
  if (
    typeof err === "number" ||
    typeof err === "boolean" ||
    typeof err === "bigint"
  ) {
    return String(err);
  }
  if (err == null) return String(err);
  if (APICallError.isInstance(err)) {
    const parts = [
      err.message ?? "",
      typeof err.responseBody === "string"
        ? err.responseBody
        : extractNestedErrorText(err.responseBody, seen),
    ].filter((part) => isUsefulErrorText(part));
    return parts.join("\n").trim();
  }
  if (err instanceof Error) {
    if (err.cause && err.cause !== err) {
      const inner = extractErrorTextInner(err.cause, seen);
      if (isUsefulErrorText(inner)) return inner;
    }
    if (isUsefulErrorText(err.message)) return err.message;
    return dumpUnknown(err);
  }
  if (err && typeof err === "object") {
    if (seen.has(err)) return "";
    seen.add(err);
    const e = err as Record<string, unknown>;
    if (e.cause && e.cause !== err) {
      const inner = extractErrorTextInner(e.cause, seen);
      if (isUsefulErrorText(inner)) return inner;
    }
    for (const key of [
      "message",
      "error",
      "responseBody",
      "body",
      "data",
      "detail",
      "details",
      "errors",
    ]) {
      const inner = extractNestedErrorText(e[key], seen);
      if (inner) return inner;
    }
    return dumpUnknown(err);
  }
  return dumpUnknown(err);
}

export function extractErrorText(err: unknown): string {
  return extractErrorTextInner(err, new WeakSet()).trim();
}

function extractText(err: unknown): string {
  return extractErrorText(err).toLowerCase();
}

export function classifyError(err: unknown): ClassifiedError {
  const statusCode = extractStatusCode(err);
  const text = extractText(err);

  if (statusCode === 413) return { compressionReason: "payload_too_large" };

  // Anthropic long-context tier gate. Match BEFORE generic 429 → no-op
  // (we don't classify rate limits at all).
  if (
    statusCode === 429 &&
    text.includes("extra usage") &&
    text.includes("long context")
  ) {
    return { compressionReason: "context_overflow" };
  }

  if (PAYLOAD_TOO_LARGE_PATTERNS.some((p) => text.includes(p))) {
    return { compressionReason: "payload_too_large" };
  }
  if (CONTEXT_OVERFLOW_PATTERNS.some((p) => text.includes(p))) {
    return { compressionReason: "context_overflow" };
  }

  return { compressionReason: null };
}
