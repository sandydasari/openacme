import Link from "next/link";
import { Logomark, Wordmark } from "@/components/logo";
import { AmbientVideo } from "@/components/landing/AmbientVideo";
import {
  BentoCell,
  BentoGrid,
  BrowserPairDemo,
  McpDemo,
  MemoryDemo,
  ModelCycler,
  ScheduleDemo,
  SkillsDemo,
  TeamRouteDemo,
} from "@/components/landing/BentoDemos";
import { CopyCommand } from "@/components/landing/CopyCommand";
import { DispatchBoard } from "@/components/landing/DispatchBoard";
import { ImageFrame } from "@/components/landing/ImageFrame";
import { IndexMarquee, type IndexItem } from "@/components/landing/MarqueeRow";
import { PixelBlast } from "@/components/landing/PixelBlast";
import { Reveal } from "@/components/landing/Reveal";
import { RiseWords } from "@/components/landing/RiseWords";
import { RosterPanel } from "@/components/landing/RosterPanel";
import { Crosshair, Section } from "@/components/landing/Section";
import { Terminal, type TermLine } from "@/components/landing/Terminal";
import { WorkforceMonitor } from "@/components/landing/WorkforceMonitor";

const INSTALL_CURL = "curl -fsSL https://openacme.pages.dev/install.sh | sh";
const INSTALL_NPM = "npm install -g @openacme/cli && openacme setup";

function InstallCommands() {
  return (
    <div className="flex flex-col gap-2">
      <CopyCommand command={INSTALL_CURL} />
      <CopyCommand command={INSTALL_NPM} />
    </div>
  );
}

const INDEX: IndexItem[] = [
  { n: "01", label: "Roster", href: "#roster", tone: "blue" },
  { n: "02", label: "Dispatch", href: "#dispatch", tone: "amber" },
  { n: "03.1", label: "Memory", href: "#capabilities", tone: "violet" },
  { n: "03.2", label: "Skills", href: "#capabilities", tone: "green" },
  { n: "03.3", label: "Any model", href: "#capabilities", tone: "red" },
  { n: "03.4", label: "Teams", href: "#capabilities", tone: "blue" },
  {
    n: "03.5",
    label: "Browser per agent",
    href: "#capabilities",
    tone: "amber",
  },
  { n: "03.6", label: "Schedules", href: "#capabilities", tone: "green" },
  { n: "03.7", label: "MCP", href: "#capabilities", tone: "violet" },
  { n: "04", label: "CLI", href: "#console", tone: "green" },
  { n: "05", label: "Self-host", href: "#deployment", tone: "violet" },
  { n: "06", label: "Install", href: "#start", tone: "red" },
];

const TERMINAL_LINES: TermLine[] = [
  { kind: "cmd", text: "openacme setup" },
  { kind: "out", text: "✓ Signed in — Claude subscription", tone: "ok" },
  { kind: "out", text: "✓ Config saved — ~/.openacme", tone: "ok" },
  { kind: "cmd", text: "openacme start" },
  { kind: "out", text: "✓ Daemon up — 127.0.0.1:3456", tone: "ok" },
  { kind: "out", text: "" },
  { kind: "cmd", text: "openacme chat" },
  {
    kind: "out",
    text: "analyst · ready — type to start, @file to attach",
    tone: "dim",
  },
  {
    kind: "cmd",
    prompt: ">",
    text: "what changed in competitor pricing this week?",
  },
  { kind: "out", text: "web_search · browser · memory", tone: "dim" },
  { kind: "out", text: "Three plans changed since monday. Full brief posted" },
  { kind: "out", text: "to task #14 — sources linked in the comment." },
];

const CLI_GROUPS = [
  ["setup", "connect a provider and sign in"],
  ["chat", "terminal chat, no server needed"],
  ["skills", "install, write, audit"],
  ["mcp", "wire up any MCP server"],
  ["memory", "inspect what an agent knows"],
  ["start · stop · logs", "the daemon itself"],
] as const;

const DEPLOY = [
  {
    label: "Your laptop",
    body: "npm install, sign in, done. Everything lives in ~/.openacme — plain Markdown and SQLite you can open, read, and back up.",
  },
  {
    label: "A shared server",
    body: "Start the daemon with --expose and your whole team works with the same workforce — one URL, secret-gated, always on.",
  },
  {
    label: "No platform between",
    body: "There is no OpenAcme cloud. Your prompts and data go to the model provider you chose and nowhere else.",
  },
];

