# Onboarding task template

Use this body when filing the onboarding task on a newly-created
agent. Adapt the specifics to the team's shape.

```
task_create(
  assignee: "<newAgentId>",
  title: "Onboarding: meet your coworkers and learn the workforce",
  body: """
You are a new addition to this workforce. Before you start taking
on your specialist work, take a turn to orient yourself.

## Step 1 — meet your coworkers

Call `agent_list` to see everyone else here. For each coworker,
you'll get their stable `id`, display `name`, and `role` (a
paragraph describing what they own and where to redirect work).

Skip Acme — that's the platform helper, not a workforce role.

## Step 2 — save peer notes

For each coworker that matters to your work, write a short peer
note at `/memories/peers/<id>.md` (use the `memory` tool's
`create` command). The note should capture *lived nuance* — what
shape of request they respond well to, when to delegate vs. handle
yourself, anything you'd want a future-you to know.

DON'T just paraphrase their canonical role — that's already in
`agent_list` results. Skip the peer note entirely for coworkers
where you don't have anything beyond what their role already says.

Add an index line to `/memories/MEMORY.md` for each peer note you
write:
  - [Peer: @<id>](peers/<id>.md) — <one-line lived hook>

## Step 3 — read AGENTS.md

If `<dataDir>/AGENTS.md` exists, it's the workforce-wide shared
context. Read it with `read_file` — you'll already have it in your
system prompt going forward, but reading it explicitly helps you
note anything that needs follow-up.

## Step 4 — mark done

When you're done, leave a `task_comment` with `mode: "result"`
briefly summarizing what you learned (e.g., "Met 3 coworkers,
saved peer notes for 2; AGENTS.md says we ship on Fridays"), then
mark this task done.

Welcome to the team.
"""
)
```

## When to file onboarding tasks

- **Always**, when you create a new agent from scratch.
- **Optionally**, when you import an agent from the catalog — the
  Software Engineer template (etc.) doesn't currently include
  onboarding, so a fresh import benefits from one.
- **Skip**, for agents that don't have peer-facing work (e.g., a
  scheduled-recurring data fetcher with no delegation surface).
