import Link from "next/link";
import { Logomark, Wordmark } from "@/components/logo";
import { AgentDossier, type Agent } from "@/components/landing/AgentDossier";
import { CopyCommand } from "@/components/landing/CopyCommand";
import { ImageFrame } from "@/components/landing/ImageFrame";
import { MarqueeRow } from "@/components/landing/MarqueeRow";
import { PixelGrid } from "@/components/landing/PixelGrid";
import { AmbientVideo } from "@/components/landing/AmbientVideo";
import { Reveal } from "@/components/landing/Reveal";
import { Screenshot } from "@/components/landing/Screenshot";
import { StickyShowcase } from "@/components/landing/StickyShowcase";
import { Terminal, type TermLine } from "@/components/landing/Terminal";
import { SectionEyebrow } from "@/components/landing/primitives";

const INSTALL = "npm install -g @openacme/cli && openacme setup";

const CAPABILITIES = [
  "Local-first",
  "BYO-model",
  "MCP-native",
  "Multi-agent",
  "Task scheduler",
  "Per-agent browser",
  "Skills",
  "Memory",
  "Teams",
  "Self-hostable",
  "CLI + Web",
];

const ROSTER: Agent[] = [
  {
    name: "Chief of staff",
    role: "Triages everything addressed to the team — claims, reassigns, or splits the work.",
    meta: "manager · triage",
    status: { tone: "ready", label: "Ready" },
  },
  {
    name: "Research analyst",
    role: "Watches competitors and changelogs, summarizes what changed and why it matters.",
    meta: "claude-sonnet · 3 skills",
    status: { tone: "working", label: "In progress" },
  },
  {
    name: "Writer",
    role: "Drafts replies, release notes, and launch posts in your voice.",
    meta: "gpt-5 · 2 skills",
    status: { tone: "ready", label: "Ready" },
  },
  {
    name: "Engineer",
    role: "Owns implementation, code review, and CI hygiene on your codebase.",
    meta: "claude-opus · 5 skills",
    status: { tone: "waiting", label: "Blocked" },
  },
];

const TERMINAL_LINES: TermLine[] = [
  { kind: "cmd", text: "openacme setup" },
  { kind: "out", text: "✓ Connected: Claude subscription", tone: "ok" },
  { kind: "out", text: "✓ Agent created: iris — Research Analyst", tone: "ok" },
  { kind: "out", text: "Daemon listening on 127.0.0.1:3210", tone: "dim" },
  { kind: "cmd", text: "openacme chat" },
  { kind: "out", text: "iris · ready — type to start, @file to attach", tone: "dim" },
];

const FEATURES = [
  {
    title: "Skills, installable",
    body: "Teach any agent a new capability by installing a skill — from GitHub, marketplaces, or a Markdown file you wrote yourself.",
  },
  {
    title: "Teams with a manager",
    body: "Group agents into teams. Send work to the team and the manager triages it — claims it, reassigns it, or splits it up.",
  },
  {
    title: "A browser per agent",
    body: "Every agent gets its own browser with its own logins and history. One agent's session never leaks into another's.",
  },
  {
    title: "Your subscription works",
    body: "Sign in with your Claude or ChatGPT subscription, or bring API keys for any major provider. Each agent can run a different model.",
  },
];