const SPECS: [string, string][] = [
  ["Runtime", "Node 18+ · macOS or Linux"],
  ["Interfaces", "Web console · CLI · headless daemon"],
  ["Models", "Anthropic · OpenAI · Google · OpenRouter · Ollama · custom"],
  ["Auth", "Claude / ChatGPT subscription, or API keys"],
  ["Storage", "Plain files + SQLite under ~/.openacme"],
  ["Network", "Loopback by default · --expose to share"],
  ["Telemetry", "None"],
  ["License", "MIT, open source"],
  ["Price", "Free — you pay only your model provider"],
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col overflow-x-clip">
      <div className="relative mx-auto w-full max-w-6xl border-x border-paper-rule">
        {/* HERO */}
        <section className="relative overflow-hidden">
          <PixelBlast />
          <div className="grid gap-12 px-6 pt-16 pb-14 sm:px-10 sm:pt-20 lg:grid-cols-12 lg:gap-10">
            <div className="flex min-w-0 flex-col justify-center lg:col-span-6">
              <p className="flex items-center gap-3 font-mono text-[12px] leading-none tracking-[0.2em] text-plot-red uppercase">
                <span className="inline-block size-1.5 bg-plot-red" />
                AI workforce platform — open source
              </p>
              <h1 className="mt-6 text-[clamp(2.5rem,5vw,3.6rem)] leading-[1.04] font-semibold tracking-[-0.02em]">
                <RiseWords text="An AI workforce." />
                <br />
                <RiseWords
                  text="You're in charge."
                  delay={260}
                  className="text-ink-soft"
                />
              </h1>
              <p className="mt-6 max-w-lg text-[17px] leading-relaxed text-ink-soft">
                OpenAcme runs coworkers, not chat tabs — agents with roles,
                memory, and their own tools. Hand them work; they report back.
                On your laptop, or a server your whole team shares.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/docs/quickstart"
                  className="bg-ink px-6 py-3 text-sm font-medium text-paper transition-colors hover:bg-ink-soft focus-scribe"
                >
                  Get started
                </Link>
                <Link
                  href="/docs"
                  className="border border-paper-rule bg-paper px-6 py-3 text-sm font-medium transition-colors hover:border-ink-faint focus-scribe"
                >
                  Read the docs
                </Link>
              </div>
              <div className="mt-4">
                <InstallCommands />
              </div>
            </div>
            <div className="flex min-w-0 items-center lg:col-span-6">
              <Reveal className="w-full" delay={120}>
                <WorkforceMonitor className="w-full" />
              </Reveal>
            </div>
          </div>
          <Reveal className="px-6 pb-16 sm:px-10 sm:pb-20" delay={200}>
            <ImageFrame>
              <AmbientVideo
                mp4="/media/demo.mp4"
                webm="/media/demo.webm"
                poster="/media/demo-poster.avif"
                width={2304}
                height={1440}
              />
            </ImageFrame>
          </Reveal>
        </section>

        {/* PAGE INDEX */}
        <div className="relative">
          <Crosshair className="-top-[4.5px] -left-[4.5px]" />
          <Crosshair className="-top-[4.5px] -right-[4.5px]" />
          <IndexMarquee items={INDEX} />
        </div>

        {/* 01 — ROSTER */}
        <Section
          id="roster"
          tone="blue"
          index="01"
          label="Roster"
          title="Coworkers, not chat tabs."
          lede="Every agent is a file you can read: a role, a persona, a model, tools, skills. Add one, retire one, swap a model — you're the org chart."
        >
          <Reveal>
            <RosterPanel />
          </Reveal>
        </Section>

        {/* 02 — DISPATCH */}
        <Section
          id="dispatch"
          tone="amber"
          index="02"
          label="Dispatch"
          title="Assign work and walk away."
          lede="Tasks live on a shared board. The dispatcher wakes the right agent within the minute, and the result lands back on the task — with the full event log."
        >
          <Reveal>
            <DispatchBoard />
          </Reveal>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {[
              [
                "1",
                "Brief it like a coworker — a title and what done looks like.",
              ],
              [
                "2",
                "Recurring tasks re-open themselves. Dependent tasks wait their turn.",
              ],
              [
                "3",
                "Results come back as comments. Read them when you're back.",
              ],
            ].map(([n, t]) => (
              <p
                key={n}
                className="flex gap-3 text-[13.5px] leading-relaxed text-ink-soft"
              >
                <span className="font-mono text-[12px] text-plot-red">{n}</span>
                {t}
              </p>
            ))}
          </div>
        </Section>

        {/* 03 — CAPABILITIES BENTO */}
        <Section
          id="capabilities"
          index="03"
          label="Capabilities"
          title="Everything a coworker needs."
          lede="Not a chat window with plugins. Each agent carries its own working setup — isolated from the rest of the roster."
          flush
        >
          <Reveal>
            <BentoGrid
              count={7}
              className="-mx-6 grid border-t border-paper-rule sm:-mx-10 sm:grid-cols-2 lg:grid-cols-12"
            >
              <BentoCell
                order={0}
                index="03.1"
                tone="violet"
                label="Memory"
                title="What they learn, sticks"
                body="Corrections, preferences, context — saved to a Markdown file per agent, carried into every future session."
                className="lg:col-span-6"
              >
                <MemoryDemo />
              </BentoCell>
              <BentoCell
                order={1}
                index="03.2"
                tone="green"
                label="Skills"
                title="Teachable in Markdown"
                body="Install capabilities from GitHub and marketplaces, or write your own."
                className="lg:col-span-3"
              >
                <SkillsDemo />
              </BentoCell>
              <BentoCell
                order={2}
                index="03.3"
                tone="red"
                label="Models"
                title="Any model, per agent"
                body="Mix providers across the roster. Local models work too."
                className="lg:col-span-3 sm:border-r-0"
              >
                <ModelCycler />
              </BentoCell>
              <BentoCell
                order={3}
                index="03.4"
                tone="blue"
                label="Teams"
                title="A manager triages"
                body="Send work to the team — the manager claims, reassigns, or splits it."
                className="lg:col-span-3 lg:border-b-0"
              >
                <TeamRouteDemo />
              </BentoCell>
              <BentoCell
                order={4}
                index="03.5"
                tone="amber"
                label="Browser"
                title="A browser per agent"
                body="Own logins, own cookies. One agent's session never leaks into another's."
                className="lg:col-span-3 lg:border-b-0"
              >
                <BrowserPairDemo />
              </BentoCell>
              <BentoCell
                order={5}
                index="03.6"
                tone="green"
                label="Schedule"
                title="Work that recurs"
                body="Daily, weekly, custom — finished recurring tasks re-open themselves."
                className="lg:col-span-3 lg:border-b-0"
              >
                <ScheduleDemo />
              </BentoCell>
              <BentoCell
                order={6}
                index="03.7"
                tone="violet"
                label="MCP"
                title="Plugs into MCP"
                body="Every MCP server's tools, namespaced per agent or shared."
                className="border-b-0 sm:border-r-0 lg:col-span-3"
              >
                <McpDemo />
              </BentoCell>
            </BentoGrid>
          </Reveal>
        </Section>

        {/* 04 — CONSOLE */}
        <Section
          id="console"
          tone="green"
          index="04"
          label="Console"
          title="The whole thing is also a CLI."
          lede={
            <>
              Everything the web console does, the terminal does — and your data
              stays in{" "}
              <code className="font-mono text-[13px]">~/.openacme</code>,
              readable without us.
            </>
          }
        >
          <div className="grid gap-10 lg:grid-cols-12 lg:gap-10">
            <div className="flex flex-col justify-center lg:col-span-5">
              <div className="border-t border-paper-rule">
                {CLI_GROUPS.map(([cmd, desc]) => (
                  <div
                    key={cmd}
                    className="flex items-baseline justify-between gap-4 border-b border-paper-rule py-3"
                  >
                    <code className="shrink-0 font-mono text-[13px] text-ink">
                      openacme {cmd}
                    </code>
                    <span className="truncate text-[13px] text-ink-faint">
                      {desc}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <Reveal className="lg:col-span-7">
              <Terminal lines={TERMINAL_LINES} />
            </Reveal>
          </div>
        </Section>

        {/* 05 — DEPLOY + SPECS */}
        <Section
          id="deployment"
          tone="violet"
          index="05"
          label="Deployment"
          title="Runs where you work."
          lede="One binary: daemon, web console, and CLI. It scales from a side project to a team's shared workforce without changing shape."
        >
          <div className="grid border border-paper-rule sm:grid-cols-3">
            {DEPLOY.map((d, i) => (
              <div
                key={d.label}
                className={`p-6 sm:p-7 ${i > 0 ? "border-t border-paper-rule sm:border-t-0 sm:border-l" : ""}`}
              >
                <p className="font-mono text-[11px] tracking-[0.16em] text-ink-faint uppercase">
                  <span className="mr-2.5 text-plot-red">{`0${i + 1}`}</span>
                  {d.label}
                </p>
                <p className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">
                  {d.body}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-14">
            <p className="font-mono text-[11px] tracking-[0.18em] text-ink-faint uppercase">
              Specifications
            </p>
            <dl className="mt-5 grid border-t border-paper-rule lg:grid-cols-2 lg:gap-x-12">
              {SPECS.map(([k, v]) => (
                <div
                  key={k}
                  className="grid grid-cols-[120px_1fr] gap-4 border-b border-paper-rule py-3 sm:grid-cols-[150px_1fr]"
                >
                  <dt className="font-mono text-[11px] leading-[1.9] tracking-[0.12em] text-ink-faint uppercase">
                    {k}
                  </dt>
                  <dd className="text-[13.5px] leading-relaxed text-ink">
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Section>

        {/* 06 — START: inverted band, framed like everything else. The
            top rule is one of the page's two full-width lines. */}
        <section
          id="start"
          className="relative scroll-mt-14 overflow-hidden border-t border-paper-rule bg-ink text-paper"
        >
          <span
            aria-hidden
            className="absolute top-0 left-1/2 w-screen -translate-x-1/2 border-t border-paper-rule"
          />
          <Crosshair className="-top-[4.5px] -left-[4.5px]" />
          <Crosshair className="-top-[4.5px] -right-[4.5px]" />
          <div className="absolute inset-0 z-0">
            <PixelBlast
              className="text-paper-rule"
              mask="linear-gradient(295deg, transparent 35%, black 88%)"
            />
          </div>
          <div className="relative z-10 px-6 py-16 sm:px-10 sm:py-20">
            <p className="flex items-center gap-3 font-mono text-[12px] leading-none tracking-[0.18em] uppercase">
              <span className="inline-block size-2 bg-plot-red" />
              <span className="text-plot-red">06</span>
              <span className="text-paper/50">Start</span>
            </p>
            <h2 className="mt-4 text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.015em]">
              Hire your first agent.
            </h2>
            <div className="mt-10 flex flex-col items-start gap-6">
              <InstallCommands />
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href="/docs/quickstart"
                  className="bg-paper px-6 py-3 text-sm font-medium text-ink transition-colors hover:bg-paper-sunk focus-scribe"
                >
                  Get started
                </Link>
                <Link
                  href="/docs"
                  className="border border-paper/30 px-6 py-3 text-sm font-medium text-paper transition-colors hover:border-paper/60 focus-scribe"
                >
                  Read the docs
                </Link>
              </div>
              <p className="font-mono text-[11px] tracking-[0.12em] text-paper/50 uppercase">
                <span className="mr-2 inline-block size-1.5 translate-y-px bg-signal-green" />
                Your laptop or your server · your data stays yours
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* FOOTER — its top rule is the second full-width line. */}
      <footer className="border-t border-paper-rule">
        <div className="mx-auto w-full max-w-6xl border-x border-paper-rule">
          <div className="grid gap-10 px-6 py-14 sm:grid-cols-3 sm:px-10">
            <div className="flex flex-col gap-4">
              <span className="inline-flex items-center gap-3 text-ink">
                <Logomark className="size-6" />
              </span>
              <p className="font-mono text-[10px] tracking-[0.14em] text-ink-faint uppercase">
                An AI workforce. You&apos;re in charge.
              </p>
            </div>
            <div className="flex flex-col gap-2 text-sm">
              <span className="label-faceplate mb-2">Product</span>
              <Link href="/docs" className="text-ink-soft hover:text-ink">
                Documentation
              </Link>
              <Link
                href="/docs/quickstart"
                className="text-ink-soft hover:text-ink"
              >
                Quickstart
              </Link>
              <Link href="/docs/cli" className="text-ink-soft hover:text-ink">
                CLI reference
              </Link>
            </div>
            <div className="flex flex-col gap-2 text-sm">
              <span className="label-faceplate mb-2">Project</span>
              <a
                href="https://github.com/sandydasari/openacme"
                className="text-ink-soft hover:text-ink"
              >
                GitHub
              </a>
              <a
                href="https://www.npmjs.com/package/@openacme/cli"
                className="text-ink-soft hover:text-ink"
              >
                npm
              </a>
              <span className="text-ink-faint">MIT License</span>
            </div>
          </div>
          <div className="overflow-hidden border-t border-paper-rule px-6 pt-10 sm:px-10">
            <Wordmark className="h-auto w-full translate-y-[18%] text-ink" />
          </div>
        </div>
      </footer>
    </main>
  );
}
