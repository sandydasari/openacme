// Shared API response types — mirrored (not imported) from server packages
// so the static export build doesn't pull node-only deps.

import type { UIMessage } from "ai";

/**
 * Mirror of `OpenAcmeDataParts` in `@openacme/agent-core/src/types.ts`.
 * Kept in sync by hand — both sides must match for the typed `useChat`
 * onData callback (and `writer.write` server-side) to type-check
 * end-to-end. New entry here = new entry there.
 */
export interface OpenAcmeDataParts {
  session: { sessionId: string };
  status: {
    id: string;
    kind: "info" | "warn" | "error" | "compressing" | "compressed";
    message: string;
  };
  /** Persisted on the USER message. Carries entries for the chip + the
   *  pre-rendered `modelContent` string materialized into model input
   *  by uiToModelMessages on every load (byte-stable across turns). */
  "relevant-memory": {
    entries: Array<{
      path: string;
      mtimeMs: number;
      content: string;
    }>;
    modelContent: string;
  };
  /** Appended to the assistant message when streamText fails. Renders
   *  as a destructive block in MessageBubble. */
  "upstream-error": {
    provider?: string;
    statusCode?: number;
    message: string;
  };
  /** Ambient-Acme view context, attached to a user message by the panel.
   *  `modelContent` is materialized into model input (latest user message
   *  only) server-side; the small fields drive a context chip. */
  "ui-context": {
    page: string;
    entityType: string | null;
    entityId: string | null;
    tab?: string | null;
    modelContent: string;
  };
  /** Skills referenced with `/name` in the composer, attached to the user
   *  message. `modelContent` is materialized into model input per-message
   *  server-side; `names` drives a chip in the user bubble. */
  "skill-ref": {
    names: string[];
    modelContent: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Mirror of `MessageMetadata` in `@openacme/agent-core/src/types.ts`.
 * Tags persisted messages so the UI can route or filter them.
 * `autonomous_event` = scheduler-driven autonomous wake message,
 * hidden from the chat view (the agent's response renders standalone).
 */
export type MessageMetadataKind = "autonomous_event";

export interface MessageMetadata {
  kind?: MessageMetadataKind;
  [key: string]: unknown;
}

// Mirror of COMMENT_KINDS / EVENT_KINDS in @openacme/tasks/ports.ts.
// The web bundle is static — it can't import from server packages — so
// these literals must be kept in sync by hand. Adding a new kind:
// edit the canonical list in tasks/ports.ts THEN extend the matching
// `as const` array here. The TS error at every reader if you only do
// one is the safety net.

export const COMMENT_KINDS = ["result", "system"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export const EVENT_KINDS = [
  "task_assigned",
  "status_changed",
  "dep_unblocked",
  "comment_added",
  "task_deleted",
  "scheduler_action",
  "task_completed_run",
  "ping_user",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * Home page payload returned by GET /api/home — three buckets sorted
 * Waiting → Running → Idle. Sessions whose tasks are all terminal
 * don't appear. Mirror of `HomePayload` in @openacme/server.
 */
export interface SessionSummary {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentAvatar?: string;
  title: string | null;
  status: "waiting" | "running" | "idle";
  currentTaskTitle: string | null;
  pendingTaskCount: number;
  lastActivity: number;
  deferUntil: number | null;
  pingMessage?: string;
}

export interface HomePayload {
  waiting: SessionSummary[];
  running: SessionSummary[];
  idle: SessionSummary[];
}

export type OpenAcmeUIMessage = UIMessage<
  MessageMetadata,
  OpenAcmeDataParts
>;

export interface ToolInfo {
  name: string;
  description: string;
  toolset: string;
  emoji?: string;
  /** Always-on tool merged into every agent regardless of the agent's
   *  `tools` config — hidden from the picker. */
  system?: boolean;
}

export interface ModelPreset {
  id: string;
  label: string;
  hint?: string;
  /** Modalities the model accepts on input — e.g. ["text", "image", "pdf"].
   *  Undefined when the bundled registry has no entry; conservatively
   *  treated as "text-only" by the file-picker gate but allowed through
   *  by the server's gate (which is itself defensive). */
  inputModalities?: string[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  requiresApiKey: boolean;
  envVar?: string;
  defaultBaseUrl?: string;
  supportsOAuth?: boolean;
  /** Live: an env-var or stored API key is set for this provider. */
  apiKeyConfigured: boolean;
  /** Live: a usable OAuth access token is stored in auth.json for
   *  this provider. Only ever true for providers where
   *  supportsOAuth === true. */
  oauthConfigured: boolean;
  models: ModelPreset[];
}

/** A committed attachment row as returned by /api/sessions/:id/messages
 *  and /api/uploads. The `id` is what the user-bubble image/PDF link
 *  resolves against `/api/attachments/:id`. */
export interface AttachmentRow {
  id: string;
  kind: "image" | "file";
  mediaType: string;
  size: number;
  originalName: string | null;
}

export const ALLOWED_UPLOAD_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;

export const UPLOAD_LIMITS = {
  perFileBytes: 5 * 1024 * 1024,
  perRequestBytes: 25 * 1024 * 1024,
  perRequestFiles: 10,
} as const;

// Mirror of `ConfigResponse.model` from @openacme/server/src/app.ts. Workforce
// default — every agent without its own `model:` block inherits this.
export interface ModelDefaultsView {
  provider?: string;
  model?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  auth: "api_key" | "oauth";
  cacheTtl: "5m" | "1h";
}

// Mirror of `ModelDefaultsUpdate` — body shape for PUT /api/config/model.
export type ModelDefaultsUpdate = Partial<ModelDefaultsView>;

// ── Usage ledger (mirrored, not imported, from @openacme/db +
//    @openacme/server/src/routes/usage.ts) ────────────────────────────

export const USAGE_KINDS = [
  "interactive",
  "autonomous",
  "extractor",
  "title",
  "selector",
  "summarizer",
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export interface UsageEventRow {
  id: string;
  createdAt: number;
  agentId: string;
  sessionId: string;
  messageId: string | null;
  taskId: string | null;
  kind: UsageKind;
  provider: string;
  model: string;
  authMode: "api_key" | "oauth" | "local";
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number;
  costUsd: number | null;
  costUsdEquivalent: number | null;
  costSource: "estimated" | "provider_reported" | "subscription" | "free";
  steps: number | null;
  durationMs: number | null;
}

export interface UsageTotals {
  costUsd: number;
  costUsdEquivalent: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  events: number;
  costUsdByAuthMode: Record<string, number>;
  eventsByKind: Record<string, number>;
}

export interface UsageSummaryResponse {
  range: { from: number; to: number };
  totals: UsageTotals;
  previous: UsageTotals;
  cacheSavingsUsd: number;
  forecast: { monthToDateUsd: number; projectedMonthUsd: number };
  anomaly: { todayUsd: number; trailingMeanUsd: number; flagged: boolean };
}

export interface UsageSeriesRow {
  t: number;
  key: string;
  costUsd: number;
  costUsdEquivalent: number;
  totalTokens: number;
  events: number;
}

export interface UsageBreakdownRow {
  key: string;
  costUsd: number;
  costUsdEquivalent: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  events: number;
  lastAt: number;
}

export interface UsageHeatmapResponse {
  range: { from: number; to: number };
  daily: Array<{
    day: string;
    agentId: string;
    costUsd: number;
    costUsdEquivalent: number;
    totalTokens: number;
    events: number;
  }>;
  hours: Array<{
    agentId: string;
    hour: number;
    costUsd: number;
    costUsdEquivalent: number;
    events: number;
  }>;
}
