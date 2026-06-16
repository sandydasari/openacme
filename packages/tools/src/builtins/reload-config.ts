import { z } from "zod";
import { registry } from "../registry.js";

export type ReloadConfigFn = () => Promise<{ restartRequired: string[] }>;

// Bound at runtime by AgentManager (keeps @openacme/tools free of a server
// dependency). Until bound, the tool reports a clear error.
let reload: ReloadConfigFn | null = null;

export function bindReloadConfig(fn: ReloadConfigFn): void {
  reload = fn;
}

registry.register({
  name: "reload_config",
  toolset: "platform",
  description:
    "Apply platform config you've edited on disk — config.yaml (model, " +
    "behavior, browser, email), AGENTS.md, mcp.json, coworkers' AGENT.md, and " +
    "skills — without a daemon restart. Nothing applies automatically: edit " +
    "the files first, then call this ONCE as your final step to make every " +
    "change take effect on the next turn. It reconnects MCP servers, so it " +
    "can take a few seconds. Changing the server host/port is the only thing " +
    "this can't apply live (returned in `restartRequired`).",
  parameters: z.object({}),
  emoji: "♻️",
  // Daemon-runtime: runs in the server process (it reloads manager state), not
  // the sandbox worker — so reconnecting MCP / restarting workers can't kill
  // the calling agent's own turn.
  runtime: "daemon",
  parallelSafe: false,
  handler: async () => {
    if (!reload) {
      return JSON.stringify({
        error:
          "reload_config not initialized — AgentManager must call bindReloadConfig().",
      });
    }
    const { restartRequired } = await reload();
    return JSON.stringify({
      success: true,
      applied: "config.yaml, AGENTS.md, mcp.json, agents, skills",
      restartRequired,
      note:
        restartRequired.length > 0
          ? `Applied. These changes still need a manual daemon restart: ${restartRequired.join(", ")}.`
          : "Applied — all changes take effect on the next turn, no restart.",
    });
  },
});
