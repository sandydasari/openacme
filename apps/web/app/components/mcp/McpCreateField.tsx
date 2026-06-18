import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import type { MCPServerConfigDto } from "./McpManager";

/**
 * MCP config for the new-agent wizard — pre-creation, so it's a controlled
 * local value (no API/status). Same JSON-editor model as McpManager: inherit
 * toggles for the global catalog + a raw JSON editor for the agent's private
 * servers. Validated for real server-side at create time.
 */
export function McpCreateField({
  globalServers,
  servers,
  disabled,
  onServersChange,
  onDisabledChange,
}: {
  globalServers: Record<string, MCPServerConfigDto>;
  servers: Record<string, MCPServerConfigDto>;
  disabled: string[];
  onServersChange: (next: Record<string, MCPServerConfigDto>) => void;
  onDisabledChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const openEditor = () => {
    setText(JSON.stringify({ mcpServers: servers }, null, 2));
    setErr(null);
    setOpen(true);
  };

  const apply = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setErr(`JSON parse error: ${(e as Error).message}`);
      return;
    }
    const obj =
      parsed && typeof parsed === "object" && "mcpServers" in (parsed as object)
        ? (parsed as { mcpServers: unknown }).mcpServers
        : parsed;
    if (!obj || typeof obj !== "object") {
      setErr("Expected an object of { name: config }");
      return;
    }
    onServersChange(obj as Record<string, MCPServerConfigDto>);
    setOpen(false);
  };

  const toggle = (name: string, exclude: boolean) =>
    onDisabledChange(
      exclude ? [...new Set([...disabled, name])] : disabled.filter((n) => n !== name)
    );

  const names = Object.keys(servers).sort();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
          MCP servers
        </span>
        <Button type="button" size="sm" variant="outline" onClick={openEditor}>
          Edit JSON
        </Button>
      </div>

      {Object.keys(globalServers).length > 0 && (
        <div className="border border-paper-rule">
          <div className="border-b border-paper-rule bg-paper-sunk px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Inherited from global
          </div>
          <div className="divide-y divide-paper-rule">
            {Object.keys(globalServers).sort().map((name) => (
              <label key={name} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                <input
                  type="checkbox"
                  checked={!disabled.includes(name)}
                  onChange={(e) => toggle(name, !e.target.checked)}
                />
                <span className="font-mono text-ink">{name}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="border border-paper-rule">
        <div className="border-b border-paper-rule bg-paper-sunk px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Agent-private servers
        </div>
        {names.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-ink-faint">
            None. Use “Edit JSON” to add private servers.
          </div>
        ) : (
          <ul className="divide-y divide-paper-rule">
            {names.map((n) => (
              <li key={n} className="px-3 py-1.5 font-mono text-[12px] text-ink">
                {n}
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl border border-paper-rule bg-paper shadow-xl">
            <div className="border-b border-paper-rule px-4 py-2 font-mono text-[12px] text-ink">
              Edit MCP servers (JSON)
            </div>
            <div className="p-4">
              <p className="mb-2 text-[11px] text-ink-faint">
                Same JSON shape Claude Desktop, Cursor, and Cline use. Validated
                when the agent is created.
              </p>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
                className="h-72 w-full resize-none border border-paper-rule bg-code-surface px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
              />
              {err && (
                <pre className="mt-2 whitespace-pre-wrap border border-destructive bg-paper-sunk px-2 py-1 font-mono text-[11px] text-destructive">
                  {err}
                </pre>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-paper-rule px-4 py-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={apply}>
                Apply
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
