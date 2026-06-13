#!/usr/bin/env node
import "@openacme/config/telemetry-bootstrap";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { resolveDataDir } from "@openacme/config";
import { setupCommand } from "./commands/setup.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { statusCommand } from "./commands/status.js";
import { logsCommand } from "./commands/logs.js";
import { serveInternalCommand } from "./commands/__serve.js";
import {
  secretShowCommand,
  secretRotateCommand,
} from "./commands/secret.js";
import { chatCommand } from "./commands/chat.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import {
  skillsListCommand,
  skillsViewCommand,
  skillsAddCommand,
  skillsRemoveCommand,
} from "./commands/skills.js";
import {
  skillsHubInstallCommand,
  skillsHubSearchCommand,
  skillsHubInspectCommand,
  skillsHubUpdateCommand,
  skillsHubUninstallCommand,
  skillsHubAuditCommand,
  tapListCommand,
  tapAddCommand,
  tapRemoveCommand,
} from "./commands/skills-hub.js";
import {
  mcpListCommand,
  mcpStatusCommand,
  mcpRemoveCommand,
  mcpTestCommand,
} from "./commands/mcp.js";
import {
  memoryShowCommand,
  memoryShowEntryCommand,
  memoryStatusCommand,
  memoryLsCommand,
} from "./commands/memory.js";
import {
  agentsCatalogCommand,
  agentsImportCommand,
} from "./commands/agents.js";
import { updateCommand } from "./commands/update.js";
import { showBanner } from "./tui/banner.js";

const pkg = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
) as { version: string };

const program = new Command();

program
  .name("openacme")
  .description("OpenAcme — AI agent platform with multi-LLM support")
  .version(pkg.version);

