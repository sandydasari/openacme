import { describe, it, expect, beforeEach } from "vitest";
import { registry } from "../src/registry.js";
import {
  bindAgentTool,
  type AgentSummary,
  type PeerNote,
} from "../src/builtins/agent.js";
import { toolCallContext } from "../src/session-context.js";

interface ListResult {
  ok: boolean;
  count: number;
  total: number;
  agents: Array<{
    id: string;
    name: string;
    role: string;
    peer_note?: {
      content: string;
      mtime: string;
      truncated?: boolean;
    };
  }>;
  error?: string;
}

async function runList(
  args: Record<string, unknown>,
  callerAgentId?: string
): Promise<ListResult> {
  const tool = registry.get("agent_list");
  if (!tool) throw new Error("agent_list not registered");
  const exec = () => tool.handler(args);
  const out = callerAgentId
    ? await toolCallContext.run({ agentId: callerAgentId }, exec)
    : await exec();
  return JSON.parse(out) as ListResult;
}

const SAMPLE: AgentSummary[] = [
  { id: "alice", name: "Alice", role: "Researcher — owns citation gathering." },
  { id: "bob", name: "Bob", role: "Backend engineer — owns auth + billing APIs." },
  { id: "carol", name: "Carol", role: "Ops — owns deploys, oncall." },
];

describe("agent_list", () => {
  beforeEach(() => {
    bindAgentTool({
      listAgents: () => SAMPLE,
      peerNoteFor: () => null,
    });
  });

  it("excludes the caller from the result", async () => {
    const res = await runList({}, "alice");
    expect(res.ok).toBe(true);
    expect(res.agents.map((a) => a.id)).toEqual(["bob", "carol"]);
    expect(res.count).toBe(2);
    expect(res.total).toBe(2);
  });

  it("filters by query over role/name/id (case-insensitive)", async () => {
    const res = await runList({ query: "AUTH" }, "alice");
    expect(res.agents.map((a) => a.id)).toEqual(["bob"]);
  });

  it("query matches the id substring too", async () => {
    const res = await runList({ query: "carol" }, "alice");
    expect(res.agents.map((a) => a.id)).toEqual(["carol"]);
  });

  it("returns total separate from count when limit applies", async () => {
    const res = await runList({ limit: 1 }, "alice");
    expect(res.count).toBe(1);
    expect(res.total).toBe(2);
  });

  it("inlines peer_note when one exists for the caller", async () => {
    bindAgentTool({
      listAgents: () => SAMPLE,
      peerNoteFor: (caller, peer): PeerNote | null => {
        if (caller === "alice" && peer === "bob") {
          return { content: "Bob is fast on auth; slow on infra.", mtimeMs: 1_000_000 };
        }
        return null;
      },
    });
    const res = await runList({}, "alice");
    const bob = res.agents.find((a) => a.id === "bob");
    const carol = res.agents.find((a) => a.id === "carol");
    expect(bob?.peer_note?.content).toContain("fast on auth");
    expect(bob?.peer_note?.truncated).toBeUndefined();
    expect(carol?.peer_note).toBeUndefined();
  });

  it("truncates peer_note bodies over 2KB and includes the peer id in the hint", async () => {
    const huge = "x".repeat(3000) + "\n";
    bindAgentTool({
      listAgents: () => SAMPLE,
      peerNoteFor: () => ({ content: huge, mtimeMs: 0 }),
    });
    const res = await runList({}, "alice");
    const bob = res.agents.find((a) => a.id === "bob");
    expect(bob?.peer_note?.truncated).toBe(true);
    expect(bob?.peer_note?.content).toContain("peers/bob.md");
    // content is bounded; the suffix adds a small hint but the original
    // 3000-byte payload should be cut down.
    expect(bob!.peer_note!.content.length).toBeLessThan(huge.length);
  });

  it("errors cleanly when no agent context is present", async () => {
    const res = await runList({});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/active agent context/);
  });

  it("respects the binding's id rejection — defense-in-depth path", async () => {
    // The agentStore validates ids on upsert with SAFE_ID, so a
    // traversal-shaped id never reaches the real binding. Test the
    // *contract*: if a binding rejects an id (its job is to reject
    // anything that doesn't match the SAFE_ID shape), the tool surfaces
    // the entry from listAgents but omits peer_note. No throw, no leak.
    const PEER_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
    bindAgentTool({
      listAgents: () => [
        { id: "../../../etc/passwd", name: "Sketchy", role: "synthetic" },
        ...SAMPLE,
      ],
      peerNoteFor: (_caller, peer) => {
        if (!PEER_ID_SAFE.test(peer)) return null;
        return { content: "should never appear for the bad id", mtimeMs: 0 };
      },
    });
    const res = await runList({}, "alice");
    const sketchy = res.agents.find((a) => a.id === "../../../etc/passwd");
    expect(sketchy).toBeDefined();
    expect(sketchy?.peer_note).toBeUndefined();
  });
});

describe("agent_list capabilities", () => {
  beforeEach(() => {
    bindAgentTool({
      listAgents: () => [
        { id: "caller", name: "Caller", role: "" },
        {
          id: "qa",
          name: "QA",
          role: "Tester",
          tools: ["shell", "browser_navigate", "browser_click"],
          skills: ["playwright-cli"],
          mcp_servers: ["figma"],
        },
        { id: "writer", name: "Writer", role: "Docs", tools: ["read_file"] },
      ],
      peerNoteFor: () => null,
    });
  });

  it("surfaces tools, skills, and mcp_servers per agent", async () => {
    const res = await runList({}, "caller");
    expect(res.ok).toBe(true);
    const qa = res.agents.find((a) => a.id === "qa") as Record<
      string,
      unknown
    >;
    expect(qa.tools).toEqual(["shell", "browser_navigate", "browser_click"]);
    expect(qa.skills).toEqual(["playwright-cli"]);
    expect(qa.mcp_servers).toEqual(["figma"]);
  });

  it("query matches over capabilities, not just name/role/id", async () => {
    const byTool = await runList({ query: "browser" }, "caller");
    expect(byTool.agents.map((a) => a.id)).toEqual(["qa"]);
    const byMcp = await runList({ query: "figma" }, "caller");
    expect(byMcp.agents.map((a) => a.id)).toEqual(["qa"]);
  });
});
