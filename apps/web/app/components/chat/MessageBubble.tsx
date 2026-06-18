import { memo, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import type { UIMessage } from "ai";
import {
  highlightSegments,
  type SkillIndexEntry,
} from "@/app/lib/skill-mentions";
import type { MessageMetadata } from "@/app/lib/types";
import { cn } from "@/app/lib/utils";
import { Markdown } from "@/app/components/Markdown";
import { DataAttachmentPreview } from "@/app/components/chat/DataAttachmentPreview";
import { MediaPreview } from "@/app/components/MediaPreview";
import {
  ToolBlock,
  PingUserCallout,
  type ToolPart,
} from "@/app/components/ToolBlock";
import { AgentRef } from "@/app/components/ui/agent-ref";
import { API_BASE } from "@/app/lib/api";
import type { FileLinkTarget } from "@/app/files/useFileLinkResolver";

type Part = UIMessage["parts"][number];

/** Minimal agent shape MessageBubble needs — index.tsx's fuller `Agent`
 *  is structurally assignable. */
export type MessageAgent = {
  id: string;
  name: string;
  model: { model: string };
};

type SkillRefData = {
  names?: string[];
  modelContent?: string;
};

/** User text with `/skill` tokens rendered as highlighted, navigable pills —
 *  same treatment as the composer input (bg-plot-red/10 + text-plot-red).
 *  Hover shows the skill description; click opens the Skills page. */
function SkillHighlightedText({
  text,
  names,
  skills,
}: {
  text: string;
  names: Set<string>;
  skills?: SkillIndexEntry[];
}) {
  const segments = highlightSegments(text, names);
  const descOf = (token: string) =>
    skills?.find((s) => s.name === token.replace(/^\//, ""))?.description;
  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
      {segments.map((seg, i) =>
        seg.isSkill ? (
          <Link
            key={i}
            to="/skills"
            title={descOf(seg.text) ?? `Skill ${seg.text}`}
            className="rounded-[3px] bg-plot-red/10 px-[2px] font-medium text-plot-red transition-colors hover:bg-plot-red/20"
          >
            {seg.text}
          </Link>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </div>
  );
}

function isToolPart(p: Part): boolean {
  return (
    typeof (p as { type?: unknown }).type === "string" &&
    (p as { type: string }).type.startsWith("tool-")
  );
}

function MessageHeader({
  role,
  agentId,
  agentName,
  model,
  streaming,
  createdAt,
}: {
  role: "user" | "assistant";
  /** When set, assistant rows show the agent's name (linked) instead of
   *  the generic "assistant" label. */
  agentId?: string;
  agentName?: string;
  model?: string;
  streaming?: boolean;
  createdAt?: number;
}) {
  const ms = createdAt !== undefined ? createdAt * 1000 : null;
  const rel =
    ms !== null
      ? formatDistanceToNow(ms, { addSuffix: true, includeSeconds: true })
      : null;
  const abs = ms !== null ? new Date(ms).toLocaleString() : undefined;
  return (
    <div className="mb-3 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
      <span
        className={cn(
          "status-dot transition-colors",
          role === "assistant" && streaming
            ? "bg-plot-red pulse-live"
            : role === "assistant"
              ? "bg-ink"
              : "bg-ink-faint"
        )}
        aria-hidden
      />
      {role === "assistant" && agentId ? (
        <AgentRef id={agentId} label={agentName ?? agentId} className="text-ink" />
      ) : (
        <span className={role === "assistant" ? "text-ink" : "text-ink-soft"}>
          {role}
        </span>
      )}
      {model && role === "assistant" && (
        <>
          <span className="text-ink-faint">·</span>
          <span className="normal-case tracking-normal text-ink-soft">
            {model}
          </span>
        </>
      )}
      {streaming && (
        <>
          <span className="text-ink-faint">·</span>
          <span className="text-plot-red">streaming</span>
        </>
      )}
      {rel && (
        <>
          <span className="text-ink-faint">·</span>
          <span
            className="normal-case tracking-normal text-ink-faint"
            title={abs}
          >
            {rel}
          </span>
        </>
      )}
    </div>
  );
}

// Paced text reveal for the streaming tail (hermes-style "smooth drain").
// Providers emit multi-word deltas at irregular intervals; rendering them
// verbatim makes text land in visible jumps. Instead, reveal buffered text
// at a bounded rate per frame: a floor rate when the backlog is small, a
// proportional rate so bursts drain within ~DRAIN_WINDOW_MS, and a snap
// for huge backlogs (late-join catch-up) so we never type out megabytes.
const MIN_CHARS_PER_MS = 0.08;
const DRAIN_WINDOW_MS = 350;
const SNAP_BACKLOG_CHARS = 3000;

function useSmoothText(text: string, enabled: boolean): string {
  const progress = useRef(enabled ? 0 : Number.POSITIVE_INFINITY);
  const [, force] = useState(0);
  const animating =
    progress.current !== Number.POSITIVE_INFINITY &&
    progress.current < text.length;
  useEffect(() => {
    if (!animating) return;
    if (text.length - progress.current > SNAP_BACKLOG_CHARS) {
      progress.current = text.length - SNAP_BACKLOG_CHARS;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const backlog = text.length - progress.current;
      const rate = Math.max(MIN_CHARS_PER_MS, backlog / DRAIN_WINDOW_MS);
      progress.current = Math.min(text.length, progress.current + dt * rate);
      force((n) => n + 1);
      if (progress.current < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, animating]);
  if (!animating) return text;
  return text.slice(0, Math.floor(progress.current));
}

function StreamingText({
  text,
  active,
  fileLinks,
  onOpenFile,
}: {
  text: string;
  /** True only for the streaming message's last text part. */
  active: boolean;
  fileLinks?: Map<string, FileLinkTarget>;
  onOpenFile?: (target: FileLinkTarget) => void;
}) {
  const shown = useSmoothText(text, active);
  return (
    <>
      <Markdown fileLinks={fileLinks} onOpenFile={onOpenFile}>
        {shown}
      </Markdown>
      {(active || shown.length < text.length) && (
        <span className="cursor-stream" aria-hidden />
      )}
    </>
  );
}

// Memoized: `upsertById` in useLiveSession preserves identity for untouched
// messages, so streaming chunks only re-render the one message they touch.
export const MessageBubble = memo(function MessageBubble({
  message,
  agent,
  isStreaming,
  pingAnswered = false,
  fileLinks,
  onOpenFile,
  skills,
}: {
  message: UIMessage;
  agent?: MessageAgent;
  isStreaming: boolean;
  /** A user message exists after this one — pings are no longer urgent. */
  pingAnswered?: boolean;
  fileLinks?: Map<string, FileLinkTarget>;
  onOpenFile?: (target: FileLinkTarget) => void;
  /** Skill index — lets `/name` tokens render as highlighted, navigable refs. */
  skills?: SkillIndexEntry[];
}) {
  if (message.role === "system") return null;

  // Hide autonomous-event scaffolding messages — internal scheduler signals,
  // not human conversation. The agent's response that follows renders standalone.
  const meta = (message as { metadata?: MessageMetadata }).metadata;
  if (meta?.kind === "autonomous_event") return null;

  if (message.role === "user") {
    const text = message.parts
      .filter(
        (p): p is Extract<Part, { type: "text" }> =>
          (p as { type?: unknown }).type === "text"
      )
      .map((p) => (p as { text: string }).text)
      .join("\n");
    const files = message.parts.filter(
      (p): p is Extract<Part, { type: "file" }> =>
        (p as { type?: unknown }).type === "file"
    );
    const images = files.filter((f) =>
      (f as { mediaType: string }).mediaType.startsWith("image/")
    );
    const pdfs = files.filter(
      (f) => (f as { mediaType: string }).mediaType === "application/pdf"
    );
    const others = files.filter((f) => {
      const mt = (f as { mediaType: string }).mediaType;
      return !mt.startsWith("image/") && mt !== "application/pdf";
    });
    // The ambient Acme panel attaches the live view as a hidden data part that
    // never renders here (it IS materialized into the model input server-side).
    // Per product decision the page-context carries silently — no chip.
    const skillRef = message.parts.find(
      (p) => (p as { type?: unknown }).type === "data-skill-ref"
    ) as { data?: SkillRefData } | undefined;
    const skillNames = new Set(skillRef?.data?.names ?? []);
    return (
      <section className="section-enter border-t border-paper-rule py-5 first:border-t-0 first:pt-0">
        <MessageHeader
          role="user"
          createdAt={(message as { createdAt?: number }).createdAt}
        />
        {text &&
          (skillNames.size > 0 ? (
            // Skill refs render inline as highlighted pills — no separate chip.
            <SkillHighlightedText
              text={text}
              names={skillNames}
              skills={skills}
            />
          ) : (
            <div className="text-sm leading-relaxed text-ink break-words">
              <Markdown>{text}</Markdown>
            </div>
          ))}
        {images.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {images.map((f, i) => {
              const part = f as unknown as { url: string; filename?: string };
              return (
                <a
                  key={i}
                  href={`${API_BASE}${part.url}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden border border-paper-rule bg-paper-sunk transition-colors hover:border-plot-red"
                >
                  <img
                    src={`${API_BASE}${part.url}`}
                    alt={part.filename ?? "attachment"}
                    className="max-h-64 max-w-full object-contain md:max-w-sm"
                  />
                </a>
              );
            })}
          </div>
        )}
        {pdfs.length > 0 && (
          <div className="mt-3 space-y-3">
            {pdfs.map((f, i) => {
              const part = f as unknown as {
                url: string;
                mediaType: string;
                filename?: string;
              };
              return (
                <MediaPreview
                  key={i}
                  url={`${API_BASE}${part.url}`}
                  mediaType={part.mediaType}
                />
              );
            })}
          </div>
        )}
        {others.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {others.map((f, i) => {
              const part = f as unknown as {
                url: string;
                mediaType: string;
                filename?: string;
              };
              return (
                <DataAttachmentPreview
                  key={i}
                  url={part.url}
                  mediaType={part.mediaType}
                  filename={part.filename ?? "file"}
                />
              );
            })}
          </div>
        )}
      </section>
    );
  }

  // assistant — render parts in order, except ping_user calls which hoist to a
  // callout at the bottom (inline, the ping gets buried under post-ping narration).
  const parts = message.parts;
  const pingParts = parts.filter(
    (p) => isToolPart(p) && (p as { type: string }).type === "tool-ping_user"
  );
  const modelLabel = agent ? agent.model.model : undefined;
  const lastTextIdx = (() => {
    for (let i = parts.length - 1; i >= 0; i--) {
      if ((parts[i] as { type?: unknown }).type === "text") return i;
    }
    return -1;
  })();

  return (
    <section className="section-enter border-t border-paper-rule py-5 first:border-t-0 first:pt-0">
      <MessageHeader
        role="assistant"
        agentId={agent?.id}
        agentName={agent?.name}
        model={modelLabel}
        streaming={isStreaming}
        createdAt={(message as { createdAt?: number }).createdAt}
      />
      {parts.length === 0 && isStreaming && (
        <div className="flex items-center gap-1.5 text-ink-faint">
          <span className="status-dot bg-current pulse-live" aria-hidden />
          <span className="font-mono text-[11px] uppercase tracking-[0.08em]">
            Thinking
          </span>
        </div>
      )}
      <div className="space-y-3">
        {parts.map((part, i) => {
          if (isToolPart(part)) {
            const tp = part as unknown as {
              type: string;
              toolCallId: string;
              state: string;
              input?: unknown;
              output?: unknown;
              errorText?: string;
            };
            if (tp.type === "tool-ping_user") return null;
            return <ToolBlock key={i} part={tp} />;
          }
          if ((part as { type?: unknown }).type === "text") {
            const text = (part as { text: string }).text;
            if (!text) return null;
            return (
              <div key={i} className="text-sm leading-relaxed text-ink break-words">
                <StreamingText
                  text={text}
                  active={isStreaming && i === lastTextIdx}
                  fileLinks={fileLinks}
                  onOpenFile={onOpenFile}
                />
              </div>
            );
          }
          if ((part as { type?: unknown }).type === "data-upstream-error") {
            const d = (part as {
              data: { provider?: string; statusCode?: number; message: string };
            }).data;
            return (
              <div key={i} className="border border-destructive bg-paper-sunk p-3">
                <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.08em] text-destructive">
                  <span>Provider error</span>
                  {d.statusCode != null && (
                    <span className="opacity-70">· {d.statusCode}</span>
                  )}
                  {d.provider && <span className="opacity-70">· {d.provider}</span>}
                </div>
                <pre className="mt-2 whitespace-pre-wrap text-[12px] text-ink break-words font-mono">
                  {d.message}
                </pre>
              </div>
            );
          }
          // reasoning / file / source / other data-* — ignored in v1.
          return null;
        })}
        {pingParts.map((part, i) => (
          <PingUserCallout
            key={`ping-${i}`}
            part={part as unknown as ToolPart}
            answered={pingAnswered}
          />
        ))}
      </div>
    </section>
  );
});
