import * as path from "node:path";
import { getCurrentWorkspaceDir } from "./session-context.js";

export function buildToolHomeEnv(
  workspaceDir = getCurrentWorkspaceDir(),
): NodeJS.ProcessEnv {
  if (!workspaceDir) return {};
  return {
    WORKSPACE_HOME: workspaceDir,
    AGENT_HOME: path.dirname(workspaceDir),
  };
}
