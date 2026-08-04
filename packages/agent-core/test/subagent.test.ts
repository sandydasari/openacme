import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
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
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/types.js";
import { runSubagent } from "../src/subagent.js";

// Mock @openacme/llm-provider so structured-mode tests can route the
// generateObject call through a controlled MockLanguageModelV3.
const { getModelMock } = vi.hoisted(() => ({
  getModelMock: vi.fn<(cfg: unknown) => unknown>(() => ({})),
}));
vi.mock("@openacme/llm-provider", () => ({
  getModel: getModelMock,
  resolveSubagentModel: (m: unknown) => m,
  supportsToolResultMedia: () => false,
}));

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

function makeAgent(model?: Partial<AgentConfig["model"]>): Agent {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-subagent-"));
  const db = freshDb();
  const sessionStore = createSessionStore(db);
  const messageStore = createMessageStore(db);
  const config: AgentConfig = {
    id: "a1",
    name: "A1",
    model: {
      provider: "openai",
      model: "test",
      apiKey: "x",
      auth: "api_key",
      ...model,
    },
    persona: "test",
    tools: [],
    maxSteps: 5,
  };
  return new Agent(config, {
    sessionStore,
    messageStore,
    toolRegistry: stubToolRegistry,
    attachmentsRoot: path.join(tmpRoot, "att"),
    memoryStore: new MemoryStore(path.join(tmpRoot, "agents")),
    taskStore: new TaskStore(path.join(tmpRoot, "tasks")),
    inboxStore: createInboxStore(db),
  });
}

// ── Forked-mode tests ──────────────────────────────────────────────────

