---
name: OpenAcme
description: The operator's console for an organization whose workforce is agents.
colors:
  paper: "oklch(99.4% 0.0015 75)"
  paper-sunk: "oklch(95.5% 0.003 75)"
  paper-rule: "oklch(87% 0.003 75)"
  ink: "oklch(22% 0.008 280)"
  ink-soft: "oklch(45% 0.005 280)"
  ink-faint: "oklch(62% 0.005 280)"
  graphite: "oklch(16% 0.006 280)"
  graphite-raised: "oklch(20% 0.006 280)"
  graphite-rule: "oklch(28% 0.006 280)"
  bone: "oklch(94% 0.004 75)"
  bone-soft: "oklch(75% 0.005 75)"
  bone-faint: "oklch(58% 0.005 280)"
  plot-red: "oklch(58% 0.18 28)"
  plot-red-deep: "oklch(48% 0.18 28)"
  signal-amber: "oklch(78% 0.14 75)"
  signal-blue: "oklch(60% 0.15 250)"
  signal-green: "oklch(60% 0.13 150)"
  warn-ochre: "oklch(72% 0.14 75)"
  destructive: "oklch(54% 0.22 28)"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.75rem, 3vw, 2.5rem)"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
  label:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.08em"
  meta:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0"
rounded:
  none: "0px"
  hair: "1px"
  control: "2px"
spacing:
  hair: "1px"
  "0.5": "2px"
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
  "8": "32px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.paper}"
  button-ghost:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
  button-ghost-hover:
    backgroundColor: "{colors.paper-sunk}"
    textColor: "{colors.ink}"
  button-signal:
    backgroundColor: "{colors.plot-red}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
  input-default:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
  input-focus:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "16px"
  panel-sunk:
    backgroundColor: "{colors.paper-sunk}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "16px"
  chip-id:
    backgroundColor: "{colors.paper-sunk}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.none}"
    padding: "2px 6px"
  chip-live:
    backgroundColor: "{colors.plot-red}"
    textColor: "{colors.paper}"
    rounded: "{rounded.none}"
    padding: "2px 6px"
---

# Design System: OpenAcme

## 1. Overview

**Creative North Star: "The Operator's Console"**

The interface is a control surface for an agent workforce, not a chat app. It looks like an instrument: warmed-paper light mode, graphite dark mode, hairline rules instead of cards, a single accent (plot red) used only when something is *active* or *destined for the user's attention*. The page reads like a lab notebook left open next to a terminal — quiet, dense with real metadata, and unambiguous about what's running. Density is the trust signal. Whitespace is reserved for separating *real* sections, not for "breathing room" around single sentences.

The system rejects four currently-saturated AI-product looks: SaaS-dashboard KPI tiles with sky-blue gradients; ChatGPT-style centered chat with pastel illustrations; AI-startup neon and glassmorphism; and cute consumer-app rounding-and-mascots. None of those are wrong; none are this. The user is operating; we render an instrument.

The visual chassis is brutalist (sharp 0px corners, no shadows, hairline 1px rules) but the temperature is warm — paper-bone in light, slightly-blue-graphite in dark — and the type pairing is single-family Geist Sans + Geist Mono with differentiation done through *case*, *weight*, and *tracking*. Lab instruments don't pair fonts; they use one face at multiple sizes on the same panel, and that's the discipline here.

**Key Characteristics:**
- Sharp corners everywhere (0px). One radius across chrome and controls. No exceptions.
- Flat, never elevated. Depth via tonal layering (3-4% lightness step between page → section → input) and 1px hairline rules.
- Plot-red accent (≤10% of pixels) reserved for live state, focus, and the operator's selection. It is never decorative.
- Single-family typography: Geist Sans for prose, Geist Mono for IDs, timestamps, status, and numerical readouts.
- Mono metadata is always-visible, not hidden behind hover. Identifiers, durations, counts, model names live next to their labels.
- Motion is restrained: state-change transitions, plus a 1.2s ease pulse on plot-red for "live signal." No choreography.

## 2. Colors

The palette is two surface families (warmed paper for light, cool graphite for dark) plus four signal colors, each pinned to one orthogonal semantic role. Plot Red carries the system; the other three are narrow but allowed at rest in their assigned role.

