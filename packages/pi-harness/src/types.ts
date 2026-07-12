/** Runtime slice of config.yaml's `pi:` key, resolved live by AgentManager. */
export interface PiRuntimeConfig {
  enabled: boolean;
  executablePath: string;
  provider?: string;
  model?: string;
  extraArgs: string[];
  maxConcurrentPerAgent: number;
  taskTimeoutMs: number;
}

/** Per-agent overrides from AGENT.md frontmatter (`pi:` key). */
export interface AgentPiOverrides {
  provider?: string;
  model?: string;
}

export type PiDelegationStatus =
  | "running"
  | "settled"
  | "failed"
  | "timed_out"
  | "stopped";

/** One JSONL line from pi's stdout. Parsed loosely — pi is an external,
 *  fast-moving protocol; unknown event types must not break us. */
export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export function isPiEvent(v: unknown): v is PiEvent {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { type?: unknown }).type === "string"
  );
}

export interface PiDelegationSummary {
  id: string;
  agentId: string;
  status: PiDelegationStatus;
  prompt: string;
  cwd: string;
  provider?: string;
  model?: string;
  pid: number | undefined;
  startedAt: number;
  endedAt: number | null;
  /** Final assistant text from the most recently settled turn, capped. */
  result?: string;
}

export class PiNotInstalledError extends Error {
  constructor(executablePath: string) {
    super(
      `pi executable not found at "${executablePath}". Install it with ` +
        `\`npm install -g @earendil-works/pi-coding-agent\` or set pi.executablePath ` +
        `in config.yaml. Note: pi needs its own provider credentials (an API key ` +
        `env var like ANTHROPIC_API_KEY, or \`pi auth login\`) — OpenAcme OAuth ` +
        `subscription tokens are not reusable by pi.`,
    );
    this.name = "PiNotInstalledError";
  }
}