// `start` is the default — running `openacme` with no subcommand dispatches
// here. Defining options on the program level AND the subcommand caused
// Commander to consume them at the program level and the subcommand action
// would receive opts without dataDir/port/noBrowser.
program
  .command("start", { isDefault: true })
  .description("Start the OpenAcme daemon (idempotent; installs the service unit on first run)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("--no-browser", "Don't open browser automatically")
  .option(
    "--no-service",
    "Skip launchd/systemd unit; spawn detached with PID file (no auto-restart)"
  )
  .option("--expose", "Bind to 0.0.0.0, generate a secret, and start (enables remote access)")
  .action(async (opts) => {
    await showBanner(pkg.version);
    // Commander maps --no-service → opts.service=false and --no-browser →
    // opts.browser=false. Remap to the shape our command functions expect.
    await startCommand({
      dataDir: opts.dataDir,
      noBrowser: opts.browser === false,
      noService: opts.service === false,
      expose: opts.expose === true,
    });
  });

program
  .command("stop")
  .description("Stop the OpenAcme daemon (service unit stays installed)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("--no-service", "Operate against the no-service PID-file path")
  .action((opts) => stopCommand({
    dataDir: opts.dataDir,
    noService: opts.service === false,
  }));

program
  .command("restart")
  .description("Restart the OpenAcme daemon")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("--no-browser", "Don't open browser after restart")
  .option("--no-service", "Operate against the no-service PID-file path")
  .action((opts) => restartCommand({
    dataDir: opts.dataDir,
    noBrowser: opts.browser === false,
    noService: opts.service === false,
  }));

program
  .command("status")
  .description("Show daemon state, PID, bind, uptime, and recent log")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("--no-service", "Operate against the no-service PID-file path")
  .action((opts) => statusCommand({
    dataDir: opts.dataDir,
    noService: opts.service === false,
  }));

program
  .command("logs")
  .description("Print the daemon log (use -f to follow)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("-f, --follow", "Follow new lines as they arrive")
  .option("--tail <n>", "Lines to print initially (default: 200)")
  .action(logsCommand);

// Internal: the subcommand the service unit invokes to run the server in
// the foreground. Hidden from --help so users don't run it directly.
program
  .command("__serve", { hidden: true })
  .description("[internal] run the server foreground; invoked by launchd/systemd")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(serveInternalCommand);

const secret = program
  .command("secret")
  .description("Manage the access secret used for non-loopback web access");

secret
  .command("show", { isDefault: true })
  .description("Print the current secret")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(secretShowCommand);

secret
  .command("rotate")
  .description("Generate a new secret (invalidates existing sessions)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("--no-service", "Operate against the no-service PID-file path")
  .action(secretRotateCommand);

program
  .command("setup")
  .description("Interactive setup wizard — configure your provider, auth, and default model")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(setupCommand);

program
  .command("chat")
  .description("Open the terminal sessions list; pick a session to chat, or pass --agent/--session to jump straight in")
  .option("-a, --agent <id>", "Agent ID to start a fresh chat with (bypasses the list)")
  .option("-s, --session <id>", "Resume a specific session by id (bypasses the list)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(chatCommand);

program
  .command("login")
  .description("Sign in with ChatGPT or Claude (use your subscription instead of API credits)")
  .option("-p, --provider <name>", "openai or anthropic")
  .option("--device", "Use device-code flow (works on SSH/headless)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(loginCommand);

program
  .command("logout")
  .description("Sign out — remove stored OAuth tokens")
  .option("-p, --provider <name>", "openai or anthropic")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(logoutCommand);

const skills = program
  .command("skills")
  .description("Manage skills (Anthropic Agent Skills format)");

skills
  .command("list")
  .description("List installed skills")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsListCommand);

skills
  .command("view <name>")
  .description("Print a skill's full body")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsViewCommand);

skills
  .command("add <path>")
  .description("Install a skill from a folder containing SKILL.md (or that file directly)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsAddCommand);

skills
  .command("remove <name>")
  .description("Delete an installed skill")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsRemoveCommand);

skills
  .command("install <identifier>")
  .description("Install a skill from the hub (owner/repo[/path] or URL)")
  .option("--source <name>", "Restrict source: github | url | claude-marketplace")
  .option("--force", "Reinstall over an existing entry")
  .option("--name <name>", "Override skill name (for URL skills missing a frontmatter name)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsHubInstallCommand);

skills
  .command("search <query>")
  .description("Search hub sources for a skill")
  .option("--source <name>", "Restrict source: all | github | url | claude-marketplace", "all")
  .option("--limit <n>", "Max results", (v) => parseInt(v, 10), 25)
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsHubSearchCommand);

skills
  .command("inspect <identifier>")
  .description("Show metadata for a hub skill without installing")
  .option("--source <name>", "Restrict source: github | url | claude-marketplace")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsHubInspectCommand);

skills
  .command("update [name]")
  .description("Re-fetch and replace if upstream changed (all if name omitted)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsHubUpdateCommand);

skills
  .command("uninstall <name>")
  .description("Uninstall a hub-installed skill (use 'skills remove' for locally-authored)")
  .option("--yes", "Skip confirmation")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsHubUninstallCommand);

skills
  .command("audit")
  .description("Show hub install/update/uninstall history")
  .option("--limit <n>", "Max rows", (v) => parseInt(v, 10), 50)
  .option("--action <kind>", "Filter by audit action (INSTALL, UPDATE, UNINSTALL, TAP_ADD, ...)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(skillsHubAuditCommand);

const tap = skills
  .command("tap")
  .description("Manage user-added skill sources (registries)");

tap
  .command("list")
  .description("List configured taps")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(tapListCommand);

tap
  .command("add <repo>")
  .description("Add a tap (owner/repo)")
  .option("--source <name>", "github | claude-marketplace", "github")
  .option("--path <path>", "Subpath inside the repo where skills live (default: skills/)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(tapAddCommand);

tap
  .command("remove <repo>")
  .description("Remove a tap")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(tapRemoveCommand);

const mcp = program
  .command("mcp")
  .description("Manage MCP servers (Model Context Protocol)");

mcp
  .command("list")
  .description("List configured MCP servers from ~/.openacme/mcp.json")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(mcpListCommand);

mcp
  .command("status")
  .description("Live-test every MCP server and report status")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(mcpStatusCommand);

// `add` and `edit` go through hand-editing `~/.openacme/mcp.json` directly
// (or via the web UI's Settings → MCP → Edit JSON dialog). Same shape as
// Claude Desktop / Cursor / Cline, so configs paste in cleanly.
mcp
  .command("remove <name>")
  .description("Remove an MCP server from mcp.json")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(mcpRemoveCommand);

mcp
  .command("test <name>")
  .description("Dry-run a server's connection without registering its tools")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(mcpTestCommand);

const memory = program
  .command("memory")
  .description("Inspect per-agent persistent memory (MEMORY.md)");

memory
  .command("status", { isDefault: true })
  .description("List every agent and its memory usage")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(memoryStatusCommand);

memory
  .command("show <agentId> [entry]")
  .description("Print one agent's MEMORY.md index, or a specific entry file when [entry] is given")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action((agentId: string, entry: string | undefined, opts: { dataDir?: string }) => {
    if (entry) return memoryShowEntryCommand(agentId, entry, opts);
    return memoryShowCommand(agentId, opts);
  });

memory
  .command("ls <agentId>")
  .description("Recursive 2-deep listing of an agent's memory dir (same format the agent sees)")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(memoryLsCommand);

const agents = program
  .command("agents")
  .description("Manage agents in the workforce (browse the catalog, import templates)");

agents
  .command("catalog")
  .description("List bundled agent templates that can be imported")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .action(agentsCatalogCommand);

agents
  .command("import <templateId>")
  .description("Import an agent from the bundled catalog. Auto-installs any recommended skills + MCP servers; copies resources into the new agent's folder. The same template can be imported repeatedly — ids auto-increment.")
  .option("-d, --data-dir <path>", "Data directory (default: ~/.openacme)")
  .option("--id <id>", "Override the auto-generated agent id (must match safe-id charset)")
  .option("--name <name>", "Override the template's display name")
  .action((templateId: string, opts: { dataDir?: string; id?: string; name?: string }) =>
    agentsImportCommand(templateId, opts)
  );

program
  .command("update")
  .description("Check whether a newer @openacme/cli is on npm and print the install command")
  .option("--json", "Emit a machine-readable JSON line instead of human text")
  .action((opts: { json?: boolean }) => updateCommand({ json: opts.json === true }));

// Resolve the data dir once so the LLM provider's OAuth path can find auth.json
// without us threading the path through every call site.
const initialDataDir = resolveDataDir(
  process.argv.includes("--data-dir")
    ? process.argv[process.argv.indexOf("--data-dir") + 1]
    : process.argv.includes("-d")
      ? process.argv[process.argv.indexOf("-d") + 1]
      : undefined,
);
process.env["OPENACME_DATA_DIR"] = initialDataDir;

program.parse();
