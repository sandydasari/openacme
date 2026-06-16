import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { X, Plus, Paperclip, SquareArrowOutUpRight } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { AttachmentChip } from "@/app/components/AttachmentChip";
import { MessageBubble } from "@/app/components/chat/MessageBubble";
import { ChatComposer } from "@/app/components/chat/ChatComposer";
import { useChatSession } from "@/app/lib/useChatSession";
import { useCurrentView, type CurrentView } from "@/app/lib/CurrentViewContext";
import { useAcmePanel } from "@/app/lib/AcmePanelContext";
import { API_BASE } from "@/app/lib/api";
import { ALLOWED_UPLOAD_MIMES, type OpenAcmeUIMessage } from "@/app/lib/types";
import { cn } from "@/app/lib/utils";

interface AcmeAgent {
  id: string;
  name: string;
  model: { provider: string; model: string };
}

/** Render the live view as the `<ui-context>` block Acme sees. Structured, not
 *  visual — the actual content the user is looking at, capped so a big draft
 *  can't blow up the turn. */
function renderUiContext(view: CurrentView): string {
  const lines: string[] = [
    "<ui-context>",
    "The user is in the OpenAcme web app and summoned you from this view.",
    `Page: ${view.page}${view.tab ? `  ·  Tab: ${view.tab}` : ""}`,
  ];
  if (view.entityType && view.entityId) {
    lines.push(`Focused ${view.entityType}: ${view.entityId}`);
  } else if (view.entityType) {
    lines.push(`On the ${view.entityType} view (nothing specific selected).`);
  }
  if (view.content != null) {
    let json: string;
    try {
      json = JSON.stringify(view.content, null, 2);
    } catch {
      json = String(view.content);
    }
    if (json.length > 8000) json = json.slice(0, 8000) + "\n…[truncated]";
    lines.push("Current content (may include UNSAVED edits):", json);
  }
  lines.push("</ui-context>");
  return lines.join("\n");
}

