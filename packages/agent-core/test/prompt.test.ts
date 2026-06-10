import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from "../src/prompt.js";

const PERSONA = "You are TestAgent.";
const TOOLS = ["memory", "shell", "read_file"];
const CHAR_LIMIT = 2200;

function snapshot(content: string, entryCount = 0) {
  return { content, used: content.length, limit: CHAR_LIMIT, entryCount };
}

describe("memory section assembly", () => {
  it("includes a ## Memory section when memory tool is available + snapshot is provided", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot(""),
    });
    expect(prompt).toContain("## Memory");
  });

  it("omits the ## Memory section when memory tool is NOT in tools", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: ["shell"],
      memorySnapshot: snapshot("- [a](a.md)"),
    });
    expect(prompt).not.toContain("## Memory");
    expect(prompt).not.toContain("- [a](a.md)");
  });

  it("emits the empty-form header when MEMORY.md is empty", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot(""),
    });
    expect(prompt).toContain("(empty — no memories yet)");
  });

  it("includes the index header showing utilization + entry count", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot("x".repeat(1100), 3),
    });
    expect(prompt).toContain("MEMORY [50% — 1100/2200 chars] · 3 entries");
  });

  it("uses singular 'entry' for entryCount === 1", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot("hi", 1),
    });
    expect(prompt).toContain("· 1 entry");
  });
});

describe("Anthropic memory protocol — NOT in system prompt", () => {
  // The "ALWAYS VIEW YOUR MEMORY DIRECTORY..." preamble lives only in
  // the memory tool's description (where the Anthropic spec auto-
  // injects it). Duplicating it in the system prompt over-primed the
  // agent — every reply opened with "I'll check my memory directory
  // first as required by the protocol." Convention alone is enough.
  it("does NOT include the protocol preamble in the system prompt", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot(""),
    });
    expect(prompt).not.toContain(
      "ALWAYS VIEW YOUR MEMORY DIRECTORY"
    );
    expect(prompt).not.toContain("MEMORY PROTOCOL:");
    expect(prompt).not.toContain("ASSUME INTERRUPTION");
  });
});

describe("Convention text (Claude Code, types dropped)", () => {
  it("contains the index-vs-memory rule and body structure", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot(""),
    });
    expect(prompt).toContain("MEMORY.md is an index, not a memory");
    expect(prompt).toContain("**Why:**");
    expect(prompt).toContain("**How to apply:**");
  });

  it("contains the save discipline rules verbatim", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot(""),
    });
    expect(prompt).toContain(
      "Update or remove memories that turn out to be wrong or outdated"
    );
    expect(prompt).toContain(
      "Do not write duplicate memories. First check if there is an existing memory you can update"
    );
    expect(prompt).toContain("Organize memory semantically by topic");
  });

  it("contains the recall discipline rules verbatim ('Before recommending from memory')", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot(""),
    });
    expect(prompt).toContain("Before recommending from memory");
    expect(prompt).toContain(
      "If the memory names a file path: check the file exists"
    );
    expect(prompt).toContain(
      `"The memory says X exists" is not the same as "X exists now."`
    );
  });

  it("contains the two-step save guidance", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot(""),
    });
    expect(prompt).toContain("Step 1");
    expect(prompt).toContain("Step 2");
    expect(prompt).toContain("add a pointer to that file in `MEMORY.md`");
  });

  it("uses 'work-item' wording instead of 'user message' (autonomous-future)", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot(""),
    });
    expect(prompt).toContain("work-item");
    // Sanity: the convention shouldn't unilaterally talk about "user
    // message" in the access rules — check one of the verbatim phrases
    // that we generalized.
    expect(prompt).toContain(
      "If the work-item says to *ignore* or *not use* memory"
    );
  });

  it("DOES NOT mention the four type-enum names anywhere (we dropped the taxonomy)", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot(""),
    });
    // The Claude Code per-type framing is intentionally absent from
    // OpenAcme's convention. Frontmatter has only name + description.
    expect(prompt).not.toMatch(/<types>/);
    expect(prompt).not.toMatch(/<type>\s*<name>user<\/name>/);
    expect(prompt).not.toMatch(/<name>feedback<\/name>/);
    expect(prompt).not.toMatch(/<name>project<\/name>/);
    // "type:" frontmatter field is also absent from the example block
    expect(prompt).not.toMatch(/^type:\s+(?:user|feedback|project|reference)/m);
  });
});

