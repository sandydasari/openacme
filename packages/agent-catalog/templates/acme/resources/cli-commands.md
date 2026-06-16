# Useful CLI commands

When you need to call a platform API that isn't a simple filesystem
edit — install a skill from a source, import an agent template,
manage MCP servers — drive the CLI via the `shell` tool. These are
the commands you'll reach for.

## Daemon lifecycle

```bash
openacme start     # start the daemon (idempotent)
openacme restart   # restart — only needed after a server host/port change
openacme stop
openacme status    # pid, bind, uptime, recent log
openacme logs -f   # tail the daemon log
```

## Skills hub

Locally-authored skills (writing `SKILL.md` directly) work without
the hub. Use the hub when installing from a source — it handles
trust, lockfile, audit.

```bash
openacme skills list                                    # workforce-wide skills
openacme skills view <name>                             # full body
openacme skills install <identifier>                    # auto-detect source
openacme skills install <user>/<repo> --source github   # explicit source
openacme skills search "<query>"                        # cross-source search
openacme skills update <name>
openacme skills uninstall <name>
openacme skills tap add <user>/<repo>                   # extra GitHub repo to search
```

## Agent catalog

Bundled templates the user can import. You yourself were imported
from this catalog (template id `acme`). Add more agents the same way
or write AGENT.md by hand for fully custom ones.

```bash
openacme agents catalog              # list templates
openacme agents import <templateId>  # import (auto-installs recommended skills + MCP)
```

## MCP servers

Editing `mcp.json` directly is fine for adding/removing entries. Use
these for inspection and reauth.

```bash
openacme mcp list           # global catalog
openacme mcp status         # per-server connection state
openacme mcp test <name>    # dry-run connection
openacme mcp remove <name>  # delete from mcp.json
```

## Memory inspection

```bash
openacme memory status            # per-agent memory dir sizes
openacme memory show <agentId>    # print an agent's MEMORY.md
```

## Auth

```bash
openacme login --provider openai      # OAuth sign-in with ChatGPT
openacme login --provider anthropic   # OAuth sign-in with Claude
openacme logout
openacme secret show                  # access secret for non-loopback web access
openacme secret rotate
```

## Per-agent email

Mailboxes are per-agent and opt-in. Credentials live in the agent's
`email.json` (0600) — never edit that file by hand; use the command or
the web Email panel.

```bash
openacme email login <agentId>    # bind a mailbox (imap / gmail / microsoft)
openacme email status [agentId]   # show bound provider/address + token validity
```

## Remote access

```bash
openacme expose       # bind to the network + print a reachable claim link
```

## Setup wizard

```bash
openacme setup   # re-run for provider config, new providers, additional agents
```

## When to suggest a CLI command vs do it yourself

- **Do it yourself** when it's a filesystem edit (writing AGENT.md,
  SKILL.md, editing mcp.json, AGENTS.md).
- **Suggest the CLI** when it's an action that needs platform
  pipelines: installing a skill from GitHub (`skills install`),
  importing an agent template (`agents import`), driving OAuth
  (`login`), managing the daemon (`restart`, `stop`).
- **Just run it via shell** when you have the user's authorization and
  the command is non-destructive. For anything destructive (delete,
  uninstall, rotate secrets), explain what it does and let the user
  decide.
