import { useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronRight, Bell, Clock } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/app/lib/utils";
import { Markdown } from "./Markdown";
import { MediaPreview } from "./MediaPreview";

/*
 * Renders a tool-${name} UIMessagePart.
 *
 * Two modes by tool name:
 *  - Known: header row + tool-specific inline body (always visible). A
 *    Raw I/O disclosure sits below it for the full JSON.
 *  - Unknown (incl. mcp-*): one-line row, click to expand raw I/O.
 */

export interface ToolPart {
  type: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

const KNOWN_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit",
  "apply_patch",
  "list_files",
  "search_files",
  "shell",
  "execute_code",
  "web_search",
  "session_search",
  "web_extract",
  "skill_view",
  "memory",
  "task_create",
  "task_view",
  "task_update",
  "task_list",
  "task_comment",
  "task_comments",
  "process",
  "ping_user",
  "sleep",
]);

// Tool names that resolve to a single task — used to render an "Open"
// link in the header that deep-links into /tasks?id=<id>.
const SINGLE_TASK_TOOLS = new Set([
  "task_create",
  "task_view",
  "task_update",
  "task_comment",
  "task_comments",
]);

export function ToolBlock({ part }: { part: ToolPart }) {
  const toolName = part.type.slice("tool-".length);
  const known = KNOWN_TOOLS.has(toolName);
  return known ? (
    <KnownToolBlock part={part} toolName={toolName} />
  ) : (
    <UnknownToolBlock part={part} toolName={toolName} />
  );
}

// ── Known tool: header + inline body, raw I/O behind disclosure ─────────────

function KnownToolBlock({
  part,
  toolName,
}: {
  part: ToolPart;
  toolName: string;
}) {
  const status = computeStatus(part);
  const summary = useMemo(
    () => renderSummary(toolName, part.input, part.output),
    [toolName, part.input, part.output]
  );
  const body = useMemo(
    () =>
      renderBody({
        name: toolName,
        input: part.input,
        output: part.output,
        errorText: part.errorText,
      }),
    [toolName, part.input, part.output, part.errorText]
  );
  const taskId = useMemo(
    () =>
      SINGLE_TASK_TOOLS.has(toolName)
        ? resolveTaskId(toolName, part.input, part.output)
        : null,
    [toolName, part.input, part.output]
  );

  return (
    <div className="border border-paper-rule section-enter">
      <HeaderRow
        toolName={toolName}
        status={status}
        summary={summary}
        taskId={taskId}
      />
      {body && <div className="border-t border-paper-rule">{body}</div>}
    </div>
  );
}

// ── ping_user callout ────────────────────────────────────────────────────────
// Rendered by MessageBubble at the BOTTOM of the assistant message regardless
// of where the call fired mid-turn. The ping is the agent's attention signal;
// inline it drowns under whatever narration follows it.

export function PingUserCallout({
  part,
  answered = false,
}: {
  part: ToolPart;
  /** A user message followed this ping — drop the urgent treatment. */
  answered?: boolean;
}) {
  const msg = isObj(part.input) ? str(part.input.message) : undefined;
  if (!msg) return <ToolBlock part={part} />;
  const out = parseJsonish(part.output);
  const err =
    part.errorText && part.errorText !== "[interrupted]"
      ? part.errorText
      : out
        ? str(out.error)
        : undefined;
  return (
    <div
      className={cn(
        "section-enter border",
        answered ? "border-paper-rule" : "border-plot-red"
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-1.5",
          answered ? "bg-paper-sunk" : "bg-plot-red/[0.06]"
        )}
      >
        <Bell
          className={cn(
            "size-3.5 shrink-0",
            answered ? "text-ink-faint" : "text-plot-red"
          )}
          aria-hidden
        />
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.08em]",
            answered ? "text-ink-faint" : "text-plot-red"
          )}
        >
          {answered ? "Asked for input" : "Needs your input"}
        </span>
      </div>
      <div className="border-t border-paper-rule px-3 py-2 text-sm leading-relaxed text-ink break-words">
        <Markdown>{msg}</Markdown>
      </div>
      {err && (
        <div className="border-t border-paper-rule px-3 py-2 font-mono text-[11px] leading-snug text-destructive whitespace-pre-wrap break-words">
          {err}
        </div>
      )}
    </div>
  );
}

