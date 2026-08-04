import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applySchema,
  WasmDatabase,
  createSessionStore,
  createMessageStore,
  createInboxStore,
} from "@openacme/db";
import { MemoryStore } from "@openacme/memory";
import { TaskStore } from "@openacme/tasks";
import type { ToolRegistry } from "@openacme/tools";
import type { UIMessage } from "ai";
import { Agent, type AutonomousBroadcaster } from "../src/agent.js";
import type { AgentConfig } from "../src/types.js";
import * as titleModule from "../src/title.js";

const stubToolRegistry = {
  get: () => undefined,
  getVercelTools: () => ({}),
} as unknown as ToolRegistry;

function freshDb() {
  const db = new WasmDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function makeAgent(): {
  agent: Agent;
  broadcasts: Array<{
    sessionId: string;
    event: Parameters<AutonomousBroadcaster["broadcast"]>[1];
  }>;
} {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-title-"));
  const db = freshDb();
  const sessionStore = createSessionStore(db);
  const messageStore = createMessageStore(db);
  const broadcasts: Array<{
    sessionId: string;
    event: Parameters<AutonomousBroadcaster["broadcast"]>[1];
  }> = [];
  const broadcaster: AutonomousBroadcaster = {
    broadcast(sessionId, event) {
      broadcasts.push({ sessionId, event });
    },
  };
  const config: AgentConfig = {
    id: "a1",
    name: "A1",
    model: {
      provider: "openai",
      model: "test",
      apiKey: "x",
      auth: "api_key",
    },
    persona: "test",
    tools: [],
    maxSteps: 1,
  };
  const agent = new Agent(config, {
    sessionStore,
    messageStore,
    toolRegistry: stubToolRegistry,
    attachmentsRoot: path.join(tmpRoot, "att"),
    memoryStore: new MemoryStore(path.join(tmpRoot, "agents")),
    taskStore: new TaskStore(path.join(tmpRoot, "tasks")),
    inboxStore: createInboxStore(db),
    broadcaster,
  });
  return { agent, broadcasts };
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function asst(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

async function fireAndSettle(
  agent: Agent,
  args: Parameters<Agent["fireTitle"]>[0],
): Promise<void> {
  agent.fireTitle(args);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("Agent.fireTitle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("broadcasts the generated title after writing it", async () => {
    const { agent, broadcasts } = makeAgent();
    agent.sessionStore.create(agent.config.id, { id: "s1" });
    vi.spyOn(titleModule, "runTitle").mockResolvedValue("OAuth refresh bug");

    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: [
        user("u1", "Why does OAuth refresh fail?"),
        asst("a1", "The refresh token is stale."),
      ],
    });

    expect(agent.sessionStore.get("s1")?.title).toBe("OAuth refresh bug");
    expect(broadcasts).toEqual([
      {
        sessionId: "s1",
        event: { kind: "session_title", title: "OAuth refresh bug" },
      },
    ]);
  });

  it("broadcasts the fallback title when generation returns empty", async () => {
    const { agent, broadcasts } = makeAgent();
    agent.sessionStore.create(agent.config.id, { id: "s1" });
    vi.spyOn(titleModule, "runTitle").mockResolvedValue(null);

    await fireAndSettle(agent, {
      sessionId: "s1",
      sessionMessages: [
        user("u1", "Summarize the build failure."),
        asst("a1", "The build failed because the title update was never broadcast."),
      ],
    });

    expect(agent.sessionStore.get("s1")?.title).toBe(
      "The build failed because the title update was never broadcast.",
    );
    expect(broadcasts).toEqual([
      {
        sessionId: "s1",
        event: {
          kind: "session_title",
          title: "The build failed because the title update was never broadcast.",
        },
      },
    ]);
  });
});
