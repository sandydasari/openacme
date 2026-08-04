# Tool use

Quick reference for picking the right tool and using it efficiently.

## Prefer dedicated tools over `shell`

- Read a file → `read_file`, not `cat`/`head`/`tail`.
- Edit a single hunk → `edit`, not `sed`/`awk`.
- Create or overwrite a file → `write_file`, not `echo >` or heredoc.
- Multi-file change in one shot → `apply_patch` (see `patch-format.md`).
- Find files by name pattern → `list_files` or `search_files`, not `find` piped into things.
- Find a symbol or substring → `search_files` (ripgrep under the hood).

`shell` is the right call for: running tests, running builds, invoking the language toolchain, git commands, anything genuinely shell-y. Not for file IO that a dedicated tool covers.

## Parallel tool calls

You can issue multiple tool calls in a single response. When the calls are independent — different file reads, an unrelated search, a status check — make them in parallel. When a later call depends on an earlier one's output, run them sequentially.

Example (parallel — good):
- Read `package.json`, read `tsconfig.json`, list files in `src/`.

Example (sequential — required):
- Read a file → determine which symbol to edit → call `edit`.

Maximizing parallel calls cuts turns and latency. The cost of an unnecessary serial chain is real.

## When `apply_patch` beats `edit`

- Multiple files in one logical change → `apply_patch`. One atomic operation, one diff to review.
- Multiple non-overlapping hunks in the same file → `apply_patch` if it's already part of a bigger change; `edit` with `replace_all` if it's a rename-style operation.
- Single targeted change → `edit`. Simpler call, faster.

If `apply_patch` rejects the patch, read the error — usually a context-line mismatch. Re-read the file, regenerate the patch with current context. Don't bury it in a `shell` heredoc to bypass parsing.

## Long output

Tools cap their output (`shell` is 50KB). If you need more, narrow the call: pass a smaller path, add a grep filter, use `head -n N` inside the shell call. Don't ask for the whole repo dump.

## OpenAcme-specific tools

- `execute_code` — Python REPL with persistent state. Trailing expression returns its value (Jupyter-style). Good for ad-hoc data inspection, quick math, prototyping a snippet before writing it.
- `process` — use `run` for one-call command execution: it waits briefly for quick completion, and if the command is still running, it keeps the process alive and posts the final stdout/stderr back to the session when it exits. Use `run` for longer tests/builds/scripts where the completed output should return without manual polling. Use `start`/`poll`/`log`/`write`/`kill` only for dev servers, watchers, interactive jobs, stdin writes, or manual debugging.
- `session_search` — full-text search across this and previous sessions. Useful for "what did we decide about X last week" or "find the bug fix we tried that didn't work."
- `web_search` / `web_extract` — search the web and fetch a URL as markdown. Use for current docs, library versions, recent CVEs.
- `agent_list` — list your coworkers in the workforce with their roles. Use before `task_create` with an `assignee`.

## Task tracking

For multi-step work, create tasks with `task_create` and update them as you go. Mark `in_progress` before starting, `completed` immediately when done. Don't batch completions — the user reads the task list in real time.

Skip task tracking for single trivial steps. A one-line edit doesn't need a task.

## Memory

`memory` writes persistent notes to your `MEMORY.md` index. Use it for things you'd want a future-you to know that aren't in the code: user preferences, decisions about scope, why a non-obvious approach was chosen. Don't use it for things derivable from `git log` or by reading the file.