// ── Unknown tool: single row, click to reveal raw I/O ───────────────────────

function UnknownToolBlock({
  part,
  toolName,
}: {
  part: ToolPart;
  toolName: string;
}) {
  const [open, setOpen] = useState(false);
  const status = computeStatus(part);
  const hasIO =
    part.input !== undefined ||
    part.output !== undefined ||
    part.errorText !== undefined;

  return (
    <div className="border border-paper-rule section-enter">
      <button
        type="button"
        onClick={() => hasIO && setOpen((o) => !o)}
        disabled={!hasIO}
        aria-expanded={hasIO ? open : undefined}
        aria-label={`${toolName} tool call — raw input and output`}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors",
          hasIO &&
            "hover:bg-paper focus-visible:bg-paper focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red"
        )}
      >
        <StatusDot status={status} />
        <span className="font-mono text-[12px] text-ink shrink-0">{toolName}</span>
        <span className="flex-1" />
        <StatusLabel status={status} />
        {hasIO && (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-ink-faint transition-transform",
              open && "rotate-90"
            )}
            aria-hidden
          />
        )}
      </button>
      {open && hasIO && (
        <div className="border-t border-paper-rule">
          <RawIOBody part={part} />
        </div>
      )}
    </div>
  );
}

// ── Header row (known) ──────────────────────────────────────────────────────

function HeaderRow({
  toolName,
  status,
  summary,
  taskId,
}: {
  toolName: string;
  status: Status;
  summary: ReactNode;
  taskId?: string | null;
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5">
      <StatusDot status={status} />
      <span className="font-mono text-[12px] text-ink shrink-0">{toolName}</span>
      {summary && (
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-soft">
          {summary}
        </span>
      )}
      {!summary && <span className="flex-1" />}
      {taskId && <OpenTaskLink taskId={taskId} />}
      <StatusLabel status={status} />
    </div>
  );
}

function OpenTaskLink({ taskId }: { taskId: string }) {
  return (
    <Link
      to="/tasks"
      search={{ id: taskId }}
      onClick={(e) => e.stopPropagation()}
      className="flex shrink-0 items-center gap-1 border border-paper-rule px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft transition-colors hover:border-plot-red hover:text-plot-red focus-visible:border-plot-red focus-visible:text-plot-red focus-visible:outline-none"
    >
      Open
      <ArrowUpRight className="size-3" aria-hidden />
    </Link>
  );
}

// ── Status ──────────────────────────────────────────────────────────────────

type Status = "running" | "done" | "error" | "interrupted";
const STATUS_LABEL: Record<Status, string> = {
  running: "Running",
  done: "Done",
  error: "Error",
  interrupted: "Interrupted",
};

function computeStatus(part: ToolPart): Status {
  // True "interrupted" tool parts have been sanitized to `output-error` with
  // errorText `[interrupted]` by `finalizeOrphanToolParts` server-side; any
  // input-* state we render is necessarily an in-flight tool call. Don't
  // gate it on isStreaming — that flag races with chunk arrival (e.g.,
  // while the handler is executing and no chunks are landing), and a brief
  // off-window would mis-flag a running write_file as interrupted.
  const interrupted =
    part.state === "output-error" && part.errorText === "[interrupted]";
  if (interrupted) return "interrupted";
  if (part.state === "output-error") return "error";
  if (part.state === "input-streaming" || part.state === "input-available") {
    return "running";
  }
  return "done";
}

function StatusDot({ status }: { status: Status }) {
  // Indicator-lamp model: the lamp is always present; it's LIT blue and
  // pulsing while running, red on error, and UNLIT (hairline gray) once
  // done — visible on the faceplate without reading as a column of marks.
  // Interrupted keeps the hollow stopped ring.
  if (status === "done") {
    return <span className="status-dot shrink-0 bg-ink-faint" aria-hidden />;
  }
  if (status === "interrupted") {
    return (
      <span
        aria-hidden
        className="status-dot shrink-0 bg-transparent border border-ink-faint"
      />
    );
  }
  const cls =
    status === "running" ? "bg-signal-blue pulse-live" : "bg-destructive";
  return <span className={cn("status-dot shrink-0", cls)} aria-hidden />;
}