describe("runSubagent (forked mode)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds the fork with a single user-shape message and returns completed", async () => {
    const agent = makeAgent();
    agent.sessionStore.create(agent.config.id, { id: "sess-1" });
    const stub = vi.spyOn(agent, "runStream").mockResolvedValue({
      toUIMessageStream: () =>
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      usage: Promise.resolve({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
    } as unknown as Awaited<ReturnType<Agent["runStream"]>>);

    const out = await runSubagent({
      mode: "forked",
      parent: agent,
      parentSessionId: "sess-1",
      initialMessage: "extract anything important",
    });

    expect(stub).toHaveBeenCalledTimes(1);
    const passed = stub.mock.calls[0]![0];
    expect(passed.sessionId).toBe("sess-1");
    expect(passed.history.length).toBe(1);
    expect(passed.history[0]!.role).toBe("user");
    const firstPart = passed.history[0]!.parts[0] as {
      type: string;
      text: string;
    };
    expect(firstPart.type).toBe("text");
    expect(firstPart.text).toBe("extract anything important");
    expect(out.mode).toBe("forked");
    expect(out.status).toBe("completed");
  });

  it("returns status=failed when runStream throws", async () => {
    const agent = makeAgent();
    agent.sessionStore.create(agent.config.id, { id: "sess-2" });
    vi.spyOn(agent, "runStream").mockRejectedValue(new Error("model down"));
    const out = await runSubagent({
      mode: "forked",
      parent: agent,
      parentSessionId: "sess-2",
      initialMessage: "x",
    });
    expect(out.status).toBe("failed");
    if (out.mode === "forked") {
      expect(out.error).toContain("model down");
    }
  });

  it("times out when the stream stalls past timeoutMs", async () => {
    const agent = makeAgent();
    agent.sessionStore.create(agent.config.id, { id: "sess-3" });
    vi.spyOn(agent, "runStream").mockImplementation(async (opts) => {
      return {
        toUIMessageStream: () =>
          new ReadableStream({
            start(controller) {
              opts.signal?.addEventListener("abort", () => controller.close());
            },
          }),
        usage: new Promise(() => {}),
      } as unknown as Awaited<ReturnType<Agent["runStream"]>>;
    });
    const out = await runSubagent({
      mode: "forked",
      parent: agent,
      parentSessionId: "sess-3",
      initialMessage: "x",
      timeoutMs: 100,
    });
    expect(out.status).toBe("timeout");
  });

  it("propagates external abort as status=aborted", async () => {
    const agent = makeAgent();
    agent.sessionStore.create(agent.config.id, { id: "sess-4" });
    const ac = new AbortController();
    vi.spyOn(agent, "runStream").mockImplementation(async (opts) => ({
      toUIMessageStream: () =>
        new ReadableStream({
          start(c) {
            opts.signal?.addEventListener("abort", () => c.close());
          },
        }),
      usage: new Promise(() => {}),
    } as unknown as Awaited<ReturnType<Agent["runStream"]>>));
    setTimeout(() => ac.abort(), 30);
    const out = await runSubagent({
      mode: "forked",
      parent: agent,
      parentSessionId: "sess-4",
      initialMessage: "x",
      timeoutMs: 5_000,
      abortSignal: ac.signal,
    });
    expect(out.status).toBe("aborted");
  });

  it("threads contextMessages BEFORE the seed in the fork's history", async () => {
    const agent = makeAgent();
    agent.sessionStore.create(agent.config.id, { id: "sess-ctx" });
    const stub = vi.spyOn(agent, "runStream").mockResolvedValue({
      toUIMessageStream: () =>
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      usage: Promise.resolve({}),
    } as unknown as Awaited<ReturnType<Agent["runStream"]>>);

    const ctx = [
      { id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] },
      { id: "a1", role: "assistant" as const, parts: [{ type: "text" as const, text: "hello" }] },
    ];

    await runSubagent({
      mode: "forked",
      parent: agent,
      parentSessionId: "sess-ctx",
      contextMessages: ctx,
      initialMessage: "summarize the above",
    });

    const passed = stub.mock.calls[0]![0];
    expect(passed.history.length).toBe(3);
    expect(passed.history[0]!.id).toBe("u1");
    expect(passed.history[1]!.id).toBe("a1");
    expect(passed.history[2]!.role).toBe("user");
    const seedPart = passed.history[2]!.parts[0] as { text: string };
    expect(seedPart.text).toBe("summarize the above");
  });

  it("omits contextMessages → fork history is just the seed", async () => {
    const agent = makeAgent();
    agent.sessionStore.create(agent.config.id, { id: "sess-no-ctx" });
    const stub = vi.spyOn(agent, "runStream").mockResolvedValue({
      toUIMessageStream: () =>
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      usage: Promise.resolve({}),
    } as unknown as Awaited<ReturnType<Agent["runStream"]>>);

    await runSubagent({
      mode: "forked",
      parent: agent,
      parentSessionId: "sess-no-ctx",
      initialMessage: "just this",
    });
    expect(stub.mock.calls[0]![0].history.length).toBe(1);
  });

  it("forwards telemetryFunctionId override to runStream", async () => {
    const agent = makeAgent();
    agent.sessionStore.create(agent.config.id, { id: "sess-tele" });
    const stub = vi.spyOn(agent, "runStream").mockResolvedValue({
      toUIMessageStream: () =>
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      usage: Promise.resolve({}),
    } as unknown as Awaited<ReturnType<Agent["runStream"]>>);

    await runSubagent({
      mode: "forked",
      parent: agent,
      parentSessionId: "sess-tele",
      initialMessage: "x",
      telemetryFunctionId: "custom:tag",
    });
    expect(stub.mock.calls[0]![0].telemetryFunctionId).toBe("custom:tag");
  });

  it("forwards stopWhen + toolFilter to runStream", async () => {
    const agent = makeAgent();
    agent.sessionStore.create(agent.config.id, { id: "sess-5" });
    const stub = vi.spyOn(agent, "runStream").mockResolvedValue({
      toUIMessageStream: () =>
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      usage: Promise.resolve({}),
    } as unknown as Awaited<ReturnType<Agent["runStream"]>>);
    const fakeStop = (() => false) as unknown as Parameters<
      Agent["runStream"]
    >[0]["stopWhen"];
    const filter = new Set(["memory"]);
    await runSubagent({
      mode: "forked",
      parent: agent,
      parentSessionId: "sess-5",
      initialMessage: "x",
      stopWhen: fakeStop,
      toolFilter: filter,
    });
    expect(stub.mock.calls[0]![0].stopWhen).toBe(fakeStop);
    expect(stub.mock.calls[0]![0].toolFilter).toBe(filter);
  });
});

// ── Structured-mode tests ──────────────────────────────────────────────