function Section({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`border-t border-paper-rule ${className}`}>
      <div className="mx-auto w-full max-w-6xl px-6 py-24 sm:py-28">
        {children}
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      {/* HERO */}
      <section className="relative overflow-hidden">
        <PixelGrid />
        <div className="mx-auto w-full max-w-6xl px-6 pt-20 pb-16 sm:pt-28">
          <SectionEyebrow>AI workforce platform</SectionEyebrow>
          <h1 className="mt-6 max-w-3xl text-[clamp(2.5rem,6vw,4.25rem)] leading-[1.05] font-semibold tracking-[-0.02em]">
            An AI workforce.
            <br />
            <span className="text-ink-soft">You&apos;re in charge.</span>
          </h1>
          <p className="mt-8 max-w-xl text-lg leading-relaxed text-ink-soft">
            OpenAcme runs coworkers, not chat tabs — agents with roles, memory,
            and their own tools, working wherever you run it: your laptop or a
            server your whole team shares. Hand them tasks and walk away. They
            report back.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link
              href="/docs/quickstart"
              className="bg-ink px-6 py-3 text-sm font-medium text-paper transition-colors hover:bg-ink-soft focus-scribe"
            >
              Get started
            </Link>
            <Link
              href="/docs"
              className="border border-paper-rule px-6 py-3 text-sm font-medium transition-colors hover:border-ink-faint focus-scribe"
            >
              Read the docs
            </Link>
            <CopyCommand command={INSTALL} />
          </div>
          <Reveal delay={150} className="mt-16">
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
        </div>
      </section>

      {/* CAPABILITY MARQUEE */}
      <MarqueeRow items={CAPABILITIES} />

      {/* ROSTER */}
      <Section>
        <SectionEyebrow>Roster</SectionEyebrow>
        <h2 className="mt-5 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Coworkers, not chat tabs.
        </h2>
        <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-soft">
          Roles you define, names you choose. Every agent carries a persona you
          wrote and its own memory, files, and tools. Add one, retire one,
          change a model — you&apos;re the org chart. It works for one founder
          or a whole team.
        </p>
        <Reveal className="mt-12">
          <div>
            {ROSTER.map((agent) => (
              <AgentDossier key={agent.name} agent={agent} />
            ))}
          </div>
        </Reveal>
      </Section>

      {/* DISPATCH */}
      <Section>
        <SectionEyebrow>Dispatch</SectionEyebrow>
        <h2 className="mt-5 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Assign work and walk away.
        </h2>
        <div className="mt-14">
          <StickyShowcase
            steps={[
              {
                title: "Create a task",
                body: "Write it the way you'd brief a coworker. Assign it to an agent — or to a team, and the manager decides who takes it.",
                visual: (
                  <ImageFrame>
                    <Screenshot
                      name="brief"
                      alt="A task brief, written like you'd brief a coworker"
                    />
                  </ImageFrame>
                ),
              },
              {
                title: "The right coworker wakes up",
                body: "The scheduler brings the assignee to life within the minute. Recurring tasks re-open themselves; dependent tasks wait their turn.",
                visual: (
                  <ImageFrame>
                    <Screenshot
                      name="home"
                      alt="The workforce waking up on its own"
                    />
                  </ImageFrame>
                ),
              },
              {
                title: "The result comes back",
                body: "Results land as comments on the task — with the discussion, the event log, and everything the agent produced along the way.",
                visual: (
                  <ImageFrame>
                    <Screenshot
                      name="result"
                      alt="The result posted as a task comment"
                    />
                  </ImageFrame>
                ),
              },
            ]}
          />
        </div>
      </Section>

      {/* COLLABORATE */}
      <Section>
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
          <div>
            <SectionEyebrow>Collaborate</SectionEyebrow>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
              Chat when you want company. Tasks when you want it done.
            </h2>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-ink-soft">
              Every agent holds a real conversation — files, web, code, tools
              inline. And what they learn sticks: memory persists between
              conversations, so you never re-explain the same thing twice.
            </p>
          </div>
          <Reveal>
            <ImageFrame>
              <Screenshot
                name="chat"
                alt="Chatting with an agent — tools run inline"
              />
            </ImageFrame>
          </Reveal>
        </div>
      </Section>

      {/* CONSOLE */}
      <Section>
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
          <div>
            <SectionEyebrow>Console</SectionEyebrow>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
              The console is also a CLI.
            </h2>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-ink-soft">
              Everything the web does, the terminal does — setup, chat,
              skills, the daemon itself. One binary, running locally. Your
              sessions, tasks, and memories live under{" "}
              <code className="font-mono text-[13px]">~/.openacme</code>,
              yours.
            </p>
          </div>
          <Reveal>
            <Terminal lines={TERMINAL_LINES} />
          </Reveal>
        </div>
      </Section>

      {/* FEATURE GRID */}
      <Section>
        <SectionEyebrow>And the rest</SectionEyebrow>
        <div className="mt-12 grid grid-cols-1 border-t border-l border-paper-rule sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="border-r border-b border-paper-rule p-8 sm:p-10"
            >
              <h3 className="text-lg font-semibold tracking-tight">
                {f.title}
              </h3>
              <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-ink-soft">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* FINAL CTA */}
      <Section className="bg-paper-sunk">
        <div className="flex flex-col items-start gap-8">
          <SectionEyebrow>Start</SectionEyebrow>
          <h2 className="text-[clamp(2rem,5vw,3.25rem)] leading-[1.08] font-semibold tracking-[-0.02em]">
            Hire your first agent.
          </h2>
          <CopyCommand command={INSTALL} />
          <div className="flex flex-wrap items-center gap-4">
            <Link
              href="/docs/quickstart"
              className="bg-ink px-6 py-3 text-sm font-medium text-paper transition-colors hover:bg-ink-soft focus-scribe"
            >
              Get started
            </Link>
            <Link
              href="/docs"
              className="border border-paper-rule px-6 py-3 text-sm font-medium transition-colors hover:border-ink-faint focus-scribe"
            >
              Read the docs
            </Link>
          </div>
          <p className="font-mono text-[11px] tracking-[0.12em] text-ink-faint uppercase">
            <span className="mr-2 inline-block size-1.5 translate-y-px bg-signal-green" />
            Your laptop or your server · your data stays yours
          </p>
        </div>
      </Section>

      {/* FOOTER */}
      <footer className="border-t border-paper-rule">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-14 sm:grid-cols-3">
          <div className="flex flex-col gap-4">
            <span className="inline-flex items-center gap-3 text-ink">
              <Logomark className="size-6" />
              <Wordmark className="h-3.5 w-auto" />
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
              href="https://www.npmjs.com/package/@openacme/cli"
              className="text-ink-soft hover:text-ink"
            >
              npm
            </a>
            <span className="text-ink-faint">MIT License</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
