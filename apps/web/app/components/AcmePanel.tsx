import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { X, Plus, SquareArrowOutUpRight } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { useLiveSession } from "@/app/lib/useLiveSession";
import { MessageBubble } from "@/app/components/chat/MessageBubble";
import { ChatComposer } from "@/app/components/chat/ChatComposer";
import { useCurrentView, type CurrentView } from "@/app/lib/CurrentViewContext";
import { useAcmePanel } from "@/app/lib/AcmePanelContext";
import { API_BASE } from "@/app/lib/api";
import type { OpenAcmeUIMessage } from "@/app/lib/types";
import { cn } from "@/app/lib/utils";

interface AcmeAgent {
  id: string;
  name: string;
  model: { provider: string; model: string };
}

/** Resolve `p`, or null after `ms` — so a never-opening SSE (fresh session
 *  subscribed this same tick) can't hang the POST. Mirrors routes/index.tsx. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
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
  const [messages, setMessages] = useState<OpenAcmeUIMessage[]>([]);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const freshRef = useRef<string | null>(null);
  const triedResume = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CurrentView | null>(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

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
  // blank chat every time). The "+" button starts fresh; a page reload
  // resumes the latest again.
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
        setMessages(Array.isArray(msgs) ? msgs : []);
      } catch {
        // best-effort — fall back to a fresh chat
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, acme, sessionId]);

  const live = useLiveSession(
    sessionId || null,
    sessionId ? setMessages : null
  );
  const isStreaming = submitting || live.state === "running";

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, open]);

  const startNew = useCallback(() => {
    setSessionId("");
    setMessages([]);
    setError(null);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !acme) return;
    let sid = sessionId;
    const isNew = !sid;
    if (isNew) {
      sid = crypto.randomUUID();
      freshRef.current = sid;
      setSessionId(sid);
    }
    const v = viewRef.current;
    const parts: OpenAcmeUIMessage["parts"] = [{ type: "text", text }];
    if (v) {
      parts.push({
        type: "data-ui-context",
        data: {
          page: v.page,
          entityType: v.entityType,
          entityId: v.entityId,
          tab: v.tab ?? null,
          modelContent: renderUiContext(v),
        },
      } as OpenAcmeUIMessage["parts"][number]);
    }
    const userMsg: OpenAcmeUIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts,
    };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    setSubmitting(true);
    setError(null);
    try {
      if (isNew) await withTimeout(live.whenConnected(), 2000);
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: acme.id, sessionId: sid, messages: history }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || res.statusText);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [input, acme, sessionId, messages, live]);

  const stop = useCallback(() => {
    if (!sessionId) return;
    void fetch(`${API_BASE}/api/sessions/${sessionId}/active-turn`, {
      method: "DELETE",
    }).catch(() => {});
  }, [sessionId]);

  // Opened from the sidebar's "Ask Acme" trigger or the ⌘⇧K hotkey.
  if (!open) return null;

  return (
    <aside
      className={cn(
        "fixed z-40 flex flex-col bg-paper-sunk border border-ink/15 shadow-2xl",
        // Floats over the page (no app-shift). A distinct surface (paper-sunk
        // + a stronger border + shadow) so it reads as a separate panel, not a
        // continuation of the page behind it. Mobile near-full; desktop a
        // docked floating card on the right.
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
              isStreaming ? "bg-plot-red pulse-live" : "bg-ink"
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
        {messages.length === 0 ? (
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
          messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={m}
              agent={acme ?? undefined}
              isStreaming={
                isStreaming && m.role === "assistant" && i === messages.length - 1
              }
            />
          ))
        )}
        {error && (
          <div role="alert" className="mt-3 border border-destructive bg-paper-sunk px-3 py-2 font-mono text-[12px] text-destructive">
            {error}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t border-paper-rule p-3">
        <ChatComposer
          value={input}
          onChange={setInput}
          onSend={() => void send()}
          onStop={stop}
          isStreaming={isStreaming}
          disabled={!acme}
          placeholder={acme ? `Message ${acme.name}` : "…"}
          sendDisabled={!input.trim() || !acme}
        />
      </div>
    </aside>
  );
}