describe("Cluttered-memory secondary instruction", () => {
  it("appears when entryCount > 10", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot("- [a](a.md)", 11),
    });
    expect(prompt).toContain("keep its content");
    expect(prompt).toContain("up-to-date, coherent and organized");
  });

  it("appears when index is over 80% of cap", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot("x".repeat(1900), 3),
    });
    expect(prompt).toContain("up-to-date, coherent and organized");
  });

  it("is absent when ≤10 files AND <80% cap", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot("- [a](a.md)", 5),
    });
    expect(prompt).not.toContain("up-to-date, coherent and organized");
  });
});

describe("Index truncation", () => {
  it("truncates and warns when over the line cap", () => {
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES + 50 }, (_, i) => `- [m${i}](m${i}.md)`);
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot(lines.join("\n")),
    });
    expect(prompt).toContain("WARNING: MEMORY.md is");
    expect(prompt).toContain(`(limit: ${MAX_ENTRYPOINT_LINES})`);
    expect(prompt).toContain(
      "Keep index entries to one line under ~200 chars; move detail into topic files."
    );
  });

  it("truncates and warns when over the byte cap (long-line failure mode)", () => {
    // 5 lines of 6KB each → 30KB but only 5 lines. Hits the byte cap, not the line cap.
    const lines = Array.from({ length: 5 }, () => "x".repeat(6000));
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot(lines.join("\n")),
    });
    expect(prompt).toContain("WARNING: MEMORY.md is");
    expect(prompt).toContain(`(limit: ${(MAX_ENTRYPOINT_BYTES / 1024).toFixed(1)}KB)`);
    expect(prompt).toContain("index entries are too long");
  });

  it("does NOT warn when under both caps", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      memorySnapshot: snapshot("- [a](a.md)\n- [b](b.md)"),
    });
    expect(prompt).not.toContain("WARNING: MEMORY.md");
  });
});

describe("AGENTS.md (shared background) injection", () => {
  const AGENTS = "We run a small research lab focused on protein folding.";

  it("injects content verbatim after the persona with a generic preface", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: ["shell"],
      agentsMd: AGENTS,
    });
    expect(prompt).toContain("Shared context (from AGENTS.md):");
    expect(prompt).toContain(AGENTS);
    // Ordering: preface must follow the persona, not precede it.
    const personaIdx = prompt.indexOf(PERSONA);
    const prefaceIdx = prompt.indexOf("Shared context");
    expect(personaIdx).toBeGreaterThanOrEqual(0);
    expect(prefaceIdx).toBeGreaterThan(personaIdx);
  });

  it("omits the section when agentsMd is undefined", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: ["shell"],
    });
    expect(prompt).not.toContain("AGENTS.md");
    expect(prompt).not.toContain("Shared context");
  });

  it("omits the section when agentsMd is empty or whitespace", () => {
    const promptEmpty = buildSystemPrompt({
      persona: PERSONA,
      toolNames: ["shell"],
      agentsMd: "",
    });
    const promptWhitespace = buildSystemPrompt({
      persona: PERSONA,
      toolNames: ["shell"],
      agentsMd: "   \n\n  ",
    });
    expect(promptEmpty).not.toContain("Shared context for every agent");
    expect(promptWhitespace).not.toContain("Shared context for every agent");
  });

  it("does not impose a markdown section header — file content speaks for itself", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: ["shell"],
      agentsMd: AGENTS,
    });
    // No `## Workforce` / `## Organization` / `## Context` injected by us;
    // user owns whatever structure they put inside AGENTS.md.
    expect(prompt).not.toMatch(/^## Workforce$/m);
    expect(prompt).not.toMatch(/^## Organization$/m);
    expect(prompt).not.toMatch(/^## Context$/m);
  });
});

