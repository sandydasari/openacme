import type { Hono } from "hono";
import { homedir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import {
  oauthLoginOpenAI,
  loginWithClaudeCodeCredentials,
  looksHeadless,
} from "@openacme/auth";
import { readRawConfig, writeRawConfig, type Provider, type AuthMode } from "@openacme/config";
import { DEFAULT_MODEL_BY_PROVIDER } from "@openacme/llm-provider";
import type { AgentManager } from "../agent-manager.js";

export interface SetupRoutesOptions {
  dataDir: string;
  /** Set by `createApp` so setup endpoints can refresh AgentManager's
   *  cached `config` after writing a new default model to config.yaml.
   *  Without this, the platform default model the agents see stays stale
   *  until the daemon restarts. */
  manager: AgentManager;
}

/**
 * Write a top-level `model` to config.yaml when the user finishes setting
 * up a provider, BUT only if no `model` is already configured. Picks the
 * recommended default from `DEFAULT_MODEL_BY_PROVIDER` so the agent that
 * inherits the platform default (e.g. the bundled Acme) doesn't fall back
 * to the schema's `openrouter` default after a user signed in with a
 * different provider.
 *
 * Idempotent + non-destructive: if the user already has a model set
 * (manually, or from a previous setup run), we leave it alone.
 */
export function setDefaultModelIfUnset(
  dataDir: string,
  opts: { provider: Provider; auth: AuthMode; baseUrl?: string }
): void {
  const raw = readRawConfig(dataDir);
  const existing = raw.model as { model?: unknown } | undefined;
  if (existing && typeof existing === "object" && typeof existing.model === "string" && existing.model) {
    return;
  }
  const modelId = DEFAULT_MODEL_BY_PROVIDER[opts.provider];
  if (!modelId) return;
  const next: Record<string, unknown> = {
    ...raw,
    model: {
      provider: opts.provider,
      model: modelId,
      auth: opts.auth,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    },
  };
  writeRawConfig(dataDir, next);
}

/**
 * Provider-credential setup routes invoked by the chat-onboarding panel.
 * Mounted under /api/setup/* so the access-secret middleware applies on
 * non-loopback daemons — /api/auth/* is whitelisted and would bypass it.
 */
export function registerSetupRoutes(app: Hono, opts: SetupRoutesOptions): void {
  // OpenAI: blocks until the existing CLI loopback flow on :1455 receives
  // the callback (or its internal 5-minute timeout fires). The web side
  // shows a "waiting" state for the duration of this request.
  app.post("/api/setup/oauth-start", async (c) => {
    let body: { provider?: string };
    try {
      body = (await c.req.json()) as { provider?: string };
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (body.provider !== "openai") {
      return c.json(
        {
          error:
            "Only OpenAI supports browser OAuth from the web today. " +
            "For Anthropic, paste a Claude setup token or import from Claude Code.",
        },
        400
      );
    }
    if (looksHeadless()) {
      return c.json(
        {
          error:
            "Daemon can't open a browser (no display detected). " +
            "Use `openacme login --provider openai --device` from a terminal.",
        },
        400
      );
    }
    try {
      const result = await oauthLoginOpenAI({
        dataDir: opts.dataDir,
        flow: "browser",
      });
      setDefaultModelIfUnset(opts.dataDir, { provider: "openai", auth: "oauth" });
      opts.manager.reloadConfig();
      return c.json({ success: true, email: result.email ?? null });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "OAuth failed" },
        500
      );
    }
  });

  // Claude Code keychain import. Explicit `importNow: true` body required
  // because on macOS this triggers a Touch ID / keychain prompt — never
  // expose passively.
  app.post("/api/setup/anthropic-claude-code-import", async (c) => {
    let body: { importNow?: boolean };
    try {
      body = (await c.req.json()) as { importNow?: boolean };
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (body.importNow !== true) {
      return c.json({ error: "importNow must be true" }, 400);
    }
    try {
      const result = await loginWithClaudeCodeCredentials(opts.dataDir);
      if (!result) {
        return c.json({ error: "no Claude Code credentials found" }, 404);
      }
      setDefaultModelIfUnset(opts.dataDir, { provider: "anthropic", auth: "oauth" });
      opts.manager.reloadConfig();
      return c.json({ imported: true });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "import failed" },
        500
      );
    }
  });

  // File-existence probe only — does NOT read keychain or contents.
  // Drives whether the panel surfaces the "Import from Claude Code" button.
  app.get("/api/setup/claude-code-available", (c) => {
    const home = homedir();
    const candidates = [
      join(home, ".claude", ".credentials.json"),
      join(home, ".claude.json"),
    ];
    const available = candidates.some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    return c.json({ available });
  });
}