function StatusLabel({ status }: { status: Status }) {
  const cls =
    status === "error"
      ? "text-destructive"
      : status === "interrupted"
        ? "text-ink-faint"
        : status === "running"
          ? "text-signal-blue"
          : "text-ink-faint";
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[10px] uppercase tracking-[0.08em]",
        cls
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

// ── Summary line (right of tool name) ───────────────────────────────────────

function renderSummary(name: string, input: unknown, output: unknown): ReactNode {
  if (!isObj(input)) return null;

  switch (name) {
    case "read_file":
    case "write_file": {
      const p = str(input.path);
      const bytes =
        name === "write_file"
          ? num(parseJsonish(output)?.bytesWritten)
          : null;
      return (
        <span className="flex min-w-0 items-center gap-2">
          {p && <PathChip path={p} />}
          {bytes !== null && <span className="text-ink-faint">{bytes} B</span>}
        </span>
      );
    }
    case "edit": {
      const p = str(input.path);
      const oldS = str(input.oldString) ?? "";
      const newS = str(input.newString) ?? "";
      const file = editToFile(p ?? "", oldS, newS);
      return (
        <span className="flex min-w-0 items-center gap-2">
          {p && <PathChip path={p} />}
          <DiffStat added={file.added} removed={file.removed} />
        </span>
      );
    }
    case "apply_patch": {
      const text = str(input.patchText) ?? "";
      const files = parseV4APatch(text);
      const totalAdded = files.reduce((a, f) => a + f.added, 0);
      const totalRemoved = files.reduce((a, f) => a + f.removed, 0);
      const path = files.length === 1 ? files[0]?.path : undefined;
      return (
        <span className="flex min-w-0 items-center gap-2">
          {path ? (
            <PathChip path={path} />
          ) : (
            <span className="text-ink-faint">{files.length} files</span>
          )}
          <DiffStat added={totalAdded} removed={totalRemoved} />
        </span>
      );
    }
    case "list_files": {
      const p = str(input.path);
      return p ? <PathChip path={p} /> : <span className="text-ink-faint">cwd</span>;
    }
    case "search_files": {
      const pat = str(input.pattern) ?? str(input.query);
      const where = str(input.path);
      return (
        <span className="flex min-w-0 items-center gap-2">
          {pat && (
            <code className="truncate bg-paper px-1.5 py-px text-[11px] text-ink">
              {pat}
            </code>
          )}
          {where && (
            <>
              <span className="text-ink-faint">in</span>
              <PathChip path={where} />
            </>
          )}
        </span>
      );
    }
    case "shell": {
      const cmd = str(input.command);
      return cmd ? <CommandChip command={cmd} /> : null;
    }
    case "execute_code": {
      const code = str(input.code) ?? "";
      const first = firstNonEmptyLine(code);
      return first ? <CommandChip command={first} /> : null;
    }
    case "web_search":
    case "session_search": {
      const q = str(input.query);
      const out = parseJsonish(output);
      const n = countResults(out);
      return (
        <span className="flex min-w-0 items-center gap-2">
          {q && (
            <code className="truncate bg-paper px-1.5 py-px text-[11px] text-ink">
              {q}
            </code>
          )}
          {n !== null && (
            <span className="text-ink-faint">
              {n} {n === 1 ? "result" : "results"}
            </span>
          )}
        </span>
      );
    }
    case "web_extract": {
      const u = str(input.url);
      return u ? <span className="truncate text-ink">{u}</span> : null;
    }
    case "skill_view": {
      const n = str(input.name);
      return n ? <span className="text-ink">{n}</span> : null;
    }
    case "memory": {
      const a = str(input.action);
      const c = str(input.content);
      return (
        <span className="flex min-w-0 items-center gap-2">
          {a && <span className="text-ink">{a}</span>}
          {c && <span className="truncate text-ink-faint">{trim(c, 80)}</span>}
        </span>
      );
    }
    case "task_create": {
      const t = str(input.title);
      const out = parseJsonish(output);
      const createdId = pickTaskId(out);
      return (
        <span className="flex min-w-0 items-center gap-2">
          {createdId && (
            <code className="bg-paper px-1.5 py-px text-[11px] text-ink">
              {`#${createdId}`}
            </code>
          )}
          {t && <span className="min-w-0 truncate text-ink">{t}</span>}
        </span>
      );
    }
    case "task_view":
    case "task_update": {
      const id = taskIdStr(input.task_id) ?? taskIdStr(input.id);
      const status = str(input.status);
      return (
        <span className="flex min-w-0 items-center gap-2">
          {id && (
            <code className="bg-paper px-1.5 py-px text-[11px] text-ink">
              {`#${id}`}
            </code>
          )}
          {status && <span className="text-ink-faint">{status}</span>}
        </span>
      );
    }
    case "task_comment": {
      const id = taskIdStr(input.task_id) ?? taskIdStr(input.id);
      const kind = str(input.kind);
      return (
        <span className="flex min-w-0 items-center gap-2">
          {id && (
            <code className="bg-paper px-1.5 py-px text-[11px] text-ink">
              {`#${id}`}
            </code>
          )}
          {kind && <span className="text-ink-faint">{kind}</span>}
        </span>
      );
    }
    case "task_comments": {
      const id = taskIdStr(input.task_id) ?? taskIdStr(input.id);
      const out = parseJsonish(output);
      const n = countResults(out) ?? num(out?.count);
      return (
        <span className="flex min-w-0 items-center gap-2">
          {id && (
            <code className="bg-paper px-1.5 py-px text-[11px] text-ink">
              {`#${id}`}
            </code>
          )}
          {n !== null && (
            <span className="text-ink-faint">
              {n} {n === 1 ? "comment" : "comments"}
            </span>
          )}
        </span>
      );
    }
    case "task_list": {
      const filt = [str(input.assignee), str(input.status)]
        .filter(Boolean)
        .join(" · ");
      const out = parseJsonish(output);
      const n = countResults(out);
      return (
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-ink-faint">{filt || "all"}</span>
          {n !== null && (
            <span className="text-ink-faint">
              {n} {n === 1 ? "task" : "tasks"}
            </span>
          )}
        </span>
      );
    }
    case "process": {
      const a = str(input.action);
      const id = str(input.id);
      const cmd = str(input.command);
      return (
        <span className="flex min-w-0 items-center gap-2">
          {a && <span className="text-ink">{a}</span>}
          {id && (
            <code className="bg-paper px-1.5 py-px text-[11px] text-ink">{id}</code>
          )}
          {cmd && <CommandChip command={cmd} />}
        </span>
      );
    }
    case "ping_user": {
      const msg = str(input.message);
      const excerpt = msg ? trim(msg, 80) : "";
      return (
        <span className="flex min-w-0 items-center gap-2">
          <Bell className="size-3 shrink-0 text-plot-red" aria-hidden />
          {excerpt && <span className="truncate text-ink">{excerpt}</span>}
        </span>
      );
    }
    case "sleep": {
      const dur = str(input.duration);
      const out = parseJsonish(output);
      const next = str(out?.next_check_at);
      return (
        <span className="flex min-w-0 items-center gap-2">
          <Clock className="size-3 shrink-0 text-ink-soft" aria-hidden />
          {dur && <span className="text-ink">{dur}</span>}
          {next && (
            <span className="truncate text-ink-faint">
              until {new Date(next).toLocaleString()}
            </span>
          )}
        </span>
      );
    }
    default:
      return null;
  }
}

// ── Inline body (under header for known tools) ──────────────────────────────

function renderBody({
  name,
  input,
  output,
  errorText,
}: {
  name: string;
  input: unknown;
  output: unknown;
  errorText?: string;
}): ReactNode {
  if (errorText && errorText !== "[interrupted]") {
    return (
      <div className="px-3 py-2 font-mono text-[11px] leading-snug text-destructive whitespace-pre-wrap break-words">
        {errorText}
      </div>
    );
  }
  if (!isObj(input)) return null;

  switch (name) {
    case "edit": {
      const p = str(input.path) ?? "(unknown)";
      const oldS = str(input.oldString) ?? "";
      const newS = str(input.newString) ?? "";
      if (oldS === "" && newS === "") return null;
      return <FileDiffView files={[editToFile(p, oldS, newS)]} />;
    }
    case "apply_patch": {
      const text = str(input.patchText) ?? "";
      if (!text) return null;
      const files = parseV4APatch(text);
      if (files.length === 0) return null;
      return <FileDiffView files={files} />;
    }
    case "shell":
    case "execute_code":
      return <ShellOutputView output={output} />;
    case "web_search":
    case "session_search": {
      const out = parseJsonish(output);
      const results = pickResults(out);
      if (!results || results.length === 0) {
        // Provider returned a text blob instead of structured items
        // (e.g. Exa unauthenticated) — render it rather than nothing.
        const content = out && str(out.content);
        if (content) {
          return (
            <pre className="max-h-60 overflow-auto px-3 py-2 font-mono text-[11px] leading-snug text-ink-soft whitespace-pre-wrap break-words">
              {trim(content, 4000)}
            </pre>
          );
        }
        return null;
      }
      return (
        <div className="divide-y divide-paper-rule">
          {results.slice(0, 8).map((r, i) => (
            <div key={i} className="px-3 py-2">
              {r.title && (
                <div className="truncate text-[12px] text-ink">{r.title}</div>
              )}
              {r.url && (
                <div className="truncate font-mono text-[11px] text-ink-faint">
                  {r.url}
                </div>
              )}
              {r.snippet && (
                <div className="mt-1 line-clamp-3 text-[11px] text-ink-soft">
                  {r.snippet}
                </div>
              )}
            </div>
          ))}
        </div>
      );
    }
    case "process": {
      const out = parseJsonish(output);
      const log = out && (str(out.output) ?? str(out.log));
      if (!log) return null;
      return (
        <pre className="max-h-60 overflow-auto px-3 py-2 font-mono text-[11px] leading-snug text-ink-soft whitespace-pre-wrap break-words">
          {trim(log, 4000)}
        </pre>
      );
    }
    case "ping_user": {
      // The message arg is the user-facing content. Render it like a
      // regular assistant bubble below the tool-call header so the
      // operator sees both signals: "this was a ping" (the header) +
      // "here's the message" (the bubble).
      const msg = str(input.message);
      if (!msg) return null;
      return (
        <div className="px-3 py-2 text-sm leading-relaxed text-ink break-words">
          <Markdown>{msg}</Markdown>
        </div>
      );
    }
    case "sleep":
      // The duration + next_check_at are already in the summary; no
      // separate body content.
      return null;
    case "read_file":
    case "browser_take_screenshot": {
      const out = parseJsonish(output);
      if (!out) return null;
      const url = str(out.url);
      const mediaType = str(out.mediaType);
      if (!url || !mediaType) return null;
      return <MediaPreview url={url} mediaType={mediaType} />;
    }
    default:
      return null;
  }
}


// Body for shell / execute_code — output only. The command/code is already
// shown as the header summary; repeating it here is noise.
function ShellOutputView({ output }: { output: unknown }) {
  const out = parseJsonish(output);
  const stdout = out && (str(out.output) ?? str(out.stdout));
  const stderr = out && str(out.stderr);
  const value = out && str(out.value);
  const errMsg = out && str(out.error);
  if (!stdout && !stderr && !value && !errMsg) return null;
  return (
    <div className="space-y-2 px-3 py-2">
      {stdout && (
        <pre className="overflow-x-auto font-mono text-[11px] leading-snug text-ink-soft whitespace-pre-wrap break-words">
          {trim(stdout, 4000)}
        </pre>
      )}
      {value && (
        <pre className="overflow-x-auto font-mono text-[11px] leading-snug text-ink whitespace-pre-wrap break-words">
          {trim(value, 2000)}
        </pre>
      )}
      {stderr && (
        <pre className="overflow-x-auto font-mono text-[11px] leading-snug text-ink-soft whitespace-pre-wrap break-words">
          {trim(stderr, 2000)}
        </pre>
      )}
      {errMsg && (
        <pre className="overflow-x-auto font-mono text-[11px] leading-snug text-destructive whitespace-pre-wrap break-words">
          {errMsg}
        </pre>
      )}
    </div>
  );
}

// ── Diff / patch ────────────────────────────────────────────────────────────

type DiffLineType = " " | "-" | "+";
interface DiffLine {
  type: DiffLineType;
  text: string;
}
interface DiffHunk {
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  kind: "add" | "update" | "delete" | "move" | "edit";
  newPath?: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

function lineDiffSingleHunk(oldText: string, newText: string): DiffHunk {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  // Common prefix
  let p = 0;
  while (
    p < oldLines.length &&
    p < newLines.length &&
    oldLines[p] === newLines[p]
  )
    p++;
  // Common suffix (don't overlap with prefix)
  let s = 0;
  while (
    s < oldLines.length - p &&
    s < newLines.length - p &&
    oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]
  )
    s++;
  // Cap context to keep blocks scannable
  const ctx = 2;
  const prefixCtx = oldLines.slice(Math.max(0, p - ctx), p);
  const suffixCtx = oldLines.slice(
    oldLines.length - s,
    oldLines.length - s + ctx
  );
  const removed = oldLines.slice(p, oldLines.length - s);
  const added = newLines.slice(p, newLines.length - s);
  const lines: DiffLine[] = [
    ...prefixCtx.map((t) => ({ type: " " as const, text: t })),
    ...removed.map((t) => ({ type: "-" as const, text: t })),
    ...added.map((t) => ({ type: "+" as const, text: t })),
    ...suffixCtx.map((t) => ({ type: " " as const, text: t })),
  ];
  return { lines };
}

export function editToFile(path: string, oldText: string, newText: string): DiffFile {
  const hunk = lineDiffSingleHunk(oldText, newText);
  let added = 0,
    removed = 0;
  for (const l of hunk.lines) {
    if (l.type === "+") added++;
    else if (l.type === "-") removed++;
  }
  const kind: DiffFile["kind"] = oldText === "" ? "add" : "edit";
  return { path, kind, added, removed, hunks: [hunk] };
}

// Parse the V4A patch envelope used by apply_patch. Format markers:
//   *** Begin Patch
//   *** Add File: <path>     -> body lines start with '+'
//   *** Update File: <path>  -> body has @@ hunks with ' '/'+'/'-' lines
//   *** Delete File: <path>  -> body lines start with '-'
//   *** Move File: <a> -> <b>
//   *** End of File          (between files in some emitters)
//   *** End Patch
function parseV4APatch(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split("\n");
  let cur: DiffFile | null = null;
  let curHunk: DiffHunk | null = null;

  const flushHunk = () => {
    if (cur && curHunk && curHunk.lines.length > 0) {
      cur.hunks.push(curHunk);
    }
    curHunk = null;
  };
  const flushFile = () => {
    flushHunk();
    if (cur) files.push(cur);
    cur = null;
  };

  for (const raw of lines) {
    const line = raw;
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) {
      flushFile();
      cur = { path: m[1] as string, kind: "add", added: 0, removed: 0, hunks: [] };
      curHunk = { lines: [] };
      continue;
    }
    if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) {
      flushFile();
      cur = {
        path: m[1] as string,
        kind: "update",
        added: 0,
        removed: 0,
        hunks: [],
      };
      curHunk = null;
      continue;
    }
    if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      flushFile();
      cur = {
        path: m[1] as string,
        kind: "delete",
        added: 0,
        removed: 0,
        hunks: [],
      };
      curHunk = { lines: [] };
      continue;
    }
    if ((m = /^\*\*\* Move File: (.+) -> (.+)$/.exec(line))) {
      flushFile();
      cur = {
        path: m[1] as string,
        newPath: m[2] as string,
        kind: "move",
        added: 0,
        removed: 0,
        hunks: [],
      };
      curHunk = null;
      continue;
    }
    if (line.startsWith("*** End of File")) {
      flushFile();
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@")) {
      flushHunk();
      curHunk = { lines: [] };
      continue;
    }
    // Body lines
    if (cur.kind === "delete") {
      curHunk ??= { lines: [] };
      curHunk.lines.push({ type: "-", text: line });
      cur.removed++;
      continue;
    }
    if (cur.kind === "add") {
      curHunk ??= { lines: [] };
      // Add files emit pure '+'; tolerate plain lines too
      const text = line.startsWith("+") ? line.slice(1) : line;
      curHunk.lines.push({ type: "+", text });
      cur.added++;
      continue;
    }
    // update
    if (line.startsWith(" ") || line === "") {
      curHunk ??= { lines: [] };
      curHunk.lines.push({ type: " ", text: line.startsWith(" ") ? line.slice(1) : line });
    } else if (line.startsWith("-")) {
      curHunk ??= { lines: [] };
      curHunk.lines.push({ type: "-", text: line.slice(1) });
      cur.removed++;
    } else if (line.startsWith("+")) {
      curHunk ??= { lines: [] };
      curHunk.lines.push({ type: "+", text: line.slice(1) });
      cur.added++;
    }
  }
  flushFile();
  return files;
}