describe("Workspace section (per-agent default cwd)", () => {
  it("emits a ## Workspace block when workspaceDir is set", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: ["shell"],
      workspaceDir: "/data/agents/alice/workspace",
    });
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("/data/agents/alice/workspace");
    expect(prompt).toContain("persist");
  });

  it("omits the section when workspaceDir is empty / undefined", () => {
    const undef = buildSystemPrompt({ persona: PERSONA, toolNames: ["shell"] });
    const empty = buildSystemPrompt({
      persona: PERSONA,
      toolNames: ["shell"],
      workspaceDir: "",
    });
    expect(undef).not.toContain("## Workspace");
    expect(empty).not.toContain("## Workspace");
  });

  it("points at the Access section for what's actually read/writable", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: ["shell"],
      workspaceDir: "/tmp/ws",
    });
    expect(prompt).toMatch(/listed under Access/i);
  });

  it("renders the ## Access section from a pre-rendered accessSection", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: ["shell"],
      workspaceDir: "/tmp/ws",
      accessSection: "Read-write:\n- `/tmp/ws` — your workspace",
    });
    expect(prompt).toContain("## Access");
    expect(prompt).toContain("- `/tmp/ws` — your workspace");
    // Section ordering: Workspace before Access.
    expect(prompt.indexOf("## Workspace")).toBeLessThan(
      prompt.indexOf("## Access")
    );
  });
});

describe("teams section assembly", () => {
  const team = (over: Partial<import("../src/prompt.js").PromptTeam> = {}) => ({
    id: "website",
    name: "Website Redesign",
    members: ["zoe", "max"],
    charter: "We ship the landing page. Zoe is the manager.",
    workspaceDir: "/data/teams/website/workspace",
    ...over,
  });

  it("omits the ## Teams section when teams is empty/undefined", () => {
    expect(
      buildSystemPrompt({ persona: PERSONA, toolNames: TOOLS })
    ).not.toContain("## Teams");
    expect(
      buildSystemPrompt({ persona: PERSONA, toolNames: TOOLS, teams: [] })
    ).not.toContain("## Teams");
  });

  it("renders roster, workspace path, and charter per team", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      teams: [team()],
    });
    expect(prompt).toContain("## Teams");
    expect(prompt).toContain("### Website Redesign (`website`)");
    expect(prompt).toContain("Members: zoe, max");
    expect(prompt).toContain("Shared workspace: `/data/teams/website/workspace`");
    expect(prompt).toContain("Zoe is the manager.");
  });

  it("places ## Teams between AGENTS.md context and ## Workspace", () => {
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      agentsMd: "Org-wide background.",
      teams: [team()],
      workspaceDir: "/data/agents/zoe/workspace",
    });
    const org = prompt.indexOf("Org-wide background.");
    const teams = prompt.indexOf("## Teams");
    const ws = prompt.indexOf("## Workspace");
    expect(org).toBeGreaterThan(-1);
    expect(teams).toBeGreaterThan(org);
    expect(ws).toBeGreaterThan(teams);
  });

  it("caps combined charters at TEAM_CHARTER_CHAR_LIMIT with a warning", () => {
    const big = "line of charter text\n".repeat(300); // ~6300 chars
    const prompt = buildSystemPrompt({
      persona: PERSONA,
      toolNames: TOOLS,
      teams: [
        team({ id: "a", name: "A", charter: big }),
        team({ id: "b", name: "B", charter: "short b charter" }),
      ],
    });
    expect(prompt).toContain("(charter truncated)");
    expect(prompt).toContain("> WARNING: combined team charters exceed");
    // Second team's charter is past the budget — omitted, not silently dropped.
    expect(prompt).toContain("(charter omitted)");
    expect(prompt).not.toContain("short b charter");
  });
});
