/**
 * Dispatcher — periodic state-checker that wakes agents when there's
 * work to do. Replaces the event-driven `TaskScheduler` with a much
 * smaller state model:
 *
 *   - One `setInterval(60_000)` tick is the autonomous floor.
 *   - Per-agent serial chain (`Map<agentId, Promise>`) ensures one
 *     turn at a time per agent.
 *   - Spawn rule: chain free AND (inbox rows OR in_progress OR ready
 *     open OR only-blocked tasks).
 *   - `sessions.defer_until` honoured — skips routine spawns while
 *     active, bypassed by new inbox rows.
 *   - Startup sweep flips stale `in_progress` → `open` (crash recovery
 *     for the daemon-died-mid-turn case).
 *   - `markInteractiveBusy` / `clearInteractiveBusy` preserve the
 *     existing `/api/chat` flow: dispatcher's tick skips sessions
 *     marked busy so autonomous + interactive don't collide.
 *
 * What's gone (vs `TaskScheduler`):
 *   - `onEvent` per-kind routing tree
 *   - debounce / rate-limit / `wakeBySession` map
 *   - watchdog `noClaimStreak`
 *   - heartbeat probes / `probeArmed` cron registry
 *   - `armed` cron registry for `start_at` (tick reads `start_at` ≤ now)
 *   - echo filter (moved to inbox-delivery boundary in AgentManager)
 *   - `wakeRequestedDuringTurn` (chain pickup handles in-flight
 *     events naturally — they sit in inbox until the chain frees up)
 */

import type { TaskStore, Task } from "@openacme/tasks";
import { AutonomousTurnTimeout, extractErrorText } from "@openacme/agent-core";
import type { SessionStore, InboxStore } from "@openacme/db";
import { createLogger } from "@openacme/config/logger";
import type { AgentManager } from "./agent-manager.js";
import type { SessionBroadcaster } from "./broadcaster.js";

const log = createLogger("server.dispatcher");

/** Tick floor. Override in tests for fast iteration. */
const DEFAULT_TICK_MS = 60_000;
/** Park-on-failure backoff. Same value the old TaskScheduler used. */
const PARK_BACKOFF_MS = 5 * 60_000;

export interface DispatcherOptions {
  taskStore: TaskStore;
  sessionStore: SessionStore;
  inboxStore: InboxStore;
  agentManager: AgentManager;
  broadcaster?: SessionBroadcaster;
  /** Override the wall clock — test seam. */
  now?: () => Date;
  /** Override the tick interval. Production is `DEFAULT_TICK_MS`. */
  tickIntervalMs?: number;
}

export class Dispatcher {
  private readonly taskStore: TaskStore;
  private readonly sessionStore: SessionStore;
  private readonly inboxStore: InboxStore;
  private readonly agentManager: AgentManager;
  private readonly broadcaster: SessionBroadcaster | null;
  private readonly now: () => Date;
  private readonly tickIntervalMs: number;