### Primary (Accent)
- **Plot Red** (`oklch(58% 0.18 28)`): the only chromatic color used at any meaningful coverage. It marks the *active* — the agent currently streaming, the focused control, the selected session, the live indicator. Borrowed visually from plotter pens and mechanical-instrument signal lights, not from "brand red." Reserved for state and focus, never for decoration or category.
- **Plot Red Deep** (`oklch(48% 0.18 28)`): hover/active depression of Plot Red. Same hue, lower lightness. Used on accent buttons only.

### Neutral (Light Mode — "Paper")
- **Paper** (`oklch(99.4% 0.0015 75)`): page background. Near-white with trace warmth — reads as white on screen, but still not pure `#fff`, so it never goes Material-flat.
- **Paper Sunk** (`oklch(96% 0.005 75)`): inset surfaces — sidebar, command palette, code blocks, chips. One tonal step below page.
- **Paper Rule** (`oklch(88% 0.005 75)`): hairline borders and dividers. Single 1px stroke; never doubled, never thickened.
- **Ink** (`oklch(22% 0.008 280)`): primary text. Near-black with a minimal cool tint so it doesn't fight the warm paper.
- **Ink Soft** (`oklch(45% 0.005 280)`): secondary text, metadata.
- **Ink Faint** (`oklch(62% 0.005 280)`): tertiary text, placeholder, disabled.

### Neutral (Dark Mode — "Graphite")
- **Graphite** (`oklch(16% 0.006 280)`): page background. Slight cool tint, never pure black.
- **Graphite Raised** (`oklch(20% 0.006 280)`): inset surfaces.
- **Graphite Rule** (`oklch(28% 0.006 280)`): hairline borders.
- **Bone** (`oklch(94% 0.004 75)`): primary text.
- **Bone Soft** (`oklch(75% 0.005 75)`): secondary text.
- **Bone Faint** (`oklch(58% 0.005 280)`): tertiary text, placeholder, disabled.

### Signal roles (the four-color system)

Each signal color is pinned to a semantic role. The roles split system activity from operator attention: Plot Red marks where the operator's eye is anchored; the others encode system-side state. A surface that doesn't fit one of these roles stays ink/bone — color is never decorative.

- **Plot Red** (`oklch(58% 0.18 28)`) — **OPERATOR EYE-ANCHOR.** Focus rings. Selected sidebar / palette / card rows. The streaming cursor where new tokens land. The Result-row attention rail and Result chip in a task timeline. Destructive-action fills (Delete buttons). The Plot Red surfaces are the ones the operator is supposed to look at right now. Coverage ≤10% of any screen.
- **Signal Blue** (`oklch(60% 0.15 250)`) — **WORKING / LATER.** System-side work, current or scheduled. `in_progress` task badge (saturated chip fill). Future-`start_at` task meta (text color). Pending file attachment before commit. Read-only awareness of work in another session. The blue surfaces are "this is moving or about to move," informational without demanding gaze. The §5 status indicator pulse is reserved for the chat streaming cursor (Plot Red) — blue indicators are static.
- **Signal Amber** (`oklch(78% 0.14 75)`) — **WAIT.** `blocked` task badge (chip fill). Scheduler-parked task. Config drift. Degraded MCP. The traffic-light caution semantic; reads brighter than ink-fill without competing with Plot Red.
- **Signal Green** (`oklch(60% 0.13 150)`) — **OK.** Powered / healthy / standing-by. Daemon is up. Agent process is online. MCP server is connected. Long-running process is alive. Ambient condition, not an event. Never used for "done" — done is terminal and quiet (ink-soft), not a positive signal.

**Warn Ochre** (`oklch(72% 0.14 75)`) remains declared as the deeper-warmth cousin of Signal Amber, available for non-status warnings (e.g., MCP awaiting-oauth pill, chat warn-kind status row) where the brighter Amber would compete with task-blocked badges. Treat Amber as the canonical chip-fill "wait" color and reach for Ochre only when the surface is text-color or a thin border and the brighter Amber would over-encode.

**Destructive** (`oklch(54% 0.22 28)`) — irreversible actions only (delete agent, drop session). Never confused with Plot Red — higher chroma, paired with a destructive-action label.

### Named Rules

**The 10% Rule.** Plot Red is forbidden above 10% of any single screen's pixel area. If you find yourself reaching for a fifth red element, the screen is wrong, not the rule.

