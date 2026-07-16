import { describe, it, expect } from "vitest";
import "../src/builtins/render-ui.js";
import { registry } from "../src/registry.js";

function handler() {
  const entry = registry.get("render_ui");
  if (!entry) throw new Error("render_ui not registered");
  return entry.handler;
}

describe("render_ui", () => {
  it("acknowledges a valid todo_list", async () => {
    const out = await handler()({
      component: "todo_list",
      todos: [
        { label: "Ship it", status: "active" },
        { label: "Write tests", status: "done" },
      ],
    });
    expect(JSON.parse(out)).toEqual({ rendered: true, component: "todo_list" });
  });

  it("rejects an empty todo_list", async () => {
    await expect(
      handler()({ component: "todo_list", todos: [] })
    ).rejects.toThrow(/non-empty/);
  });

  it("acknowledges a valid diff", async () => {
    const out = await handler()({
      component: "diff",
      file: "src/app.ts",
      old_text: "const a = 1;",
      new_text: "const a = 2;",
    });
    expect(JSON.parse(out)).toEqual({ rendered: true, component: "diff" });
  });

  it("rejects a diff without a file", async () => {
    await expect(
      handler()({ component: "diff", old_text: "a", new_text: "b" })
    ).rejects.toThrow(/file/);
  });

  it("rejects a diff without any text sides", async () => {
    await expect(
      handler()({ component: "diff", file: "src/app.ts" })
    ).rejects.toThrow(/old_text/);
  });
});