export function AcmePanel() {
  const navigate = useNavigate();
  const view = useCurrentView();
  const { open, setOpen } = useAcmePanel();
  const [acme, setAcme] = useState<AcmeAgent | null>(null);
  const [sessionId, setSessionId] = useState("");
  const triedResume = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CurrentView | null>(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // Attach the current view as a data-ui-context part on each user message.
  const buildExtraParts = useCallback((): OpenAcmeUIMessage["parts"] => {
    const v = viewRef.current;
    if (!v) return [];
    return [
      {
        type: "data-ui-context",
        data: {
          page: v.page,
          entityType: v.entityType,
          entityId: v.entityId,
          tab: v.tab ?? null,
          modelContent: renderUiContext(v),
        },
      } as OpenAcmeUIMessage["parts"][number],
    ];
  }, []);

  // The same chat engine the main chat uses — send, streaming, attachments,
  // queued mid-turn sends, status board.
  const chat = useChatSession({
    agentId: acme?.id ?? "",
    sessionId,
    setSessionId,
    acceptsAttachments: true,
    buildExtraParts,
  });

  // Resolve the managed Acme agent once the panel is first opened.
  useEffect(() => {
    if (!open || acme) return;
    let cancelled = false;
    void fetch(`${API_BASE}/api/agents`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: (AcmeAgent & { managed?: boolean })[]) => {
        if (cancelled) return;
        const found = list.find((a) => a.managed) ?? list[0] ?? null;
        if (found) setAcme({ id: found.id, name: found.name, model: found.model });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, acme]);

  // Resume the most recent Acme conversation on first open (continue, not a
  // blank chat every time). "+" starts fresh; a reload resumes the latest.
  useEffect(() => {
    if (!open || !acme || sessionId || triedResume.current) return;
    triedResume.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const home = await fetch(`${API_BASE}/api/home`).then((r) =>
          r.ok ? r.json() : null
        );
        if (!home || cancelled) return;
        const all = [
          ...(home.running ?? []),
          ...(home.waiting ?? []),
          ...(home.idle ?? []),
        ] as { sessionId: string; agentId: string; lastActivity: number }[];
        const latest = all
          .filter((s) => s.agentId === acme.id)
          .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
        if (!latest) return;
        const msgs = (await fetch(
          `${API_BASE}/api/sessions/${latest.sessionId}/messages`
        ).then((r) => (r.ok ? r.json() : []))) as OpenAcmeUIMessage[];
        if (cancelled) return;
        setSessionId(latest.sessionId);
        chat.setMessages(Array.isArray(msgs) ? msgs : []);
      } catch {
        // best-effort — fall back to a fresh chat
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, acme, sessionId, chat]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [chat.messages, open]);

  const startNew = useCallback(() => {
    setSessionId("");
    chat.setMessages([]);
  }, [chat]);

  if (!open) return null;

  return (
    <aside
      className={cn(
        "fixed z-40 flex flex-col bg-paper-sunk border border-ink/15 shadow-2xl",
        // Floats over the page (no app-shift). A distinct surface (paper-sunk +
        // a stronger border + shadow) so it reads as a separate panel. Mobile
        // near-full; desktop a docked floating card on the right.
        "inset-x-2 bottom-2 top-2 rounded-lg",
        "md:inset-x-auto md:right-3 md:inset-y-3 md:w-[440px]"
      )}
      role="complementary"
      aria-label="Acme panel"
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-paper-rule px-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "status-dot",
              chat.isStreaming ? "bg-plot-red pulse-live" : "bg-ink"
            )}
            aria-hidden
          />
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
            Acme
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button size="icon" variant="ghost" onClick={startNew} aria-label="New Acme chat" title="New chat">
            <Plus className="size-4" />
          </Button>
          {sessionId && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Open in full chat"
              title="Open in full chat"
              onClick={() => {
                void navigate({ to: "/", search: { session: sessionId } });
                setOpen(false);
              }}
            >
              <SquareArrowOutUpRight className="size-4" />
            </Button>
          )}
          <Button size="icon" variant="ghost" onClick={() => setOpen(false)} aria-label="Close" title="Close (⌘⇧K)">
            <X className="size-4" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {chat.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Ask Acme
            </span>
            <p className="text-sm text-ink-soft">
              {acme
                ? "Set up agents, skills, MCP, or shared context — Acme sees the page you're on and edits in place."
                : "No platform agent found."}
            </p>
          </div>
        ) : (
          chat.messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={m}
              agent={acme ?? undefined}
              isStreaming={
                chat.isStreaming &&
                m.role === "assistant" &&
                i === chat.messages.length - 1
              }
            />
          ))
        )}
        {chat.error && (
          <div role="alert" className="mt-3 border border-destructive bg-paper-sunk px-3 py-2 font-mono text-[12px] text-destructive">
            {chat.error.message}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t border-paper-rule p-3">
        <ChatComposer
          value={chat.input}
          onChange={chat.setInput}
          onSend={() => void chat.send()}
          onStop={() => void chat.stop()}
          isStreaming={chat.isStreaming}
          disabled={!acme}
          placeholder={acme ? `Message ${acme.name}` : "…"}
          sendDisabled={
            (!chat.input.trim() && chat.pendingAttachments.length === 0) ||
            !acme ||
            chat.pendingAttachments.some((p) => p.status === "uploading")
          }
          sendLabel={chat.isStreaming ? "Queue message" : "Send message"}
          textareaRef={chat.inputRef}
          isDragging={chat.isDragging}
          onDragOver={chat.onDragOver}
          onDragLeave={chat.onDragLeave}
          onDrop={chat.onDrop}
          attachmentsBar={
            chat.pendingAttachments.length > 0 ? (
              <div className="flex flex-nowrap gap-1.5 overflow-x-auto border-b border-paper-rule bg-paper-sunk px-3 py-2">
                {chat.pendingAttachments.map((p) => (
                  <AttachmentChip
                    key={p.localId}
                    kind={
                      p.kind ?? (p.mediaType.startsWith("image/") ? "image" : "file")
                    }
                    mediaType={p.mediaType}
                    size={p.size}
                    name={p.filename}
                    status={p.status}
                    error={p.error}
                    removable
                    onRemove={() => chat.removePending(p.localId)}
                  />
                ))}
              </div>
            ) : null
          }
          attachButton={
            <>
              <input
                ref={chat.fileInputRef}
                type="file"
                multiple
                accept={ALLOWED_UPLOAD_MIMES.join(",")}
                className="hidden"
                onChange={(e) => {
                  const files = e.target.files ? Array.from(e.target.files) : [];
                  void chat.uploadFiles(files);
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => chat.fileInputRef.current?.click()}
                disabled={!acme}
                className="shrink-0"
                aria-label="Attach files"
                title="Attach files (images, PDFs)"
              >
                <Paperclip className="size-4" />
              </Button>
            </>
          }
        />
      </div>
    </aside>
  );
}