**The 2% Rule.** Green, Ochre, and Cyan each cap at ~2% of any screen. They're scan-anchors, not surface treatments. If a screen needs more than that for a role, the layout — not the budget — is wrong.

**The Tinted Neutral Rule.** Every neutral has chroma greater than zero. There is no `#000` or `#fff` in this system. Pure greys are forbidden — they read as Material default and break the lab-notebook warmth.

**The State-Color Rule.** Color is a state encoding, never decoration. If a colored element doesn't represent one of the four signal roles (NOW / OK / WAIT / LATER) or destruction, it should be ink/bone instead.

**The Single-Role Rule.** Each signal color owns exactly one semantic. Green never means "done." Ochre never means "highlight." Cyan never means "link." The mapping is one-to-one and load-bearing — a colored mark unambiguously answers "what kind of attention does this need?"

## 3. Typography

**Display Font:** Geist (with `ui-sans-serif`, `system-ui`, `sans-serif` fallback)
**Body Font:** Geist (same family — single-typeface discipline)
**Label/Mono Font:** Geist Mono (with `ui-monospace`, `SFMono-Regular` fallback)

**Character:** Geist is a clean, slightly mechanical neo-grotesque with strong tabular numerals; Geist Mono is its monospaced sibling with the same skeletal proportions. The pair feels engineered without feeling cold, and reads as one type system rather than two voices. Differentiation across the hierarchy is done with size, weight, case, and tracking — *not* by introducing a serif or a display face. Real instruments have one typeface on the panel; this system inherits that discipline.

### Hierarchy
- **Display** (Geist 600, `clamp(1.75rem, 3vw, 2.5rem)`, line-height 1.05, tracking `-0.02em`): page titles only. One per screen. Used on `/agents`, `/skills`, `/tasks`, `/settings` index views.
- **Headline** (Geist 600, `1.25rem` / 20px, line-height 1.2, tracking `-0.01em`): section headers within a page (e.g. "Active sessions", "Tools", "Memory").
- **Title** (Geist 500, `0.9375rem` / 15px, line-height 1.35): row titles, agent names in lists, message author labels.
- **Body** (Geist 400, `0.875rem` / 14px, line-height 1.55): chat content, descriptions, prose. Capped at 65–75ch in narrative areas.
- **Label** (Geist Mono 500, `0.6875rem` / 11px, **UPPERCASE**, tracking `0.08em`): faceplate-style labels above inputs, tab indicators, section eyebrow text. Always uppercase, always tracked.
- **Meta** (Geist Mono 400, `0.75rem` / 12px): timestamps, IDs, durations, token counts, model names, file sizes. Tabular figures on. Always-visible, never hover-revealed.

### Named Rules

**The Single-Family Rule.** Geist Sans and Geist Mono are the only typefaces in the system. Any addition (a serif for "editorial moments", a script for "personality") is forbidden. Differentiate with size, weight, case, and tracking.

**The Mono-for-Truth Rule.** Anything machine-truthful — IDs, hashes, timestamps, durations, file sizes, token counts, exit codes, model names — is set in Geist Mono. Anything human-authored — descriptions, chat content, headers — is set in Geist Sans. The visual distinction is the contract: if it's mono, you can copy it and paste it into a query.

**The Tracked-Label Rule.** UPPERCASE Geist Mono labels carry `letter-spacing: 0.08em`. Without it, monospaced uppercase becomes illegible. With it, it reads as faceplate engraving.

## 4. Elevation

The system is **flat**. No box-shadows. Depth is communicated by tonal layering and hairline rules.

A surface is "raised" by being one tonal step *darker* in light mode and one tonal step *lighter* in dark mode (e.g. paper → paper-sunk; graphite → graphite-raised). The step is small (~3-4% in OKLCH lightness) — felt rather than seen — and is always paired with a 1px hairline at the boundary. Three layers maximum on a screen: page → section → control.

The mental model is a notebook page with sections marked off by ruled lines, not floating cards on a desk.

### Shadow Vocabulary

There is none. `box-shadow` is forbidden in this system. Focus rings are the only place a "glow"-shaped element appears, and even there it's a 2px solid offset stroke (Plot Red) rather than a softened shadow.

### Named Rules

