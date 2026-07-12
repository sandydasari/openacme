import type { PiEvent } from "./types.js";

const MAX_PENDING_CHARS = 30_000;
const MAX_AGGREGATE_CHARS = 200_000;
const AGGREGATE_TAIL_CHARS = 2_000;
const MAX_TEXT_FLUSH_CHARS = 2_000;
const MAX_RESULT_CHARS = 4_000;
const MAX_ARG_SUMMARY_CHARS = 120;

/**
 * Collapses pi's event stream into compact progress lines so the polling
 * agent isn't drowned in per-token deltas. Assistant text accumulates per
 * turn and flushes as one capped block; thinking collapses to a single
 * marker per burst; tool executions become one start line + one end line.
 *
 * Lines land in the process-tool dual-buffer pair: `pending` (drained by
 * poll, newest-wins on overflow) and `aggregate` (full transcript,
 * head+tail truncated).
 */
export class PiDigest {
  private pending = "";
  private aggregate = "";
  private truncated = false;

  private textBuf = "";
  private inThinkingBurst = false;
  private readonly toolStarts = new Map<
    string,
    { name: string; startedAt: number }
  >();
  private turnCount = 0;

  /** True once `agent_settled` has been observed for the current prompt. */
  settled = false;
  /** Final assistant text from the most recently completed turn, capped. */
  lastAssistantText = "";

  feed(ev: PiEvent): void {
    switch (ev.type) {
      case "agent_start":
        this.settled = false;
        this.appendLine(`[agent started]`);
        break;
      case "turn_start":
        this.turnCount += 1;
        break;
      case "message_update": {
        const sub = ev.assistantMessageEvent;
        if (typeof sub !== "object" || sub === null) break;
        const subType = (sub as { type?: unknown }).type;
        if (subType === "text_delta") {
          this.endThinkingBurst();
          const delta = (sub as { delta?: unknown }).delta;
          if (typeof delta === "string") this.textBuf += delta;
        } else if (subType === "thinking_delta") {
          if (!this.inThinkingBurst) {
            this.inThinkingBurst = true;
            this.appendLine("[thinking]");
          }
        }
        break;
      }
      case "tool_execution_start": {
        this.endThinkingBurst();
        this.flushText();
        const name = this.toolName(ev);
        const callId = this.toolCallId(ev);
        if (callId)
          this.toolStarts.set(callId, { name, startedAt: Date.now() });
        this.appendLine(`-> ${name}: ${this.argSummary(ev)}`);
        break;
      }
      case "tool_execution_end": {
        const callId = this.toolCallId(ev);
        const started = callId ? this.toolStarts.get(callId) : undefined;
        if (callId) this.toolStarts.delete(callId);
        const name = started?.name ?? this.toolName(ev);
        const secs = started
          ? ((Date.now() - started.startedAt) / 1000).toFixed(1)
          : "?";
        const isError = ev.isError === true;
        this.appendLine(
          isError
            ? `err ${name}: ${this.errorSummary(ev)}`
            : `ok ${name} (${secs}s)`,
        );
        break;
      }
      case "turn_end":
        this.endThinkingBurst();
        this.flushText();
        break;
      case "agent_settled":
      case "agent_end": {
        this.endThinkingBurst();
        this.flushText();
        // pi emits both agent_end and agent_settled at quiescence — mark once.
        if (!this.settled) {
          this.settled = true;
          this.appendLine(`[agent settled after ${this.turnCount} turn(s)]`);
        }
        break;
      }
      // High-frequency / uninteresting bookkeeping events.
      case "message_start":
      case "message_end":
      case "queue_update":
        break;
      default:
        // Unknown/rare events (compaction, retries, extension errors, …)
        // fall through as one-liners so the transcript stays explainable.
        this.appendLine(`[pi:${ev.type}]`);
        break;
    }
  }

  /** Note a line from outside the event stream (spawn errors, timeouts…). */
  note(line: string): void {
    this.flushText();
    this.appendLine(line);
  }

  /** Returns new progress since the last drain, then clears it. */
  drainPending(): string {
    const out = this.pending;
    this.pending = "";
    return out;
  }

  getAggregate(): string {
    return this.aggregate;
  }

  private flushText(): void {
    if (this.textBuf === "") return;
    let text = this.textBuf.trim();
    this.textBuf = "";
    if (text === "") return;
    this.lastAssistantText =
      text.length > MAX_RESULT_CHARS
        ? text.slice(0, MAX_RESULT_CHARS) + "…"
        : text;
    if (text.length > MAX_TEXT_FLUSH_CHARS) {
      const half = Math.floor(MAX_TEXT_FLUSH_CHARS / 2);
      text = `${text.slice(0, half)}\n...[text truncated]...\n${text.slice(-half)}`;
    }
    this.appendLine(text);
  }

  private endThinkingBurst(): void {
    this.inThinkingBurst = false;
  }

  private appendLine(line: string): void {
    const chunk = line.endsWith("\n") ? line : line + "\n";

    this.pending += chunk;
    if (this.pending.length > MAX_PENDING_CHARS) {
      this.pending = this.pending.slice(-MAX_PENDING_CHARS);
    }

    this.aggregate += chunk;
    if (this.aggregate.length > MAX_AGGREGATE_CHARS) {
      const head = this.aggregate.slice(
        0,
        MAX_AGGREGATE_CHARS - AGGREGATE_TAIL_CHARS - 50,
      );
      const tail = this.aggregate.slice(-AGGREGATE_TAIL_CHARS);
      this.aggregate = `${head}\n...[output truncated]...\n${tail}`;
      this.truncated = true;
    }
  }

  get isTruncated(): boolean {
    return this.truncated;
  }

  private toolName(ev: PiEvent): string {
    const name = ev.toolName ?? ev.name;
    return typeof name === "string" ? name : "tool";
  }

  private toolCallId(ev: PiEvent): string | null {
    const id = ev.toolCallId ?? ev.callId;
    return typeof id === "string" ? id : null;
  }

  private argSummary(ev: PiEvent): string {
    const args = ev.args ?? ev.input ?? ev.arguments;
    if (args === undefined) return "";
    let s: string;
    try {
      s = typeof args === "string" ? args : JSON.stringify(args);
    } catch {
      return "";
    }
    return s.length > MAX_ARG_SUMMARY_CHARS
      ? s.slice(0, MAX_ARG_SUMMARY_CHARS) + "…"
      : s;
  }

  private errorSummary(ev: PiEvent): string {
    const err = ev.error ?? ev.message ?? ev.result;
    let s: string;
    try {
      s = typeof err === "string" ? err : JSON.stringify(err);
    } catch {
      s = "unknown error";
    }
    return s.length > MAX_ARG_SUMMARY_CHARS
      ? s.slice(0, MAX_ARG_SUMMARY_CHARS) + "…"
      : s;
  }
}
