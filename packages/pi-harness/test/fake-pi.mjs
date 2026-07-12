#!/usr/bin/env node
// Minimal stand-in for `pi --mode rpc`: JSONL over stdin/stdout.
// Env knobs:
//   FAKE_PI_HANG=1   — never settle after a prompt (timeout tests)
//   FAKE_PI_SPLIT=1  — write events in partial chunks (framing tests)

import { createInterface } from "node:readline";

const hang = process.env.FAKE_PI_HANG === "1";
const split = process.env.FAKE_PI_SPLIT === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeLine(obj) {
  const line = JSON.stringify(obj) + "\n";
  if (split && line.length > 4) {
    const mid = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, mid));
    await sleep(5);
    process.stdout.write(line.slice(mid));
  } else {
    process.stdout.write(line);
  }
}

function respond(cmd, extra = {}) {
  if (typeof cmd.id === "string") {
    void writeLine({ type: "response", id: cmd.id, success: true, ...extra });
  }
}

async function runTurn(promptText) {
  await writeLine({ type: "agent_start" });
  await writeLine({ type: "turn_start" });
  await writeLine({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
  });
  await writeLine({
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "t1",
    args: { command: "echo hi" },
  });
  await sleep(10);
  await writeLine({ type: "tool_execution_end", toolCallId: "t1" });
  for (const delta of ["Done: ", promptText.slice(0, 20)]) {
    await writeLine({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta },
    });
  }
  await writeLine({ type: "turn_end" });
  if (!hang) {
    await writeLine({ type: "agent_end" });
    await writeLine({ type: "agent_settled" });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  switch (cmd.type) {
    case "prompt":
      respond(cmd);
      void runTurn(String(cmd.message ?? ""));
      break;
    case "steer":
      respond(cmd);
      void writeLine({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: `steered: ${cmd.message}` },
      });
      break;
    case "follow_up":
      respond(cmd);
      break;
    case "abort":
      respond(cmd);
      void writeLine({ type: "agent_settled" });
      break;
    case "bad_command":
      void writeLine({ type: "response", id: cmd.id, success: false, error: "nope" });
      break;
    default:
      respond(cmd);
      break;
  }
});
rl.on("close", () => process.exit(0));
