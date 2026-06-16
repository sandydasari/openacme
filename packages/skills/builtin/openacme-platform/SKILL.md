---
name: openacme-platform
description: How OpenAcme is laid out — data dir, agents, skills, MCP servers, tasks, memory, the peer-notes convention. Read this when the user asks you to manage their workforce, set up an agent, install a skill, configure an MCP server, or explain how the platform works.
tags: [platform, admin, reference]
---

# OpenAcme platform reference

OpenAcme is an AI-workforce platform — a set of role-specialized agents
working for a small human team. You are the platform-admin agent. The
user asks you to set up other agents, install skills, wire up MCP
servers, and explain how things work. This document is your reference
for all of that.

## Data directory layout

Every install has a single data directory (default `~/.openacme/`). The
user can override with `OPENACME_DATA_DIR`. Layout:

```
<dataDir>/
├── config.yaml             # platform config — top-level model, server port, browser
├── auth.json               # OAuth tokens (0600). NEVER touch.
├── .env                    # provider API keys. NEVER touch.
├── mcp-tokens/             # MCP OAuth state. NEVER touch.
├── state.db                # SQLite — sessions, messages, comments, events. NEVER write directly.
├── AGENTS.md               # shared workforce context — injected into every agent's prompt
├── mcp.json                # global MCP server catalog (inherited by every agent unless disabled)
├── skills/<name>/SKILL.md  # workforce-wide skills (you can write these)
├── agents/<id>/
│   ├── AGENT.md            # YAML frontmatter + persona body
│   ├── email.json          # per-agent mailbox creds (0600). NEVER touch.
│   ├── workspace/          # default cwd for the agent's shell + filesystem tools
│   ├── resources/          # user-supplied reference files (style guides, templates)
│   ├── browser-profiles/   # per-agent browser profile (chromium/ and/or firefox/)
│   └── memory/
│       ├── MEMORY.md       # index, always injected into prompt
│       ├── <topic>.md      # entry files read on demand
│       └── peers/<id>.md   # notes about a coworker, from prior delegations
├── teams/<id>/TEAM.md      # team definition (members, manager) + body
├── tasks/<id>.md           # one file per task (YAML frontmatter + body)
└── attachments/<sid>/<aid>/<file>   # chat file uploads
```

Each agent runs its own browser (separate profile, separate cookies)
and its own mailbox — both per-agent, never shared. `email.json` holds
mailbox credentials and is off-limits alongside the other secrets.

**Off-limits files** (do not read, do not write, no exceptions):
`auth.json`, `.env`, `mcp-tokens/`, `agents/<id>/email.json`,
`state.db`. These are platform secrets and corruption-prone state. If the user asks you to inspect
their provider credentials, tell them to check `<dataDir>/.env` or
`<dataDir>/auth.json` themselves — don't open the file.

## AGENT.md format

Each agent is a folder under `<dataDir>/agents/<id>/`. The id is the
folder name — renaming the folder renames the agent. The AGENT.md file
inside is YAML frontmatter + a markdown body for the persona.

```markdown
---
name: Coder
role: Owns implementation work and code review for the workforce. Reads
  existing patterns before writing new code. Hands off ambiguous design
  decisions to the user.
model:
  provider: anthropic
  model: claude-sonnet-4-20250514
  auth: oauth
tools: [shell, read_file, write_file, edit, apply_patch, list_files,
        search_files, web_search, web_extract, execute_code, process]
mcpServers: {}
mcpDisabled: []
skills: []
---

You are a senior software engineer. ...persona body in second-person...
```

Key fields:

- `name` — display name (any string).
- `role` — third-person paragraph for coworkers (used by `agent_list`).
- `model` — optional per-agent override; absent inherits the root
  `config.yaml`'s `model`.
- `tools` — environment-touching tools (shell, file IO, web, exec,
  browser). Introspection / self-management tools (`memory`,
  `skill_view`, `session_search`, `task_*`, `agent_list`, `ping_user`,
  `defer_session`) are **always-on system tools** merged in
  automatically — do NOT list them here. Email tools (`email_list`,
  `email_send`, …) appear only for agents that have a mailbox bound.
- `mcpServers` — agent-private MCP servers (names must not collide with
  global mcp.json).
- `mcpDisabled` — global mcp.json server names this agent should not
  receive.
- `skills` — empty/missing means "every installed skill"; non-empty is
  an allowlist.

When you create a new agent, write the AGENT.md directly. The folder
gets created on first read. Workspace and memory dirs are created
on-demand by the platform.

**Applying edits.** Nothing on disk applies automatically. After editing an
`AGENT.md` (or creating/deleting an agent), call **`reload_config`** — your
Acme-only tool — to make it take effect on the next turn (no restart). Batch
your edits and reload once at the end.

## SKILL.md format

Skills live at `<dataDir>/skills/<name>/SKILL.md`. The name in the
frontmatter must match the directory name. Progressive disclosure: the
platform injects the index (name + description + tags) into every
agent's system prompt; the body is loaded on demand via `skill_view`.