function FileDiffView({ files }: { files: DiffFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="divide-y divide-paper-rule">
      {files.map((f, i) => (
        <FileDiffBlock key={i} file={f} />
      ))}
    </div>
  );
}

function FileDiffBlock({ file }: { file: DiffFile }) {
  const kindLabel: Record<DiffFile["kind"], string> = {
    add: "added",
    update: "updated",
    delete: "deleted",
    move: "moved",
    edit: "edited",
  };
  // Compute gutter width once across all hunks
  let maxOld = 0;
  let maxNew = 0;
  let oldNo = 1;
  let newNo = 1;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type === " ") {
        maxOld = Math.max(maxOld, oldNo);
        maxNew = Math.max(maxNew, newNo);
        oldNo++;
        newNo++;
      } else if (l.type === "-") {
        maxOld = Math.max(maxOld, oldNo);
        oldNo++;
      } else {
        maxNew = Math.max(maxNew, newNo);
        newNo++;
      }
    }
  }
  const gutter = Math.max(2, String(Math.max(maxOld, maxNew)).length);
  return (
    <div>
      <div className="flex items-baseline gap-3 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint shrink-0">
          {kindLabel[file.kind]}
        </span>
        <code className="min-w-0 truncate font-mono text-[12px] text-ink">
          {file.kind === "move" && file.newPath
            ? `${file.path} → ${file.newPath}`
            : file.path}
        </code>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
          {file.added > 0 && (
            <span className="text-signal-green">+{file.added}</span>
          )}
          {file.removed > 0 && (
            <span className="text-destructive">−{file.removed}</span>
          )}
        </span>
      </div>
      {file.hunks.length > 0 && (
        <HunksView hunks={file.hunks} gutter={gutter} />
      )}
    </div>
  );
}

