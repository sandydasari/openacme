import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { __test as messagesTest } from "../src/messages.js";

const { materializeUiContext } = messagesTest;

function userWithCtx(id: string, modelContent: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [
      {
        type: "data-ui-context",
        data: {
          page: "/agents",
          entityType: "agent",
          entityId: "researcher",
          modelContent,
        },
      },
      { type: "text", text },
    ],
  } as unknown as UIMessage;
}

describe("materializeUiContext", () => {
  it("materializes only the latest user message's snapshot, strips the rest", () => {
    const out = materializeUiContext([
      userWithCtx("u1", "<ui-context>OLD</ui-context>", "first"),
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] } as UIMessage,
      userWithCtx("u2", "<ui-context>NEW</ui-context>", "second"),
    ]);

    // No data-ui-context part survives anywhere.
    for (const m of out) {
      for (const p of m.parts as { type: string }[]) {
        expect(p.type).not.toBe("data-ui-context");
      }
    }

    // Latest user message gets a leading text block with the NEW snapshot.
    const u2 = out.find((m) => m.id === "u2")!;
    const u2first = (u2.parts as { type: string; text?: string }[])[0];
    expect(u2first.type).toBe("text");
    expect(u2first.text).toContain("NEW");

    // Earlier user message's snapshot is gone (not replayed), leaving its text.
    const u1 = out.find((m) => m.id === "u1")!;
    const u1texts = (u1.parts as { type: string; text?: string }[])
      .map((p) => p.text ?? "")
      .join(" ");
    expect(u1texts).toContain("first");
    expect(u1texts).not.toContain("OLD");
  });

  it("leaves messages without a ui-context part untouched", () => {
    const plain = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as UIMessage;
    const out = materializeUiContext([plain]);
    expect(out[0]).toBe(plain);
  });
});
