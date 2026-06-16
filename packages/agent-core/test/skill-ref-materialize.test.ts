import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { __test as messagesTest } from "../src/messages.js";

const { materializeSkillRef } = messagesTest;

function userWithSkillRef(
  id: string,
  names: string[],
  modelContent: string,
  text: string
): UIMessage {
  return {
    id,
    role: "user",
    parts: [
      { type: "data-skill-ref", data: { names, modelContent } },
      { type: "text", text },
    ],
  } as unknown as UIMessage;
}

describe("materializeSkillRef", () => {
  it("prepends each user message's marker and strips the data-skill-ref part", () => {
    const out = materializeSkillRef([
      userWithSkillRef(
        "u1",
        ["code-review"],
        "<referenced-skills>A</referenced-skills>",
        "first"
      ),
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "ok" }],
      } as UIMessage,
      userWithSkillRef(
        "u2",
        ["pr-writer"],
        "<referenced-skills>B</referenced-skills>",
        "second"
      ),
    ]);

    // No data-skill-ref part survives anywhere.
    for (const m of out) {
      for (const p of m.parts as { type: string }[]) {
        expect(p.type).not.toBe("data-skill-ref");
      }
    }

    // Both user messages get a leading text block with their own marker.
    const u1 = out.find((m) => m.id === "u1")!;
    const u1first = (u1.parts as { type: string; text?: string }[])[0];
    expect(u1first.type).toBe("text");
    expect(u1first.text).toContain("A");

    const u2 = out.find((m) => m.id === "u2")!;
    const u2first = (u2.parts as { type: string; text?: string }[])[0];
    expect(u2first.type).toBe("text");
    expect(u2first.text).toContain("B");
  });

  it("leaves messages without a skill-ref part untouched", () => {
    const plain = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as UIMessage;
    const out = materializeSkillRef([plain]);
    expect(out[0]).toBe(plain);
  });
});
