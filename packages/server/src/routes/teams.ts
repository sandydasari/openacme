import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { TeamDefinitionSchema } from "@openacme/config";
import type { AgentManager } from "../agent-manager.js";

/**
 * Team CRUD. TEAM.md is human-owned — these routes (plus direct disk
 * edits) are the only write paths; there is deliberately no agent tool
 * that mutates teams, because charter bodies are injected into every
 * member's system prompt. No DELETE: `archived: true` is the lifecycle
 * end state (workspace stays readable, prompts drop the team).
 */
export function registerTeamRoutes(app: Hono, manager: AgentManager): void {
  app.get("/api/teams", (c) => {
    return c.json(manager.teamStore.list());
  });

  app.get("/api/teams/:id", (c) => {
    const team = manager.teamStore.get(c.req.param("id"));
    if (!team) return c.json({ error: "Team not found" }, 404);
    return c.json(team);
  });

  app.post("/api/teams", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const id = (body.id as string) || randomUUID();
    const parsed = TeamDefinitionSchema.safeParse({ ...body, id });
    if (!parsed.success) {
      const details = parsed.error.issues.map(
        (e) => `${e.path.join(".")}: ${e.message}`
      );
      return c.json({ error: "Validation failed", details }, 400);
    }

    try {
      const created = manager.createTeam(parsed.data);
      return c.json(created, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.put("/api/teams/:id", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    try {
      const updated = manager.updateTeam(c.req.param("id"), body);
      return c.json(updated);
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("not found")) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: message }, 400);
    }
  });
}