**The No-Shadow Rule.** `box-shadow` is forbidden everywhere. If you reach for it to indicate hierarchy, use tonal layering and a hairline instead. If you reach for it to indicate hover, use a 1-step tonal shift instead.

**The One-Hairline Rule.** Borders are always 1px. Doubling them, thickening them to 2px, or stacking borders inside borders is forbidden. If two surfaces meet, one hairline marks the boundary.

**The Three-Layer Rule.** No screen has more than three tonal layers (page → section → control). Nesting a fourth layer is forbidden — it reads as cards-inside-cards, which is the SaaS-dashboard cliché this system rejects.

## 5. Components

### Buttons
- **Shape:** Sharp rectangles. 0px radius. No exceptions including avatars when used as buttons (use a separate Avatar component for circular).
- **Primary** (Ink button): `ink` background, `paper` text, `8px 14px` padding, Geist 500 14px. Hover: `graphite` background. Used for the dominant action on a panel ("Send", "Save", "Run").
- **Ghost** (default): transparent background, `ink` text, 1px `paper-rule` border, same padding. Hover: `paper-sunk` background. Used for secondary actions; this is the *most common* button on the system.
- **Signal** (Plot Red): `plot-red` background, `paper` text. Hover: `plot-red-deep`. Reserved for *single*-action moments where the user must commit to live execution (e.g. "Stop streaming", "Activate agent"). Never used as a generic primary.
- **Destructive**: `destructive` background, `paper` text, paired with the literal word "Delete" or "Drop". Confirmation always required.
- **Focus:** 2px `plot-red` solid offset outline, 0 inset. Visible on every interactive control without exception.

### Inputs / Fields

Two tiers. Pick by surface, not by habit.

**Form fields** — settings panes, creation dialogs, anything that reads as "configure then submit":
- **Style:** `paper` background in light / `graphite-raised` in dark. 1px `paper-rule` / `graphite-rule` border. 0px radius. Geist Sans 14px text. Padding `8px 12px`.
- **Label:** Geist Mono UPPERCASE 11px, tracked, sitting above the input with a 4px gap. Always present; placeholders are not labels.
- **Focus:** Border becomes `plot-red`. No glow, no shadow. The border-color shift is the affordance.
- **Error:** Border becomes `destructive`. Inline error message in `destructive` Geist Sans 13px below the field.
- **Disabled:** `ink-faint` text, `paper-sunk` background, no border color change.

**In-place fields** — detail panes for a single entity (task, agent, skill, team). The view IS the editor; don't render a settings form around an object the user is reading:
- **No edit mode.** No pencil toggle, no separate read vs. edit layout. Every editable field is live; a single header **Save** enables when any field diverges from the saved entity (per-field comparison, not a blanket flag).
- **Titles** are chromeless inputs at heading scale — no border, no background, placeholder in `ink-faint`.
- **Property rows** (status, assignee, dates) use ghost triggers: transparent border/background at rest, `paper-sunk` on hover, `plot-red` border on focus. Negative-margin the hover surface so values stay column-aligned with their labels.
- **Prose / markdown bodies** edit in place via the WYSIWYG editor (`.tiptap-prose`), styled identically to the read-only renderer — editing and reading are the same picture.
- **Identity affordances** are direct: the avatar is the avatar picker, the title is the name field (Notion-style). No duplicate "Name" / "Avatar" form inputs below.
- **Locked fields on managed entities** keep the same layout, rendered disabled with a `MANAGED` mono hint — uniform geometry, not a different page.
- **Hard rule:** never show the same field twice (once as text, once as input), and never make the user click "Edit" to discover what's editable.

### Chips
- **ID Chip:** Mono surface for identifiers (session IDs, agent IDs, request IDs, hashes). `paper-sunk` background, `ink-soft` text, Geist Mono 12px, `2px 6px` padding, 0 radius. Always copy-on-click. Never decorated.
- **Live Chip:** `plot-red` background, `paper` text, Geist Mono 11px UPPERCASE, the literal word `LIVE` or `STREAMING`. Shows only when an agent is mid-response. Removed the instant the stream resolves.
- **Status Chip:** A thin row — 1px hairline border, no fill, Geist Mono 11px UPPERCASE. The state name is the chip text (`READY`, `IDLE`, `BUILDING`, `STOPPED`). State is encoded by chip text, not by chip color, so reduced-motion / colorblind users get the same signal.

