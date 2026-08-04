import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("chat upstream error logging", () => {
  it("persists the provider error and writes a meaningful log line", async () => {
    const prevDataDir = process.env["OPENACME_DATA_DIR"];
    const prevLogFile = process.env["OPENACME_LOG_FILE"];
    const dataDir = mkdtempSync(path.join(tmpdir(), "openacme-log-test-"));
    const logFile = path.join(dataDir, "openacme.log");
    let manager: { close: () => Promise<void> } | undefined;

    try {
      vi.resetModules();
      process.env["OPENACME_DATA_DIR"] = dataDir;
      process.env["OPENACME_LOG_FILE"] = logFile;

      const { ConfigSchema } = await import("@openacme/config");
      const { createApp } = await import("../src/app.js");
      const { createStubModel } = await import(
        "./e2e/support/stub-model.mjs"
      );

      const config = ConfigSchema.parse({
        dataDir,
        model: {
          provider: "custom",
          model: "stub-1",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "stub",
        },
        server: { host: "127.0.0.1", requireAuth: false },
      });
      const created = await createApp(config, {
        resolveModel: () => createStubModel(),
      });
      manager = created.manager;

      const headers = {
        host: "127.0.0.1",
        "content-type": "application/json",
      };
      const createRes = await created.app.request("/api/agents", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "helper", name: "Helper" }),
      });
      expect(createRes.status).toBe(201);

      const sessionId = randomUUID();
      const failureText = "scripted failure object log check";
      const chatRes = await created.app.request("/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({
          agentId: "helper",
          sessionId,
          messages: [
            {
              id: randomUUID(),
              role: "user",
              parts: [
                { type: "text", text: `break [[mock:error:${failureText}]]` },
              ],
            },
          ],
        }),
      });
      expect(chatRes.status).toBe(200);

      for (let i = 0; i < 80; i++) {
        const assistant = created.manager.messageStore
          .getHistory(sessionId)
          .find((m) => m.role === "assistant");
        if (assistant) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const assistant = created.manager.messageStore
        .getHistory(sessionId)
        .find((m) => m.role === "assistant");
      const errorPart = assistant?.parts.find(
        (p) => p?.type === "data-upstream-error"
      ) as { data?: { message?: string } } | undefined;
      expect(errorPart?.data?.message).toContain(failureText);

      const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      expect(log).toContain("chat turn upstream provider error");
      expect(log).toContain(failureText);
      expect(log).not.toContain("[object Object]");
    } finally {
      await manager?.close();
      if (prevDataDir === undefined) delete process.env["OPENACME_DATA_DIR"];
      else process.env["OPENACME_DATA_DIR"] = prevDataDir;
      if (prevLogFile === undefined) delete process.env["OPENACME_LOG_FILE"];
      else process.env["OPENACME_LOG_FILE"] = prevLogFile;
      rmSync(dataDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