```markdown
---
name: my-skill
description: One-line description. Be specific — this is what other
  agents read when deciding whether to load the body.
tags: [tag1, tag2]
---

# Skill title

Body — markdown. Loaded on demand. No length cap beyond 1MB. Companion
files in the same dir (examples, templates) are surfaced as
"resources" the agent can read.
```

**Authoring a good skill:**
- Description is the trigger — be specific about WHEN the skill applies.
- Body should be reference content, not a step-by-step script. The
  agent reads it and decides how to apply it.
- Companion files (examples, templates) sit next to SKILL.md and are
  surfaced as resources.
- Skills are not invokable — agents read them, they don't call them.

**Locally-authored vs installed.** A skill you write by hand into
`<dataDir>/skills/<name>/` is "locally-authored" — no lockfile entry,
no audit trail. SkillHub (the install pipeline) refuses to clobber
locally-authored skills. To install from GitHub / marketplaces, use the
`openacme skills install` CLI command or the web UI's Skills page; do
NOT write SKILL.md files into directories that already have a lockfile
entry.

## mcp.json shape

Global MCP catalog at `<dataDir>/mcp.json`. Same JSON shape that Claude
Desktop, Cursor, Cline use — users can paste configs from anywhere.

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
  },
  "github": {
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
  }
}
```

Per-server fields: `command` + `args` (stdio), `url` + optional
`transport: "http"|"sse"` (HTTP / SSE), `env` (forwarded as-is —
inherited env is filtered to drop credential-shaped vars like
`AWS_*` / `OPENAI_*` / `GITHUB_TOKEN`; pass them explicitly here if a
server actually needs them), `headers`, `timeout`, `connectTimeout`,
`enabled`, `allowedTools`.

**Applying edits.** After editing `mcp.json`, call **`reload_config`** to
reconnect MCP (it re-inits servers — bringing a slow/broken one up can take a
few seconds). No restart. This reinit is deliberately explicit (it's
expensive), which is why it only happens when you call `reload_config`, never
automatically on a file change.

Per-agent private servers go in `mcpServers` on AGENT.md (must not
collide with global names). Per-agent exclusions go in `mcpDisabled`.

## AGENTS.md (shared context)

`<dataDir>/AGENTS.md` is workforce-wide context injected into every
agent's system prompt below the persona. Use it for things ALL agents
should know: shared conventions, the human team's working style, repo
URLs, current initiatives.

You can edit it freely. After editing, call **`reload_config`** to apply it
to every agent's prompt (no restart).

## Tasks

Tasks are filesystem-backed at `<dataDir>/tasks/<id>.md`. One file per
task, YAML frontmatter + markdown body.

**Lifecycle:** `open → in_progress` (claimed by assignee) `→ done |
canceled` (terminal). `blocked` is **explicit-only** — `depends_on`
does NOT auto-flip status. Readiness (deps satisfied AND `start_at`
due) is computed fresh at read time by the dispatcher, not stored.
Recurring tasks self-reset to `open` with the next fire time when
marked `done`; use `canceled` to stop a recurrence permanently.

**At most one `in_progress` per session.** The platform enforces this.

**Comments vs body vs events:**
- **Body** is the spec — one voice, owned by the assigner / assignee.
- **Comments** (`task_comment` / `task_comments`) are the discussion
  thread — multi-voice, append-only. Kind `result` is the assignee's
  canonical answer at completion; kind `system` is scheduler-authored.
- **Events** are the signal log (status changes, comments, dep
  unblocks) — read-only, queried via `/api/tasks/:id/events`.

**Dispatcher.** Tick-based, not event-reactive. A ~60s tick walks
agents and decides who to wake; task events don't wake anything
directly — they land as **inbox rows** the next tick observes. When an
agent has pending inbox rows (or a ready task), the dispatcher wakes
its session for one autonomous turn and the agent picks what to work
on. Wake latency is bounded by the tick (~60s from task creation to
the assignee starting).

**Onboarding pattern.** When you create a new agent, file an
**onboarding task** on them: `task_create(assignee: <newId>, title:
"Onboarding: read your coworkers and save peer notes", body: "Run
agent_list to see your coworkers. For each one, write a short peer
note at /memories/peers/<id>.md describing what to delegate to them
and any lived nuance you'd want a future-you to know.")`. The new
agent picks it up autonomously on first wake and learns the team.

## Memory

Per-agent memory at `<dataDir>/agents/<id>/memory/`. Uses Anthropic's
`memory_20250818` tool spec — six ops (`view`, `create`, `str_replace`,
`insert`, `delete`, `rename`) against virtual paths under `/memories/`.

`MEMORY.md` is the index — always injected into the prompt. Write-time
char cap is the agent's `memoryCharLimit` (default 4000). Entries live
in topic files (`<topic>.md`) loaded on demand.

**Peer notes.** Convention is `peers/<peerId>.md` — one note per
coworker keyed by stable agent id. Captures lived nuance from prior
delegations, NOT a paraphrase of the canonical role. The `agent_list`
tool surfaces peer notes inline so a delegating agent sees both
canonical role and their own learned context.

## Teams

A team groups agents under a shared name. Defined at
`<dataDir>/teams/<id>/TEAM.md` (frontmatter + body): `members` (agent
ids) and an optional `manager` (must be a member). The manager is a
**routing default, not authority**: a team-addressed `task_create`
(team set, no assignee) lands on the manager for triage, members'
prompts show `Manager: <id>`, and the manager's prompt gets a
triage-duty note. No charter powers, no extra tools. You can create
and edit teams by writing TEAM.md.

## Email

Email is **per-agent and opt-in** — each agent that gets a mailbox has
its own address, credentials, and isolation. The email tools resolve
the *current* agent's mailbox; there is no "which mailbox" argument, so
one agent literally cannot touch another's. Backends: generic
IMAP/SMTP, Gmail API, Microsoft Graph (Gmail/Microsoft use a
bring-your-own OAuth app set in Settings → Email).

You manage the **non-secret binding** (provider, address) in an
agent's `email` frontmatter, but **never** the credentials —
`agents/<id>/email.json` is off-limits. To connect a mailbox, point the
user at the agent's Email panel in the web UI (or `openacme email
login <agentId>`); the email tools only appear for an agent once a
mailbox is bound.

## Browser

Each agent gets its own browser session (separate profile under
`agents/<id>/browser-profiles/`, separate cookies and fingerprint) so
logins and bans never cascade across the workforce. Lazy — nothing
spawns until the agent first calls a `browser_*` tool. Provider
(local Chrome / Browserbase / Browser Use / Firecrawl) is set in
`config.yaml` under `browser`.

## Everything applies live — almost

The platform watches its config surfaces under the data dir, so **your
edits take effect on the next turn with no restart**: `config.yaml`
(model, behavior, browser, email), `AGENTS.md`, `mcp.json`, any
`agents/<id>/AGENT.md`, and `skills/**/SKILL.md`. The web Settings UI
applies live too. So do creating, editing, and deleting agents.

The **one** thing that still needs `openacme restart` is changing the
server **host or port** — that's a live socket bind and can't be swapped
in place. Tell the user to restart only in that case.

## How you set things up

When the user asks you to create a new agent:

1. Decide id, name, role, persona, tools, model (inherit from
   `config.yaml` if no specific reason).
2. Write `<dataDir>/agents/<id>/AGENT.md` with the frontmatter +
   persona body.
3. File an onboarding task on the new agent so they learn the team.
4. That's it — the new agent is picked up live (no restart) and shows up
   in the roster and picker.

When the user asks you to install a skill:

- If they want a workforce-wide skill they're authoring themselves:
  write `<dataDir>/skills/<name>/SKILL.md` directly.
- If they want to install from GitHub / a marketplace: use the
  `openacme skills install` CLI or the web Skills page. Don't paste a
  fetched SKILL.md by hand — the install pipeline handles trust,
  lockfile, and audit.

When the user asks you to add an MCP server:

1. Read `<dataDir>/mcp.json` (or create it as `{}` if missing).
2. Add the server entry (same shape Claude Desktop / Cursor use).
3. That's it — the platform watches `mcp.json` and the affected agents
   re-connect on their next turn (no restart).

When the user asks how something works:

- Walk through the relevant section of this skill in your own words.
- Reference your `resources/` folder — it has example AGENT.md /
  SKILL.md / mcp.json snippets you can show.
- Link the docs when the user wants the full walkthrough or
  screenshots (see below).

## Docs site

There's a public docs site at **https://openacme.pages.dev/docs** with
walkthroughs and screenshots. This skill is your fast reference for
*doing* things; the docs are the deep-dive you point the user to when
they want to read more or set up something step-by-step. Useful pages:

- `/docs/quickstart` — install + first run
- `/docs/agents` · `/docs/teams` · `/docs/tasks` — the workforce model
- `/docs/skills` · `/docs/memory` · `/docs/mcp` — capabilities
- `/docs/browser` · `/docs/email` — per-agent browser and mailbox setup
- `/docs/configuration` · `/docs/self-hosting` · `/docs/remote-access` —
  config, deploying on a server, exposing it safely
- `/docs/cli` · `/docs/troubleshooting`

Cite a specific page rather than the bare site when you can. For
provider-specific setup (Gmail app passwords, Microsoft OAuth, etc.)
the `/docs/email` page links the official upstream guides.

### Embedding screenshots in chat

The web chat renders standard markdown images, so you can show a UI
screenshot inline:

```
![Settings → Email](https://openacme.pages.dev/screens/light/email-settings.webp)
```

URL pattern: `https://openacme.pages.dev/screens/<theme>/<name>.webp`
where `<theme>` is `light` or `dark`. **Only use these known names** —
never invent a filename; a wrong URL renders as a broken image:

`agents`, `board`, `brief`, `chat`, `email-settings`, `home`, `login`,
`result`, `skills`, `teams`.

Use this when a screenshot genuinely helps the user find something in
the UI (e.g. "the Email panel is here") — not on every reply. Two
caveats: you can't *see* these images (you're citing a known URL, not
viewing it), and they only render in the **web** chat — the terminal
chat shows alt text only, so always keep the alt text descriptive.
