import type { Hono } from "hono";
import * as path from "node:path";
import { SkillHub, HubError } from "@openacme/skills";
import type { Config } from "@openacme/config";
import type { AgentManager } from "../agent-manager.js";

/**
 * Routes for the Skills Hub — multi-source skill import.
 *
 * Slots after the existing /api/skills* surface in app.ts. The hub
 * writes files into the same `<skillsDir>/<name>/` directory the
 * SkillRegistry loads from, so no separate registry path.
 */
export function registerSkillsHubRoutes(
  app: Hono,
  manager: AgentManager,
  config: Config
): void {
  const skillsDir = path.isAbsolute(config.skills.directory)
    ? config.skills.directory
    : path.join(config.dataDir, config.skills.directory);
  const hub = new SkillHub(skillsDir, manager.skillRegistry);

  // POST /api/skills/hub/search
  app.post("/api/skills/hub/search", async (c) => {
    let body: { query?: string; source?: string; limit?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const query = String(body.query ?? "").slice(0, 256);
    const src = sanitizeSourceFilter(body.source);
    if (!src.ok) {
      return c.json(
        { error: `source must be one of: ${SOURCE_IDS.join(", ")}, all (got '${src.bad}')` },
        400
      );
    }
    const limit = clampInt(body.limit, 1, 100, 25);
    try {
      const results = await hub.search(query, { source: src.value, limit });
      return c.json(results);
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502);
    }
  });

  // POST /api/skills/hub/inspect
  app.post("/api/skills/hub/inspect", async (c) => {
    let body: { identifier?: string; source?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const identifier = String(body.identifier ?? "").trim();
    if (!identifier) return c.json({ error: "identifier required" }, 400);
    const src = sanitizeSourceId(body.source);
    if (!src.ok) {
      return c.json(
        { error: `source must be one of: ${SOURCE_IDS.join(", ")} (got '${src.bad}')` },
        400
      );
    }
    try {
      const meta = await hub.inspect(identifier, { source: src.value });
      if (!meta) return c.json({ error: "not found" }, 404);
      return c.json(meta);
    } catch (err) {
      return c.json({ error: errMsg(err) }, 502);
    }
  });

  // POST /api/skills/hub/install
  app.post("/api/skills/hub/install", async (c) => {
    let body: {
      identifier?: string;
      source?: string;
      nameOverride?: string;
      force?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const identifier = String(body.identifier ?? "").trim();
    if (!identifier) return c.json({ error: "identifier required" }, 400);
    const src = sanitizeSourceId(body.source);
    if (!src.ok) {
      return c.json(
        { error: `source must be one of: ${SOURCE_IDS.join(", ")} (got '${src.bad}')` },
        400
      );
    }
    try {
      const result = await hub.install(identifier, {
        source: src.value,
        nameOverride: body.nameOverride,
        force: Boolean(body.force),
      });
      manager.reloadSkills();
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof HubError) {
        if (err.code === "ALREADY_INSTALLED" || err.code === "LOCAL_SKILL_EXISTS")
          return c.json({ error: err.message }, 409);
        if (err.code === "NO_SOURCE" || err.code === "NAME_MISMATCH" || err.code === "FRONTMATTER_INVALID")
          return c.json({ error: err.message }, 400);
        if (err.code === "FETCH_FAILED" || err.code === "EMPTY_BUNDLE")
          return c.json({ error: err.message }, 502);
      }
      return c.json({ error: errMsg(err) }, 500);
    }
  });

  // DELETE /api/skills/hub/installed/:name
  app.delete("/api/skills/hub/installed/:name", (c) => {
    const name = c.req.param("name");
    const ok = hub.uninstall(name);
    if (!ok) return c.json({ error: "not installed via hub" }, 404);
    manager.reloadSkills();
    return c.json({ name });
  });

  // POST /api/skills/hub/update
  app.post("/api/skills/hub/update", async (c) => {
    let body: { name?: string };
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const name = body.name?.trim();
    try {
      const result = await hub.update(name && name.length > 0 ? name : undefined);
      manager.reloadSkills();
      return c.json(result);
    } catch (err) {
      return c.json({ error: errMsg(err) }, 500);
    }
  });

  // GET /api/skills/hub/installed
  app.get("/api/skills/hub/installed", (c) => {
    return c.json(hub.listInstalled());
  });

  // GET /api/skills/hub/audit
  app.get("/api/skills/hub/audit", (c) => {
    const url = new URL(c.req.url);
    const limit = clampInt(
      url.searchParams.get("limit") ?? undefined,
      1,
      500,
      100
    );
    const actionParam = url.searchParams.get("action") ?? undefined;
    const action = isAuditAction(actionParam) ? actionParam : undefined;
    return c.json(hub.readAudit({ limit, action }));
  });

  // GET /api/skills/hub/taps
  app.get("/api/skills/hub/taps", (c) => {
    return c.json(hub.listTaps());
  });

  // POST /api/skills/hub/taps
  app.post("/api/skills/hub/taps", async (c) => {
    let body: { source?: string; repo?: string; path?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const tapSource = sanitizeTapSource(body.source);
    if (!tapSource.ok) {
      return c.json({ error: `source must be one of: ${TAP_SOURCES.join(", ")} (got '${tapSource.bad}')` }, 400);
    }
    const repo = String(body.repo ?? "").trim();
    if (!repo) return c.json({ error: "repo required" }, 400);
    try {
      const tap = hub.addTap({ source: tapSource.value, repo, path: body.path });
      return c.json(tap, 201);
    } catch (err) {
      return c.json({ error: errMsg(err) }, 400);
    }
  });

  // DELETE /api/skills/hub/taps  — body: { source, repo }. Path / URL repos
  // contain slashes, so a path param doesn't survive routing cleanly.
  app.delete("/api/skills/hub/taps", async (c) => {
    let body: { source?: string; repo?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const tapSource = sanitizeTapSource(body.source);
    if (!tapSource.ok) {
      return c.json({ error: `source must be one of: ${TAP_SOURCES.join(", ")} (got '${tapSource.bad}')` }, 400);
    }
    const repo = String(body.repo ?? "").trim();
    if (!repo) return c.json({ error: "repo required" }, 400);
    const ok = hub.removeTap(repo, tapSource.value);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ repo, source: tapSource.value });
  });
}

// ────────────────────────────────────────────────────────────────────────

const VALID_AUDIT_ACTIONS = new Set([
  "INSTALL",
  "INSTALL_FAILED",
  "UPDATE",
  "UPDATE_FAILED",
  "UNINSTALL",
  "UNINSTALL_FAILED",
  "TAP_ADD",
  "TAP_REMOVE",
]);

function isAuditAction(
  v: string | undefined
): v is
  | "INSTALL"
  | "INSTALL_FAILED"
  | "UPDATE"
  | "UPDATE_FAILED"
  | "UNINSTALL"
  | "UNINSTALL_FAILED"
  | "TAP_ADD"
  | "TAP_REMOVE" {
  return typeof v === "string" && VALID_AUDIT_ACTIONS.has(v);
}

type SourceId =
  | "github"
  | "url"
  | "claude-marketplace"
  | "well-known"
  | "local"
  | "git-url"
  | "lobehub"
  | "skills-sh"
  | "clawhub"
  | "builtin";

const SOURCE_IDS: SourceId[] = [
  "github",
  "url",
  "claude-marketplace",
  "well-known",
  "local",
  "git-url",
  "lobehub",
  "skills-sh",
  "clawhub",
  "builtin",
];

type TapSourceId = "github" | "claude-marketplace" | "well-known" | "local";
const TAP_SOURCES: TapSourceId[] = ["github", "claude-marketplace", "well-known", "local"];

// Returns the source if valid or unset, or a {bad} sentinel so the caller
// can 400 — silently mapping invalid values to undefined turns "--source bogus"
// into a quiet auto-detect, which is wrong.
function sanitizeSourceFilter(
  v: unknown
): { ok: true; value: "all" | SourceId | undefined } | { ok: false; bad: string } {
  if (v === undefined || v === null || v === "") return { ok: true, value: undefined };
  if (v === "all") return { ok: true, value: "all" };
  if (typeof v === "string" && (SOURCE_IDS as string[]).includes(v)) {
    return { ok: true, value: v as SourceId };
  }
  return { ok: false, bad: String(v) };
}

function sanitizeSourceId(
  v: unknown
): { ok: true; value: SourceId | undefined } | { ok: false; bad: string } {
  if (v === undefined || v === null || v === "") return { ok: true, value: undefined };
  if (typeof v === "string" && (SOURCE_IDS as string[]).includes(v)) {
    return { ok: true, value: v as SourceId };
  }
  return { ok: false, bad: String(v) };
}

function sanitizeTapSource(
  v: unknown
): { ok: true; value: TapSourceId } | { ok: false; bad: string } {
  if (typeof v === "string" && (TAP_SOURCES as string[]).includes(v)) {
    return { ok: true, value: v as TapSourceId };
  }
  return { ok: false, bad: String(v ?? "") };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
