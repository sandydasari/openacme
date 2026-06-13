import { Logomark } from "@/components/logo";
import { ScrambleText } from "./ScrambleText";
import { StatusChip, type StatusTone } from "./primitives";

export interface Agent {
  name: string;
  role: string;
  meta: string;
  status: { tone: StatusTone; label: string };
}

export function AgentDossier({ agent }: { agent: Agent }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-1 border-b border-paper-rule py-6 first:border-t sm:grid-cols-[auto_minmax(0,14rem)_1fr_auto] sm:gap-x-8">
      <span className="row-span-2 flex size-12 items-center justify-center border border-paper-rule bg-paper-sunk text-ink sm:row-span-1">
        <Logomark className="size-6" />
      </span>
      <span className="text-lg font-semibold tracking-tight">
        <ScrambleText text={agent.name} />
      </span>
      <span className="col-start-2 text-sm text-ink-soft sm:col-start-3">
        {agent.role}
      </span>
      <span className="col-start-2 mt-1 flex items-center gap-4 sm:col-start-4 sm:mt-0 sm:justify-self-end">
        <span className="hidden font-mono text-[11px] tracking-[0.08em] text-ink-faint uppercase md:inline">
          {agent.meta}
        </span>
        <StatusChip tone={agent.status.tone}>{agent.status.label}</StatusChip>
      </span>
    </div>
  );
}
