// Pure helpers for `/skill` references in the chat composer. No React — these
// drive both the inline highlight (SkillTextarea) and the send-time part build
// (routes/index.tsx). A `/name` token counts only when `name` is a real skill.

import type { OpenAcmeUIMessage } from "./types";

export interface SkillIndexEntry {
  name: string;
  description: string;
  tags: string[];
}

// `/` at a word boundary (start or after whitespace) + a kebab-case name.
const TOKEN_RE = /(^|\s)\/([a-z0-9][a-z0-9-]*)/g;

/** The in-progress `/query` at the caret, or null. `start` is the index of the
 *  leading `/` so callers can splice the replacement. */
export function activeMentionQuery(
  value: string,
  caret: number
): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const m = /(^|\s)\/([a-z0-9-]*)$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? "";
  const start = caret - query.length - 1; // -1 for the `/`
  return { start, query };
}

/** Split `value` into segments, flagging completed `/name` tokens that match a
 *  known skill so the backdrop can render them as pills. The leading
 *  boundary char (whitespace) stays outside the pill. */
export function highlightSegments(
  value: string,
  names: Set<string>
): Array<{ text: string; isSkill: boolean }> {
  const segments: Array<{ text: string; isSkill: boolean }> = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(value)) !== null) {
    const boundary = m[1] ?? "";
    const name = m[2] ?? "";
    if (!names.has(name)) continue;
    const tokenStart = m.index + boundary.length;
    if (tokenStart > last) {
      segments.push({ text: value.slice(last, tokenStart), isSkill: false });
    }
    segments.push({ text: `/${name}`, isSkill: true });
    last = tokenStart + name.length + 1;
  }
  if (last < value.length) {
    segments.push({ text: value.slice(last), isSkill: false });
  }
  return segments;
}

/** Unique referenced skill names in first-seen order. */
export function extractReferencedSkills(
  value: string,
  names: Set<string>
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(value)) !== null) {
    const name = m[2] ?? "";
    if (names.has(name) && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function renderMarker(names: string[]): string {
  const list = names.map((n) => `"${n}"`).join(", ");
  return [
    "<referenced-skills>",
    `The user referenced the skill(s): ${list}.`,
    "Load each with the skill_view tool if relevant before responding.",
    "</referenced-skills>",
  ].join("\n");
}

/** The `data-skill-ref` part(s) to attach to the outgoing user message, or `[]`. */
export function buildSkillRefParts(
  value: string,
  names: Set<string>
): OpenAcmeUIMessage["parts"] {
  const refs = extractReferencedSkills(value, names);
  if (refs.length === 0) return [];
  return [
    {
      type: "data-skill-ref",
      data: { names: refs, modelContent: renderMarker(refs) },
    } as OpenAcmeUIMessage["parts"][number],
  ];
}
