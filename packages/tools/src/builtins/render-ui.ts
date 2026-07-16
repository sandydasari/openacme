import { z } from "zod";
import { registry } from "../registry.js";

/**
 * render_ui — purely presentational. The web chat renders the ARGUMENTS as a
 * rich block at the point of call (`tool-render_ui` part); the handler only
 * validates and acknowledges. Terminal/TUI contexts show the raw arguments.
 */

const TodoItemSchema = z.object({
  label: z.string().min(1).describe("The item text, one line."),
  status: z
    .enum(["done", "active", "todo"])
    .describe("done = completed, active = in progress, todo = pending."),
});

const TOOL_DESCRIPTION =
  "Display a rich UI block to the user at this point in the chat. " +
  "Purely presentational: the block is rendered from your arguments and the " +
  "result is just an acknowledgement — never call it to compute anything. " +
  "Components: `todo_list` renders a checklist with per-item status — use it " +
  "when presenting a plan, tracking multi-step progress, or answering with " +
  "to-dos or action items. `diff` renders a before/after text change for one " +
  "file — use it when proposing or reporting an edit so the user can read it " +
  "as +/- lines instead of prose. Prefer these blocks over hand-drawn " +
  "markdown checklists or fenced diff blocks; keep surrounding prose brief.";

registry.register({
  name: "render_ui",
  toolset: "ui",
  description: TOOL_DESCRIPTION,
  parameters: z.object({
    component: z
      .enum(["todo_list", "diff"])
      .describe("Which block to render."),
    title: z
      .string()
      .optional()
      .describe("Optional short heading rendered above the block."),
    todos: z
      .array(TodoItemSchema)
      .optional()
      .describe("todo_list only: the items, in display order."),
    file: z
      .string()
      .optional()
      .describe("diff only: path of the file the change applies to."),
    old_text: z
      .string()
      .optional()
      .describe("diff only: the text before the change. Empty for a new file."),
    new_text: z
      .string()
      .optional()
      .describe("diff only: the text after the change. Empty for a deletion."),
  }),
  emoji: "🧩",
  parallelSafe: true,
  handler: async (args) => {
    const component = args.component as string;
    if (component === "todo_list") {
      const todos = args.todos as unknown[] | undefined;
      if (!todos || todos.length === 0) {
        throw new Error("todo_list requires a non-empty `todos` array.");
      }
    } else if (component === "diff") {
      if (typeof args.file !== "string" || args.file.length === 0) {
        throw new Error("diff requires `file`.");
      }
      if (
        typeof args.old_text !== "string" &&
        typeof args.new_text !== "string"
      ) {
        throw new Error("diff requires `old_text` and/or `new_text`.");
      }
    }
    return JSON.stringify({ rendered: true, component });
  },
});
