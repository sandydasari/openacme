import { z } from "zod";
import { registry } from "../../registry.js";
import {
  getCurrentAgentId,
  getCurrentWorkspaceDir,
} from "../../session-context.js";
import {
  getPiBindings,
  piNotBoundError,
  piToolError,
  requirePiAgentId,
} from "./bindings.js";

const MAX_RESULT_CHARS = 200_000;

const PiParams = z.object({
  action: z
    .enum([
      "start",
      "list",
      "status",
      "poll",
      "log",
      "steer",
      "follow_up",
      "abort",
      "stop",
    ])
    .describe(
      "start: spawn a pi delegation for a coding task (returns immediately). " +
        "list: your delegations. status: one delegation, no output. " +
        "poll: status + new progress since your last poll (drains it). " +
        "log: the full progress transcript. steer: redirect a running turn. " +
        "follow_up: queue work for after the current turn. abort: cancel the " +
        "current turn but keep the process. stop: kill the delegation.",
    ),
  id: z
    .string()
    .optional()
    .describe("Delegation id (required for all actions except start/list)."),
  prompt: z.string().optional().describe("The coding task (start only)."),
  cwd: z
    .string()
    .optional()
    .describe(
      "Repo/working directory for pi (start only; defaults to your workspace).",
    ),
  provider: z
    .string()
    .optional()
    .describe("Override pi provider (start only)."),
  model: z.string().optional().describe("Override pi model (start only)."),
  message: z.string().optional().describe("Text for steer / follow_up."),
});

type PiArgs = z.infer<typeof PiParams>;

registry.register({
  name: "pi",
  toolset: "pi",
  emoji: "🥧",
  parallelSafe: false,
  maxResultSizeChars: MAX_RESULT_CHARS + 1000,
  description:
    "Delegate a coding task to a pi coding-agent subprocess. `start` returns " +
    "immediately with a delegation id — pi keeps working in the background, so " +
    "`poll` it between your own steps to stream progress. A delegation SURVIVES " +
    "the end of your turn; poll it again on a later turn to pick up where it " +
    "left off. `steer`/`follow_up`/`abort` only take effect as separate calls " +
    "(you cannot interject while pi is mid-work in a single call). Use this for " +
    "multi-file edits, builds, and test loops in a real repo; pi has its own " +
    "read/edit/write/bash tools and its own model credentials.",
  parameters: PiParams,
  handler: async (args) => {
    const a = args as PiArgs;
    const b = getPiBindings();
    if (!b) return piNotBoundError();
    const agentId = getCurrentAgentId();
    const guard = requirePiAgentId(agentId);
    if (guard) return guard;
    const mgr = b.manager;

    const needId = (): string | null =>
      a.id
        ? null
        : JSON.stringify({ error: `id is required for action '${a.action}'` });
    const needMessage = (): string | null =>
      a.message
        ? null
        : JSON.stringify({
            error: `message is required for action '${a.action}'`,
          });

    try {
      switch (a.action) {
        case "start": {
          if (!a.prompt)
            return JSON.stringify({ error: "prompt is required for start" });
          const cwd = a.cwd ?? getCurrentWorkspaceDir() ?? process.cwd();
          const s = await mgr.start(agentId!, {
            prompt: a.prompt,
            cwd,
            provider: a.provider,
            model: a.model,
          });
          return JSON.stringify({ success: true, ...s });
        }
        case "list":
          return JSON.stringify({
            success: true,
            delegations: mgr.list(agentId!),
          });
        case "status": {
          const err = needId();
          if (err) return err;
          return JSON.stringify({
            success: true,
            ...mgr.status(agentId!, a.id!),
          });
        }
        case "poll": {
          const err = needId();
          if (err) return err;
          return JSON.stringify({
            success: true,
            ...mgr.poll(agentId!, a.id!),
          });
        }
        case "log": {
          const err = needId();
          if (err) return err;
          return JSON.stringify({ success: true, ...mgr.log(agentId!, a.id!) });
        }
        case "steer": {
          const err = needId() ?? needMessage();
          if (err) return err;
          return JSON.stringify({
            success: true,
            ...(await mgr.steer(agentId!, a.id!, a.message!)),
          });
        }
        case "follow_up": {
          const err = needId() ?? needMessage();
          if (err) return err;
          return JSON.stringify({
            success: true,
            ...(await mgr.followUp(agentId!, a.id!, a.message!)),
          });
        }
        case "abort": {
          const err = needId();
          if (err) return err;
          return JSON.stringify({
            success: true,
            ...(await mgr.abortTurn(agentId!, a.id!)),
          });
        }
        case "stop": {
          const err = needId();
          if (err) return err;
          return JSON.stringify({
            success: true,
            ...mgr.stop(agentId!, a.id!),
          });
        }
        default:
          return JSON.stringify({
            error: `unknown action: ${String(a.action)}`,
          });
      }
    } catch (e) {
      return piToolError(e);
    }
  },
});
