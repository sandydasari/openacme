import type { ReactNode } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { cn } from "@/app/lib/utils";

/** The shared chat input — used by the main chat and the ambient Acme panel so
 *  the composer is identical everywhere. Presentational: it calls back, it
 *  doesn't own send/session logic. Attachments are optional slots (the panel
 *  doesn't use them). */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  disabled = false,
  placeholder,
  sendDisabled = false,
  sendLabel,
  textareaRef,
  attachButton,
  attachmentsBar,
  isDragging = false,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  placeholder: string;
  sendDisabled?: boolean;
  /** "Queue message" mid-turn vs "Send message" when idle. */
  sendLabel?: string;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  /** Attach button + hidden file input (main chat only). */
  attachButton?: ReactNode;
  /** Pending-attachment chips row, rendered at the top of the box. */
  attachmentsBar?: ReactNode;
  isDragging?: boolean;
  onDragOver?: React.DragEventHandler<HTMLDivElement>;
  onDragLeave?: React.DragEventHandler<HTMLDivElement>;
  onDrop?: React.DragEventHandler<HTMLDivElement>;
}) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't send mid-IME-composition (Enter commits the candidate).
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };
  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Compose
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          <kbd className="border border-paper-rule px-1 py-px text-ink-soft">Enter</kbd>{" "}
          send ·{" "}
          <kbd className="border border-paper-rule px-1 py-px text-ink-soft">⇧ Enter</kbd>{" "}
          newline
        </span>
      </div>
      <div
        className={cn(
          "border border-paper-rule bg-paper transition-colors focus-within:border-plot-red focus-within:outline focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-plot-red",
          isDragging && "border-plot-red bg-paper-sunk"
        )}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {attachmentsBar}
        <div className="flex items-end gap-2 px-2 py-1.5">
          {attachButton}
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
            enterKeyHint="send"
            className="min-h-[44px] max-h-48 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:outline-none font-sans text-base md:text-sm"
          />
          {isStreaming && onStop && (
            <Button
              size="icon"
              variant="destructive"
              onClick={onStop}
              className="shrink-0"
              aria-label="Stop generating"
            >
              <Square className="size-4 fill-current" />
              <span className="sr-only">Stop</span>
            </Button>
          )}
          <Button
            size="icon"
            onClick={onSend}
            disabled={sendDisabled}
            className="shrink-0"
            aria-label={sendLabel ?? "Send message"}
          >
            <ArrowUp className="size-4" />
            <span className="sr-only">{sendLabel ?? "Send"}</span>
          </Button>
        </div>
      </div>
    </>
  );
}