const PickSchema = z.object({
  selected: z.array(z.string()),
});

function modelReturning(obj: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(obj) }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  });
}

function streamingModelReturning(obj: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("doGenerate should not be used");
    },
    doStream: async () => {
      const id = "txt-1";
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id },
            { type: "text-delta", id, delta: JSON.stringify(obj) },
            { type: "text-end", id },
            {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      };
    },
  });
}

describe("runSubagent (structured mode)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getModelMock.mockReset();
  });

  it("returns the parsed object on success", async () => {
    const agent = makeAgent();
    getModelMock.mockReturnValue(modelReturning({ selected: ["a", "b"] }));
    const out = await runSubagent({
      mode: "structured",
      parent: agent,
      system: "system",
      user: "user",
      schema: PickSchema,
    });
    expect(out.mode).toBe("structured");
    expect(out.status).toBe("completed");
    if (out.mode === "structured") {
      expect(out.object).toEqual({ selected: ["a", "b"] });
    }
  });

  it("streams structured output for OpenAI OAuth", async () => {
    const agent = makeAgent({ auth: "oauth" });
    const model = streamingModelReturning({ selected: ["oauth"] });
    getModelMock.mockReturnValue(model);

    const out = await runSubagent({
      mode: "structured",
      parent: agent,
      system: "system",
      user: "user",
      schema: PickSchema,
    });

    expect(out.status).toBe("completed");
    if (out.mode === "structured") {
      expect(out.object).toEqual({ selected: ["oauth"] });
    }
    expect(model.doStreamCalls.length).toBe(1);
    expect(model.doGenerateCalls.length).toBe(0);
  });

  it("returns null + failed on schema mismatch", async () => {
    const agent = makeAgent();
    getModelMock.mockReturnValue(
      modelReturning({ wrong_field: "oops" })
    );
    const out = await runSubagent({
      mode: "structured",
      parent: agent,
      system: "system",
      user: "user",
      schema: PickSchema,
    });
    expect(out.status).toBe("failed");
    if (out.mode === "structured") {
      expect(out.object).toBeNull();
    }
  });

  it("returns null + failed when the model errors", async () => {
    const agent = makeAgent();
    getModelMock.mockReturnValue(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("provider down");
        },
      })
    );
    const out = await runSubagent({
      mode: "structured",
      parent: agent,
      system: "system",
      user: "user",
      schema: PickSchema,
    });
    expect(out.status).toBe("failed");
    if (out.mode === "structured") {
      expect(out.error).toContain("provider down");
    }
  });

  it("propagates external abort as status=aborted", async () => {
    const agent = makeAgent();
    const ac = new AbortController();
    getModelMock.mockReturnValue(
      new MockLanguageModelV3({
        doGenerate: async (opts) => {
          await new Promise((r) =>
            opts.abortSignal?.addEventListener("abort", () => r(undefined))
          );
          throw new Error("aborted");
        },
      })
    );
    setTimeout(() => ac.abort(), 30);
    const out = await runSubagent({
      mode: "structured",
      parent: agent,
      system: "system",
      user: "user",
      schema: PickSchema,
      abortSignal: ac.signal,
      timeoutMs: 5_000,
    });
    expect(out.status).toBe("aborted");
  });

  it("times out when the model hangs past timeoutMs", async () => {
    const agent = makeAgent();
    getModelMock.mockReturnValue(
      new MockLanguageModelV3({
        doGenerate: async (opts) => {
          await new Promise((r) =>
            opts.abortSignal?.addEventListener("abort", () => r(undefined))
          );
          throw new Error("aborted");
        },
      })
    );
    const out = await runSubagent({
      mode: "structured",
      parent: agent,
      system: "system",
      user: "user",
      schema: PickSchema,
      timeoutMs: 100,
    });
    expect(out.status).toBe("timeout");
  });

  it("uses parent.config.model via getModel", async () => {
    const agent = makeAgent();
    getModelMock.mockReturnValue(modelReturning({ selected: [] }));
    await runSubagent({
      mode: "structured",
      parent: agent,
      system: "s",
      user: "u",
      schema: PickSchema,
    });
    expect(getModelMock).toHaveBeenCalledWith(agent.config.model);
  });
});
