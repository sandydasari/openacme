export { ToolRegistry, registry } from "./registry.js";
export type { ToolEntry, ToolSchema, ToolDefinition, ToolInfo } from "./types.js";
export {
  bindSessionSearch,
  type SessionSearchBindings,
  type SessionSearchFn,
  type SessionSearchHit,
  type ResolveRootFn,
} from "./builtins/session-search.js";
export {
  bindSkillView,
  type SkillViewBindings,
  type SkillViewEntry,
} from "./builtins/skill.js";
export {
  bindReloadConfig,
  type ReloadConfigFn,
} from "./builtins/reload-config.js";
export {
  toolCallContext,
  getCurrentSessionId,
  getCurrentAgentId,
  getCurrentWorkspaceDir,
  type ToolCallContext,
} from "./session-context.js";
export {
  closeShellSession,
  closeAllShellSessions,
} from "./internal/shell-session.js";
export {
  bindProcessEvents,
  type ProcessBindings,
  type ProcessCompletionEvent,
} from "./builtins/process.js";
export {
  bindMemory,
  type MemoryBindings,
} from "./builtins/memory.js";
export {
  bindTaskStore,
  type TaskStoreBindings,
} from "./builtins/tasks.js";
export {
  bindBrowser,
  type BrowserBindings,
} from "./builtins/browser/bindings.js";
export {
  bindEmail,
  EMAIL_TOOL_NAMES,
  type EmailBindings,
} from "./builtins/email/bindings.js";
export {
  bindAgentTool,
  type AgentToolBindings,
  type AgentSummary,
  type PeerNote,
} from "./builtins/agent.js";
export {
  bindPingUser,
  type PingUserBindings,
  type PingUserEventEmit,
} from "./builtins/ping.js";
export {
  bindDeferSession,
  type DeferSessionBindings,
} from "./builtins/defer-session.js";
export {
  bindToolHost,
  getToolHostDispatcher,
  type ToolHostDispatcher,
} from "./tool-host-binding.js";
export { SYSTEM_TOOLS, type SystemTool } from "./system.js";
export {
  sweepOverflow,
  spillSnapshot,
  deleteSessionToolCalls,
  DEFAULT_SPILL_THRESHOLD,
  TOOL_CALLS_DIR,
} from "./spill.js";

// Import builtins to trigger self-registration
import "./builtins/shell.js";
import "./builtins/file.js";
import "./builtins/session-search.js";
import "./builtins/reload-config.js";
import "./builtins/edit.js";
import "./builtins/apply-patch.js";
import "./builtins/web-extract.js";
import "./builtins/web-search.js";
import "./builtins/execute_code.js";
import "./builtins/process.js";
import "./builtins/skill.js";
import "./builtins/memory.js";
import "./builtins/tasks.js";
import "./builtins/agent.js";
import "./builtins/ping.js";
import "./builtins/defer-session.js";
import "./builtins/browser/index.js";
import "./builtins/email/index.js";