  /** Per-agent serial chain — only one turn at a time per agent. */
  private chains = new Map<string, Promise<void>>();
  /** Sessions currently running a turn (autonomous OR interactive).
   *  Powers `runningSessionIds()` for the home view. */
  private runningSessions = new Set<string>();
  /** Sessions with an in-flight interactive `/api/chat` turn. Tick
   *  skips these so autonomous spawn doesn't race the chat reply.
   *  When the interactive turn ends and there's pending inbox work,
   *  the next tick (or the chain free-up if a turn was already
   *  queued) picks it up. */
  private interactiveBusy = new Set<string>();
  /** Track agent ids we've warned about as missing. Without this an
   *  orphan agent (deleted but still referenced) produces a warning
   *  every tick. */
  private missingAgentsLogged = new Set<string>();
  /** True between `start()` and `stop()`. */
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: DispatcherOptions) {
    this.taskStore = opts.taskStore;
    this.sessionStore = opts.sessionStore;
    this.inboxStore = opts.inboxStore;
    this.agentManager = opts.agentManager;
    this.broadcaster = opts.broadcaster ?? null;
    this.now = opts.now ?? (() => new Date());
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.startupSweep();
    this.timer = setInterval(() => {
      this.tickSafe().catch((e) =>
        log.warn({ err: e }, "dispatcher tick threw")
      );
    }, this.tickIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.interactiveBusy.clear();
  }

  /**
   * Await any in-flight turn chains. Use during graceful shutdown
   * (CLI exit, daemon stop) after `stop()`. Same shape as the old
   * scheduler — bounded by `timeoutMs` so a turn stuck on a slow
   * LLM call doesn't block exit indefinitely.
   */
  async drain(timeoutMs = 5_000): Promise<void> {
    const chains = [...this.chains.values()];
    if (chains.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => resolve(), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    await Promise.race([
      Promise.allSettled(chains).then(() => undefined),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Sessions currently running a turn — union of autonomous turns in
   * flight (tracked in `runningSessions`) and interactive turns from
   * `/api/chat` (tracked in `interactiveBusy`). Powers the home view's
   * "running" indicator. Without unioning, the home view would miss
   * interactive turns that aren't dispatched by the scheduler.
   */
  runningSessionIds(): string[] {
    const all = new Set<string>(this.runningSessions);
    for (const id of this.interactiveBusy) all.add(id);
    return [...all];
  }

  /**
   * True if EITHER an autonomous turn (tick-spawned) OR an interactive
   * turn (`/api/chat`) is in flight for this session. `/api/chat` reads
   * this to decide whether a new POST should queue to the inbox (so the
   * in-flight turn drains it next) instead of spawning a parallel
   * `runChatTurn` — without the union check, autonomous turns are
   * invisible to the chat route and the two turns race.
   */
  isRunning(sessionId: string): boolean {
    return (
      this.runningSessions.has(sessionId) ||
      this.interactiveBusy.has(sessionId)
    );
  }

  /**
   * `/api/chat` calls this when it starts driving a turn directly
   * (via `runChatTurn`). The dispatcher's tick skips sessions in
   * this set so we don't try to spawn an autonomous turn into the
   * same session the chat handler is already streaming through.
   */
  markInteractiveBusy(sessionId: string): void {
    this.interactiveBusy.add(sessionId);
  }

  clearInteractiveBusy(sessionId: string): void {
    if (!this.interactiveBusy.delete(sessionId)) return;
    // The chat turn just ended — if there's pending inbox work for this
    // session's agent, kick a tick immediately so the agent picks it up
    // without waiting up to 60 s for the periodic tick.
    if (!this.running) return;
    this.tickSafe().catch((e) =>
      log.warn({ err: e, sessionId }, "post-interactive tick threw")
    );
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async tickSafe(): Promise<void> {
    if (!this.running) return;
    try {
      await this.tick();
    } catch (e) {
      log.warn({ err: e }, "dispatcher tick failed");
    }
  }

  /**
   * One pass over the board. Walks every agent; for each agent whose
   * chain is free, finds the first session that has work and spawns
   * a turn for it. State-checking only — no event routing, no debounce.
   */
  private async tick(): Promise<void> {
    const agents = this.agentManager.listAgents();
    const nowMs = this.now().getTime();

    for (const agentDef of agents) {
      const agentId = agentDef.id;
      if (this.chains.has(agentId)) continue;

      // First, allocate sessions for any unbound ready tasks assigned
      // to this agent. The old scheduler did this on every relevant
      // event; the dispatcher does it on every tick because the
      // alternative — unbound tasks invisibly accumulating — would
      // mean the spawn loop below (per-session) never sees them.
      await this.bindUnboundTasks(agentId, nowMs);

      const pending = this.inboxStore.pendingFor(agentId);
      const inboxCount = pending.length;

      // If the inbox has rows pointing at a specific session, prefer
      // that session as the spawn target. user_message rows always
      // carry relatedSession; system_notices set it for task events
      // that have a bound session. Spawning the "wrong" session would
      // leave the relevant inbox row addressed-but-not-drainable.
      const targetedSessions = new Set<string>();
      for (const row of pending) {
        if (row.relatedSession) targetedSessions.add(row.relatedSession);
      }

      const sessions = this.sessionStore.listActive(agentId);
      // Sort: targeted sessions first, then everyone else by recency
      // (listActive already returns by updated desc).
      const ordered = [
        ...sessions.filter((s) => targetedSessions.has(s.id)),
        ...sessions.filter((s) => !targetedSessions.has(s.id)),
      ];

      for (const session of ordered) {
        if (this.interactiveBusy.has(session.id)) continue;

        // Defer check — skip routine spawns until `defer_until`.
        // New inbox rows bypass: defer is "no routine checks," not
        // "ignore real signals."
        if (
          session.deferUntil != null &&
          session.deferUntil * 1000 > nowMs &&
          inboxCount === 0
        ) {
          continue;
        }

        if (this.shouldSpawn(session.id, nowMs, inboxCount)) {
          this.enqueueTurn(agentId, session.id);
          break; // one session per agent per tick (chain is per-agent)
        }
      }
    }
  }

  /**
   * Walk this agent's tasks; for any that are status=open + deps
   * satisfied + start_at clear AND have no session bound, create a
   * fresh session and bind it. Subsequent spawn-decision logic only
   * walks sessions, so without this step unbound tasks would sit
   * invisibly forever.
   */
  private async bindUnboundTasks(agentId: string, nowMs: number): Promise<void> {
    const tasks = this.taskStore.list({ assignee: agentId });
    for (const t of tasks) {
      if (t.session_id) continue;
      if (t.status !== "open") continue;
      if (!isStartReady(t.start_at, nowMs)) continue;
      if (!this.depsSatisfied(t)) continue;
      try {
        const session = this.sessionStore.create(agentId, {
          title: t.title.slice(0, 80),
        });
        await this.taskStore.update(t.id, { session_id: session.id });
      } catch (e) {
        log.warn(
          { err: e, taskId: t.id, agentId },
          "bindUnboundTasks: failed to allocate session"
        );
      }
    }
  }

  /**
   * Spawn rule. Returns true if the dispatcher should run a turn for
   * this (agent, session) right now.
   *
   * Triggers:
   *   - Pending inbox rows (a signal arrived addressed to this agent).
   *   - An `in_progress` task in this session (continuation — agent
   *     should keep working or close out).
   *   - A ready `open` task assigned to this agent and bound to this
   *     session (status = open, deps satisfied, start_at clear).
   *   - Only `blocked` tasks remain for this session — wake to let
   *     the agent revisit / unblock / defer.
   *
   * "Open task with no session_id yet" is handled at create time —
   * the agent claims a task by setting in_progress + session_id, so
   * unbound tasks aren't a dispatcher concern.
   */
  private shouldSpawn(
    sessionId: string,
    nowMs: number,
    inboxCount: number
  ): boolean {
    if (inboxCount > 0) return true;
    const tasks = this.taskStore.list({ session_id: sessionId });
    let hasReady = false;
    let hasBlocked = false;
    for (const t of tasks) {
      if (t.status === "in_progress") {
        // Recurring task that fired recently: respect its interval as a
        // wake floor. Without this, an agent that leaves the recurring
        // task in_progress between fires (common pattern for tick-style
        // tasks where the agent appends progress comments instead of
        // calling task_update(done) each cycle) gets re-woken every 60s
        // — ~30 wasted LLM calls per intended 30-min interval. Real
        // signals (inbox row, cross-agent comment) still bypass: that's
        // handled above by `inboxCount > 0`.
        if (
          t.recurrence?.kind === "interval" &&
          t.last_run_at != null
        ) {
          const lastMs = Date.parse(t.last_run_at);
          if (
            Number.isFinite(lastMs) &&
            lastMs + t.recurrence.every_ms > nowMs
          ) {
            continue;
          }
        }
        return true;
      }
      if (t.status === "open" && isStartReady(t.start_at, nowMs) && this.depsSatisfied(t)) {
        hasReady = true;
      } else if (t.status === "blocked") {
        hasBlocked = true;
      }
    }
    // Returning true on "only blocked tasks" means the dispatcher
    // periodically nudges the agent to revisit. The agent can call
    // `defer_session(duration)` to suppress this if it doesn't want
    // to be checked back so often.
    return hasReady || hasBlocked;
  }

  private depsSatisfied(t: Task): boolean {
    if (t.depends_on.length === 0) return true;
    return t.depends_on.every((dep) => {
      const d = this.taskStore.get(dep);
      return d?.status === "done";
    });
  }

  /**
   * Append a turn to the agent's serial chain. Marks the session running,
   * broadcasts state, runs the turn, then cleans up in the finally block.
   *
   * Defer is now sticky — we do NOT clear `defer_until` on spawn. The
   * previous one-shot behavior caused this: a defer of 2h would hold for
   * a while, then the first real signal (inbox row, post-interactive
   * tick) would legitimately wake the agent AND wipe defer; from that
   * point on every periodic 60s tick would re-spawn because nothing
   * suppressed it (any in-progress task triggers `shouldSpawn`). With
   * defer sticky, the same first signal still wakes the agent, but
   * defer stays in place and holds against subsequent pure-tick wakes
   * for the rest of the window. Only an explicit `defer_session` call
   * (or natural expiry) changes it.
   */
  private enqueueTurn(agentId: string, sessionId: string): void {
    if (this.chains.has(agentId)) return;
    if (!this.agentExists(agentId)) {
      if (!this.missingAgentsLogged.has(agentId)) {
        this.missingAgentsLogged.add(agentId);
        log.warn(
          { agentId },
          "agent referenced by sessions/tasks but no longer exists — wakes skipped"
        );
      }
      return;
    }

    this.runningSessions.add(sessionId);
    if (this.broadcaster) {
      this.broadcaster.broadcast(sessionId, {
        kind: "session_state",
        state: "running",
      });
    }

    const promise = this.runTurn(agentId, sessionId).finally(() => {
      this.chains.delete(agentId);
      this.runningSessions.delete(sessionId);
      if (this.broadcaster) {
        this.broadcaster.broadcast(sessionId, {
          kind: "session_state",
          state: "idle",
        });
      }
    });
    this.chains.set(agentId, promise);
  }

  private async runTurn(
    agentId: string,
    sessionId: string
  ): Promise<void> {
    if (!this.running) return;
    let agent;
    try {
      agent = this.agentManager.getAgent(agentId);
    } catch (e) {
      log.warn(
        { agentId, sessionId, err: e },
        "agent not available for session"
      );
      return;
    }

    try {
      await agent.runAutonomous({ sessionId });
    } catch (e) {
      const message = extractErrorText(e);
      const isTimeout = e instanceof AutonomousTurnTimeout;
      if (!isTimeout) {
        log.warn({ sessionId, message }, "autonomous turn failed");
      }
      await this.parkInProgress(sessionId, {
        action: isTimeout ? "timeout" : "error",
        message: isTimeout
          ? `turn timed out at ${this.now().toISOString()}`
          : `turn errored at ${this.now().toISOString()}: ${message}`,
      });
    }
  }

  /**
   * After a failed turn, find any task the agent had marked
   * `in_progress` in this session and park it with `start_at = now
   * + PARK_BACKOFF_MS` and a `system:scheduler` comment explaining
   * the failure. Same shape as the old scheduler's `parkInProgress`.
   * If the agent never claimed anything, there's nothing to park —
   * the next tick will retry the same condition.
   */
  private async parkInProgress(
    sessionId: string,
    note: { action: "timeout" | "error"; message: string }
  ): Promise<void> {
    const inProg = this.taskStore.list({
      session_id: sessionId,
      status: "in_progress",
    });
    const retryAt = new Date(this.now().getTime() + PARK_BACKOFF_MS);
    for (const task of inProg) {
      try {
        await this.taskStore.park({
          id: task.id,
          retryAt,
          reason: `[${note.action}] ${note.message}`,
        });
      } catch (e) {
        log.warn({ err: e, taskId: task.id }, "parkInProgress failed");
      }
    }
  }

  /**
   * Startup pass. Runs once at `start()`:
   *   - Flip stale `in_progress` tasks back to `open` (covers the
   *     daemon-died-mid-turn case — the agent process is gone, so
   *     by definition no in-flight turn exists right now).
   *   - Trigger one tick so any pending work is picked up
   *     immediately rather than waiting up to `tickIntervalMs`.
   */
  private async startupSweep(): Promise<void> {
    try {
      const reset = await this.taskStore.sweepStale(this.now());
      if (reset.length > 0) {
        log.info(
          { count: reset.length },
          "reset stale in-progress tasks on startup"
        );
      }
    } catch (e) {
      log.warn({ err: e }, "startup sweep failed");
    }
    await this.tickSafe();
  }

  private agentExists(agentId: string): boolean {
    try {
      return this.agentManager.getAgentDef(agentId) !== null;
    } catch {
      return false;
    }
  }
}

/**
 * Returns true if a task's `start_at` is null or has already passed.
 * Malformed timestamps fall through as "ready now" — same lenient
 * behaviour as the old scheduler's `isFutureStart`.
 */
function isStartReady(startAt: string | null, nowMs: number): boolean {
  if (!startAt) return true;
  const t = Date.parse(startAt);
  if (!Number.isFinite(t)) return true;
  return t <= nowMs;
}
