import { describe, expect, it } from "vitest";
import { PiDigest } from "../src/digest.js";

describe("PiDigest", () => {
  it("collapses text deltas into one flushed block per turn", () => {
    const d = new PiDigest();
    d.feed({ type: "agent_start" });
    d.feed({ type: "turn_start" });
    d.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello " },
    });
    d.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "world" },
    });
    expect(d.drainPending()).not.toContain("Hello");
    d.feed({ type: "turn_end" });
    const out = d.drainPending();
    expect(out).toContain("Hello world");
    expect(out.match(/Hello/g)).toHaveLength(1);
  });

  it("collapses a thinking burst to a single marker", () => {
    const d = new PiDigest();
    for (let i = 0; i < 5; i++) {
      d.feed({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "x" },
      });
    }
    d.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    for (let i = 0; i < 3; i++) {
      d.feed({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "y" },
      });
    }
    d.feed({ type: "turn_end" });
    expect(d.getAggregate().match(/\[thinking\]/g)).toHaveLength(2);
  });

  it("renders tool executions as start/end lines with duration", () => {
    const d = new PiDigest();
    d.feed({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "t1",
      args: { command: "ls" },
    });
    d.feed({ type: "tool_execution_end", toolCallId: "t1" });
    d.feed({
      type: "tool_execution_start",
      toolName: "edit",
      toolCallId: "t2",
      args: {},
    });
    d.feed({
      type: "tool_execution_end",
      toolCallId: "t2",
      isError: true,
      error: "no such file",
    });
    const out = d.getAggregate();
    expect(out).toMatch(/-> bash: .*ls/);
    expect(out).toMatch(/ok bash \(\d+\.\d s?\)|ok bash \(\d+\.\ds\)/);
    expect(out).toContain("err edit: ");
    expect(out).toContain("no such file");
  });

  it("marks settled and captures the final assistant text", () => {
    const d = new PiDigest();
    d.feed({ type: "agent_start" });
    d.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "All done." },
    });
    d.feed({ type: "agent_settled" });
    expect(d.settled).toBe(true);
    expect(d.lastAssistantText).toBe("All done.");
    expect(d.getAggregate()).toContain("[agent settled");
  });

  it("logs unknown event types as one-liners and skips noisy bookkeeping", () => {
    const d = new PiDigest();
    d.feed({ type: "compaction_start" });
    d.feed({ type: "queue_update" });
    d.feed({ type: "message_start" });
    const out = d.getAggregate();
    expect(out).toContain("[pi:compaction_start]");
    expect(out).not.toContain("queue_update");
    expect(out).not.toContain("message_start");
  });

  it("drainPending drains; aggregate persists", () => {
    const d = new PiDigest();
    d.note("line one");
    expect(d.drainPending()).toContain("line one");
    expect(d.drainPending()).toBe("");
    expect(d.getAggregate()).toContain("line one");
  });

  it("caps the pending buffer newest-wins", () => {
    const d = new PiDigest();
    for (let i = 0; i < 500; i++) d.note(`line ${i} ` + "x".repeat(100));
    const pending = d.drainPending();
    expect(pending.length).toBeLessThanOrEqual(30_000);
    expect(pending).toContain("line 499");
    expect(pending).not.toContain("line 0 ");
  });
});