function HunksView({ hunks, gutter }: { hunks: DiffHunk[]; gutter: number }) {
  let oldNo = 1;
  let newNo = 1;
  return (
    <div className="overflow-x-auto font-mono text-[11px] leading-[1.45]">
      {hunks.map((h, hi) => (
        <div key={hi} className={hi > 0 ? "border-t border-paper-rule" : undefined}>
          {h.lines.map((line, li) => {
            let oldShown: number | null = null;
            let newShown: number | null = null;
            if (line.type === " ") {
              oldShown = oldNo++;
              newShown = newNo++;
            } else if (line.type === "-") {
              oldShown = oldNo++;
            } else {
              newShown = newNo++;
            }
            const rowCls =
              line.type === "+"
                ? "bg-signal-green/[0.08] text-ink"
                : line.type === "-"
                  ? "bg-destructive/[0.08] text-ink"
                  : "text-ink-soft";
            const sigilCls =
              line.type === "+"
                ? "text-signal-green"
                : line.type === "-"
                  ? "text-destructive"
                  : "text-ink-faint";
            return (
              <div key={li} className={cn("flex whitespace-pre", rowCls)}>
                <Gutter n={oldShown} width={gutter} />
                <Gutter n={newShown} width={gutter} />
                <span className={cn("select-none px-2", sigilCls)}>
                  {line.type === " " ? " " : line.type}
                </span>
                <span className="break-words">{line.text}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Gutter({ n, width }: { n: number | null; width: number }) {
  return (
    <span
      className="select-none border-r border-paper-rule px-1.5 text-right text-ink-faint tabular-nums"
      style={{ minWidth: `${width + 2}ch` }}
    >
      {n ?? ""}
    </span>
  );
}

// Raw input/output dump — only shown for unknown tools (click-to-expand).
// Known tools render their custom view and drop this; the underlying part
// data is still accessible via the message store / useChat for future UI.
function RawIOBody({ part }: { part: ToolPart }) {
  return (
    <>
      {part.input !== undefined && (
        <div>
          <div className="px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Input
          </div>
          <pre className="max-h-60 overflow-auto px-3 py-2 font-mono text-[11px] leading-snug text-ink-soft whitespace-pre-wrap break-all">
            {trim(safeStringify(part.input), 4000)}
          </pre>
        </div>
      )}
      {(part.output !== undefined || part.errorText !== undefined) && (
        <div>
          <div className="border-t border-paper-rule px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            {part.errorText ? "Error" : "Output"}
          </div>
          <pre className="max-h-60 overflow-auto px-3 py-2 font-mono text-[11px] leading-snug text-ink-soft whitespace-pre-wrap break-all">
            {trim(formatOutput(part.output, part.errorText), 4000)}
          </pre>
        </div>
      )}
    </>
  );
}

// ── Inline chips ────────────────────────────────────────────────────────────

function PathChip({ path }: { path: string }) {
  return (
    <code className="truncate font-mono text-[12px] text-ink">{shortPath(path)}</code>
  );
}

function CommandChip({ command }: { command: string }) {
  return (
    <code className="truncate font-mono text-[12px] text-ink">
      {firstNonEmptyLine(command)}
    </code>
  );
}

function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
      {added > 0 && <span className="text-signal-green">+{added}</span>}
      {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function trim(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…";
}
function firstNonEmptyLine(s: string): string {
  for (const line of s.split("\n")) {
    if (line.trim()) return line;
  }
  return s;
}
function shortPath(p: string): string {
  if (p.length < 60) return p;
  const segs = p.split("/");
  if (segs.length <= 4) return p;
  return ".../" + segs.slice(-3).join("/");
}
function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
function parseJsonish(v: unknown): Record<string, unknown> | null {
  if (isObj(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return isObj(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}
function formatOutput(output: unknown, errorText?: string): string {
  if (errorText) return errorText;
  if (output === undefined) return "";
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return output;
    }
  }
  return safeStringify(output);
}
// Task ids are sequence numbers; tool args carry them as strings or ints.
function taskIdStr(v: unknown): string | undefined {
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

// Pull a task id out of a `{ task: {...} }` or `{ task_id: ... }` envelope.
// Used by task_create's summary + Open-link logic to find the new id on the
// output side (input has no id at create time).
function pickTaskId(out: Record<string, unknown> | null): string | undefined {
  if (!out) return undefined;
  const task = out.task;
  if (isObj(task)) {
    const id = taskIdStr(task.id);
    if (id) return id;
  }
  return taskIdStr(out.task_id) ?? taskIdStr(out.id);
}

// Task id for a task tool's "Open" deep link. Input-side for tools
// that take an explicit id; output-side for task_create (id is in the
// returned task envelope and only appears once the call resolves).
function resolveTaskId(
  name: string,
  input: unknown,
  output: unknown
): string | null {
  if (name === "task_create") {
    return pickTaskId(parseJsonish(output)) ?? null;
  }
  if (!isObj(input)) return null;
  return taskIdStr(input.task_id) ?? taskIdStr(input.id) ?? null;
}

function countResults(out: Record<string, unknown> | null): number | null {
  if (!out) return null;
  const candidates = [out.results, out.matches, out.hits, out.items, out.tasks];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c.length;
  }
  // Some providers (e.g. Exa unauthenticated) return results as an
  // LLM-formatted `content` blob with an empty `results` array — don't
  // mislead with "0 results" when content is present; the count is unknown.
  if (typeof out.content === "string" && out.content.trim().length > 0) {
    return null;
  }
  // Every result key is an empty array → genuinely zero.
  for (const c of candidates) {
    if (Array.isArray(c)) return 0;
  }
  return null;
}
function pickResults(
  out: Record<string, unknown> | null
): { title?: string; url?: string; snippet?: string }[] | null {
  if (!out) return null;
  const arr =
    (Array.isArray(out.results) && out.results) ||
    (Array.isArray(out.matches) && out.matches) ||
    (Array.isArray(out.hits) && out.hits) ||
    (Array.isArray(out.items) && out.items) ||
    null;
  if (!arr) return null;
  return arr.filter(isObj).map((r) => ({
    title: str(r.title) ?? str(r.name),
    url: str(r.url) ?? str(r.link),
    snippet: str(r.snippet) ?? str(r.text) ?? str(r.content),
  }));
}