### Cards / Containers
- **Don't use cards.** Sections are ruled regions, not floating objects. The only exceptions are deliberate floating *chrome* — the Acme panel and the Inline Notice — which earn elevation via the `ink/15` hairline + restrained shadow idiom over `paper-sunk`, never a glossy rounded card.
- A "section" is: an UPPERCASE Geist Mono label across the top, a 1px hairline below the label, content following. Padding inside the section is consistent (`16px`). Sections butt up against one another with their hairlines coinciding (one hairline shared, never doubled).
- Inset surfaces (sidebar, palette, code block) use `paper-sunk` / `graphite-raised`, hairline border on the side(s) facing the page surface.

### Navigation (Sidebar)
- Fixed-width left sidebar. `paper-sunk` background. Mono UPPERCASE label rows at `0.6875rem` with `12px 16px` padding.
- Active nav item: 2px `plot-red` left edge marker (this is allowed because the entire item is the affordance, not a card with a side-stripe; the 2px stripe IS the indicator and replaces the row's bottom-hairline). Geist Sans 500 text turns from `ink-soft` to `ink`.
- Inactive item: `ink-soft` text, no edge marker, hover applies a 1-step tonal shift on the row background.
- Section headers within the sidebar (e.g. "WORKSPACES", "AGENTS"): Geist Mono UPPERCASE 11px, `ink-faint`, `8px 16px` padding, hairline below.

### Status Indicator (signature component)
A 6px circular dot followed by a Geist Mono UPPERCASE label, separated by 6px. The dot color encodes state:
- `plot-red` (filled) — LIVE / STREAMING (animated 1.2s ease pulse)
- `ink` (filled) — READY / IDLE
- `signal-amber` (filled) — BUILDING / PENDING
- `ink-faint` (hollow ring, 1px) — STOPPED / DISABLED

The label is mandatory — no dot without a label. This satisfies the "no color-only state" accessibility rule.

Pulse is reserved for the chat streaming cursor (above) and the equivalent in-flight assistant indicator. Status dots elsewhere — daemon-up, empty-state previews, sidebar liveness — do **not** pulse. A screen with many simultaneous pulsing dots becomes visual noise; a single bounded pulse on the active stream is the only allowed exception.

This dot+label primitive is **standalone**. It is not nested inside Badge / chip components — those encode state via the badge chassis itself (variant fill or recessed mono), with the label as the encoding. The two primitives stay separate.

### Inline Notice
A low-frequency ambient signal — update available, degraded provider, quota near limit. **Floating chrome** anchored to a viewport corner (clear of the Acme panel and the mobile tab bar). This is the bounded exception to "no floating objects" (§Cards): like the Acme panel, it earns elevation with an `ink/15` hairline + a restrained shadow over `paper-sunk` — never a glossy rounded card. The trap it exists to prevent is the text-heavy notice: a sentence like "OpenAcme v0.13.0 is available (you have v0.12.0)" reads as marketing copy and fails the Read-Aloud Rule. Structure:
- A status line: the dot-or-icon + Geist Mono UPPERCASE label primitive (a `plot-red` mark = needs attention); the label may link out (changelog).
- **One** short helper line is allowed — it tells the user what the resolution does ("Update to v0.13.0:"), with any machine-truthful value (version, count) in mono. One line, never a paragraph.
- The resolution as a code-surface command, copy-on-click, when it's a single shell line (`openacme update`).
- Actions are **icon-only** — a corner ✕ to dismiss, the copy glyph on the command. Never pair an action with a redundant word label ("DISMISS ✕"); the icon in its conventional place (✕ top-right) is the whole affordance.

Dismissal is keyed to the specific signal (e.g. the version), so resolving one instance doesn't suppress the next. Read-Aloud test: the notice should scan as an instrument readout with one guiding line, not a marketing sentence.

### Command Palette (signature component)
- Centered, fixed-width modal. `paper-sunk` background, hairline border, 0 radius. No backdrop blur (forbidden by no-shadow / no-glass rules); the overlay dim is a flat 60% `ink` overlay.
- Geist Mono UPPERCASE 11px labels for section groups (e.g. `AGENTS`, `SESSIONS`, `ACTIONS`). Geist Sans 14px for action labels. Mono 12px for keyboard shortcuts on the right edge.
- Selected row: `paper` background (one step lighter than the palette body), 2px `plot-red` left edge marker.

### Chat Message (signature component)
- No bubbles. No avatar circles. No alternating sides.
- Each message is a flat region with: a Geist Mono UPPERCASE 11px row across the top reading `<role> · <timestamp> · <model>` (e.g. `ASSISTANT · 14:32:01 · claude-sonnet-4`), 1px hairline below the metadata row, then the message body in Geist Sans 14px, then a hairline below the body to mark the bottom of the message.
- Tool blocks: an indented region inside the assistant message, with its own Mono label (`TOOL · shell · 47ms`) and a `paper-sunk` / `graphite-raised` body. Collapsed by default; expand toggles via a 1-character mono caret (`▸` / `▾`).
- The streaming cursor is a 2px-wide `plot-red` vertical bar at the end of the live text, blinking at 1.2s ease-in-out. It's the *only* live-pulsing element in a typical screen.

## 6. Do's and Don'ts

### Do:
- **Do** show real metadata always-visible. Session IDs, agent IDs, timestamps, durations, model names, token counts. Geist Mono, never hidden behind hover.
- **Do** keep Plot Red ≤10% of any screen. It is the live-state color, not a brand color.
- **Do** use ruled sections (label + hairline) instead of cards. Stack sections; share hairlines.
- **Do** use Geist Mono UPPERCASE labels with `letter-spacing: 0.08em` for every faceplate-style label.
- **Do** encode state in *both* color and text/glyph. A status dot must always be paired with its label.
- **Do** use 0px radius on every surface — chrome, panels, inputs, buttons, chips. The discipline is the consistency.
- **Do** use 1px hairlines, single weight, never doubled. Two surfaces meeting share one hairline.
- **Do** layer with tonality (3-4% OKLCH lightness step). Maximum three layers per screen.
- **Do** show the agent workforce as first-class. Agents, sessions, processes, schedules, memory all surface as visible objects with their own IDs and state.
- **Do** restrict motion to state transitions (180ms ease-out-quart) and the live-stream pulse (1.2s ease-in-out on Plot Red). Disable both under `prefers-reduced-motion`.

### Don't:
- **Don't** use `box-shadow` anywhere. Depth is tonal, never shadowed.
- **Don't** use `border-radius` greater than 0 anywhere. No "rounded-md", no "rounded-lg", no "rounded-full" (avatars are a separate primitive).
- **Don't** introduce a third typeface. Geist Sans + Geist Mono is the system. No serifs for "editorial moments", no display fonts for headers.
- **Don't** use Plot Red as a brand color, a background fill, a category tag, a hyperlink color, or anything decorative. Plot Red is reserved for *active* state and focus.
- **Don't** mono-everything as a reflex. The four-color signal system (§2) names each chroma for one role — Plot Red for the operator's eye-anchor, Signal Blue for system work (current and scheduled), Signal Amber for WAIT, Signal Green for OK. Stripping them from BLOCKED badges, IN_PROGRESS badges, daemon-up indicators, future-start_at meta, or any other surface that maps to one of those roles flattens the visual and forces the operator to read every cell. Mono-by-default applies to non-state surfaces; state surfaces get their assigned signal color.
- **Don't** use pure greys. Every neutral has chroma > 0. `#000` and `#fff` are forbidden.
- **Don't** use cards with floating shadows or rounded corners. Don't nest cards. The "card grid" SaaS pattern is forbidden.
- **Don't** use side-stripe `border-left` on cards or list items as a colored stripe accent. The one allowed exception is the 2px Plot Red marker on the active sidebar / palette row, where the whole item is the affordance.
- **Don't** use centered chat input with avatars and pastel illustration empty states. That is the ChatGPT/Claude.ai chat-wrapper pattern PRODUCT.md explicitly rejects.
- **Don't** use KPI tiles, gradient hero panels, or sky-blue primary buttons. That is the SaaS-dashboard pattern PRODUCT.md rejects.
- **Don't** use neon, glassmorphism, radial gradients, or "AI orchestration" marketing aesthetics. That is the AI-startup pattern PRODUCT.md rejects.
- **Don't** use mascots, smiling-robot illustrations, pastel palettes, or friendly emoji in product UI. That is the cute-consumer pattern PRODUCT.md rejects.
- **Don't** hide primary metadata behind hover. Hover may reveal secondary detail (full hashes, descriptive tooltips); hover may not be the only path to a session ID, timestamp, or status.
- **Don't** animate layout properties (width, height, top, left, padding, margin). Animate `transform`, `opacity`, `background-color`, `border-color`, `outline-color` only.
- **Don't** use exclamation points in product copy. "Saved" not "Saved!". "Agent created" not "Agent created!".

## 7. Where Character Lives

§1–§6 above are the fence — what *not* to do. This section is the garden inside it.

The discipline of "no shadow, no radius, single accent, no gradient" prevents the four anti-references PRODUCT.md rejects. It does *not*, on its own, produce instrument-grade craft. Restraint without character lands in the second-order trap: editorial-minimal SaaS — "Linear with red." To stay out of that trap, the system commits to specific positive moves — material warmth, weighted motion, considered detail — each of which lives within §2–§6's rules.

What follows is the *positive* design vocabulary: where character is added on purpose, the references that inform it, and the failure modes to watch for.

### 7.1 Positive References

The four anti-references in PRODUCT.md tell you what we're not. These tell you what we are aspiring toward:

- **Linear** — single-typeface discipline at scale, tabular numerals everywhere they matter, weighted hover/focus motion, density as trust signal. The reference for "instrument-grade SaaS that respects the operator's intelligence."
- **Teenage Engineering OP-1** — restraint plus character. Every detail is considered: the knurling on the knobs, the alignment of the silkscreen, the curve of the buttons. Nothing decorative, everything precise. The reference for "tactile and exact."
- **Vintage Tektronix oscilloscope faceplates** — engraved UPPERCASE labels in monospace, hairline-ruled regions, signal lights that mean something, no display ornament. The reference for the faceplate-mono label system and the status-indicator vocabulary.
- **iA Writer** — paper as a surface, single typeface, restraint that *feels* warm rather than sterile. The reference for "materiality through paper warmth, not through ornament."

When in doubt, ask: *what would Linear / OP-1 / Tektronix / iA Writer do here?* Three of those four answer the question instantly.

### 7.2 The Register

The product's register has three pillars. Every character move belongs to one of them.

**Materiality.** The page reads as a *surface* — warmed paper or cool graphite — not a flat color field. Paper has tooth (faint grain). Surfaces age (ruled lines on a notebook page). Code is distinct from prose (its surface is cooler, edged with a hairline). Selection has a color of its own. Cumulative effect: every screen feels like it could be touched.

**Precision.** Alignment is exact. Hairlines are 1px, never "around 1px." Spacing is on a 4px grid; ad-hoc values are forbidden. Numbers are tabular. Mono-for-truth: anything you might paste into a query is in mono, anything you might read is in sans. Visual rhythm rewards close inspection. A reader who looks twice notices that everything was placed on purpose.

**Weighted motion.** Every interaction has *mass* — never bounce, never spring, never elastic. Motion uses a 3-step duration scale (80ms micro-shifts, 180ms state changes, 320ms panel reveals) and ease-out curves only. The page responds the way well-machined controls respond: with deliberate inertia. Choreographed sequences are forbidden; weight is the texture.

### 7.3 The Character Moves

Each of the following is a *primitive* — a named, reusable move. Use the existing one before inventing a new one.

#### Materiality

- **`.paper-surface`** — applies a barely-visible fractal-noise overlay (~2% opacity in light, ~5% in dark) to a region. Use on body so every page reads as a surface. Use on inset panels for additional tooth. Never apply twice in the same hierarchy.
- **`.paper-ruled`** — repeating 1px hairlines every 24px at ~35% paper-rule alpha. Use sparingly: the daemon footer manifest, a persona editor, a recent-activity timeline. Don't apply globally.
- **Code surface tint** — inline `<code>` and `<pre>` sit on a slightly cooler tint than `paper-sunk`, with a 1px hairline border. Use everywhere code appears: chat messages, persona drafts, ID chips.
- **`::selection`** — a ~18% plot-red wash. One selection treatment for the whole product.

#### Precision

- **Tabular numerals** — `font-feature-settings: "tnum" 1` on body and everything `font-mono`. Use without thinking; never accept a number that reflows on change.
- **Mono-for-truth** — IDs, timestamps, durations, file sizes, model names, exit codes, file paths, hashes: all `font-mono`. Human prose: sans. The visual is the contract: if it's mono, you can copy it.
- **`<SectionEyebrow>`** — UPPERCASE Geist Mono label at 11px tracked 0.08em + a scribed hairline. Replaces the SaaS card header. Opens every ruled section.
- **`<Kbd>`** — mono pill rendering a key combo (`⌘K`, `⇧⏎`, `Esc`). Goes next to every action that has a shortcut. Visible shortcuts respect the operator's time.

#### Weighted motion

- **Hover micro-motion** — `transition-colors duration-state ease-out-quart` on every interactive element. Universal; no element is decorative-only.
- **Focus scribe-in** — `outline-offset` animated from `-2px` to `2px` over 180ms when an element gains focus. Replaces instant focus rings.
- **`.scribe-in`** — `transform: scaleX(0) → scaleX(1)` over 220ms. Used on hairline rules that appear with newly-mounted sections.
- **`.tick`** — `opacity: 0.35 → 1` over 180ms. Used on any cell whose numeric value just changed (token count, "X minutes ago", session count).
- **`.section-enter`** — `opacity: 0 → 1` + `translateY(2px → 0)` over 320ms. Used on every newly-mounted panel, modal, dialog, overlay.
- **`<LoadingHairline />`** — a 1px hairline traveling left → right. Replaces `<Loader2 className="animate-spin" />` everywhere. Use whenever waiting on data.

#### Experiential

- **`<JargonChip term="...">`** — inline `[?]` chip next to a domain term; click expands an in-voice paragraph. Use at the *first* occurrence of any of: Agent, Session, MCP, Skill, Task, Persona, Tool, Daemon. Each term explained once per page.
- **`Cmd-/` help overlay** — a reference card (not a tour) listing shortcuts and concepts for the current page. Open with `?` or `Cmd-/`, dismiss with `Esc`.
- **Designed empty states** — every empty list is a teaching moment, not a placeholder. A faux instance scribes in to demonstrate the format. A caption explains where files live. A primary action follows. No mascots, no exclamation points, no "let's get started."

### 7.4 Anti-Failure Modes

Three traps that defeat the character vocabulary even when each individual move is correctly applied.

**Editorial-minimal drift.** When the product reduces to *single typeface + hairlines + one accent + max-w-prose body text*, the result looks like a Linear clone or a generic Notion-template settings page. The corrective: ensure paper-surface materiality, weighted motion, and per-state functional color are propagating — not just the typography and the hairlines. After each major surface ships, ask: *would someone read this as "Linear with red"?* If yes, materiality and motion aren't pulling hard enough.

**Choreographed motion.** When animations stagger, sequence, dance, or play multiple curves at once, motion stops being weight and becomes personality — closer to a marketing-site preloader than to a piece of lab equipment. The corrective: one curve, one duration, per primitive. No `delay` chains except in the explicit experiential moments (the `<SectionEyebrow>` content scribe-in is a deliberate 4-step sequence; nothing else in the product gets one).

**Friendly empty states.** When an empty state aims for warmth via exclamation points, "Welcome!", "Get Started", "Pick an agent to edit", or a smiling tone, it crosses out of register. The corrective: every empty-state copy is read aloud during review. If it sounds like it could appear in any SaaS app's onboarding email, rewrite it in PRODUCT.md voice — short, declarative, teaching the substrate rather than greeting the user.

### Named Rules

**The Garden-Inside-the-Fence Rule.** §6's "Don't" list is the perimeter. §7's character moves are the planted ground inside it. A surface that follows §6 but skips §7 lands in editorial-minimal drift. A surface that uses §7 but breaks §6 lands in cute-or-flashy territory. Both halves are required.

**The Three-Pillar Rule.** Every character move maps to materiality, precision, or weighted motion. If a proposed move doesn't fit one of the three, it isn't in register — either drop it or re-justify it against the pillar it strengthens.

**The Read-Aloud Rule.** Every empty-state copy and every status string is read aloud during review. Acceptance test: does it sound like a piece of lab equipment, or does it sound like marketing copy? The first passes; the second gets rewritten.
