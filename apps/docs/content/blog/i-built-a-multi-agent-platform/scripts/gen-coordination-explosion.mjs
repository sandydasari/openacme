// Generates an animated, self-contained SVG of the coordination explosion.
// CSS-only animation so it plays when referenced via <img>. Base styles equal
// the final settled state, so prefers-reduced-motion just disables animation
// and the reader still gets the full graph, final counts, and the punchline.
//
//   node content/blog/i-built-a-multi-agent-platform/scripts/gen-coordination-explosion.mjs
import { writeFileSync, mkdirSync } from "node:fs";

const MAX = 8;
const START = 2;
const ORDER = [0, 4, 2, 6, 1, 5, 3, 7]; // reveal order over 8 fixed slots, balanced at each step
const POS = [];
ORDER.forEach((s, k) => (POS[s] = k));

const cx = 200, cy = 186, R = 118, NODE_R = 6;
const SLOTS = Array.from({ length: MAX }, (_, i) => {
  const a = ((-90 + i * (360 / MAX)) * Math.PI) / 180;
  return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
});
const EDGES = [];
for (let i = 0; i < MAX; i++)
  for (let j = i + 1; j < MAX; j++)
    EDGES.push({ a: i, b: j, appearIdx: Math.max(POS[i], POS[j]) });

const c = {
  paper: "#FCFBFA", border: "#D8D4CF",
  ink: "#2A2A33", inkSoft: "#5A5A64", inkFaint: "#6E6E78",
  red: "#CB4632",
};

const LOOP = 11, step = 0.95, revDur = 0.45, drawDur = 0.5, settleDur = 0.78;
const FS = 9.6, fadeDur = 0.9; // fade-out window before the loop restarts
const tNode = (m) => (m <= 1 ? 0 : (m - 1) * step);
const pct = (t) => +((t / LOOP) * 100).toFixed(3);

const nodeKF = (A) => {
  const id = `n${Math.round(A * 100)}`;
  const pre = A > 0 ? `${pct(A)}%{opacity:0;transform:scale(.3)}` : "";
  return `@keyframes ${id}{0%{opacity:0;transform:scale(.3)}${pre}${pct(A + 0.26)}%{opacity:1;transform:scale(1.3)}${pct(A + revDur)}%{opacity:1;transform:scale(1)}${pct(FS)}%{opacity:1;transform:scale(1)}${pct(FS + fadeDur)}%{opacity:0;transform:scale(1)}100%{opacity:0;transform:scale(1)}}`;
};
const edgeKF = (A) => {
  const id = `e${Math.round(A * 100)}`;
  const pre = A > 0 ? `${pct(A)}%{opacity:0;stroke:${c.red};stroke-dashoffset:300;stroke-width:1.7}` : "";
  return `@keyframes ${id}{0%{opacity:0;stroke:${c.red};stroke-dashoffset:300;stroke-width:1.7}${pre}${pct(A + drawDur)}%{opacity:.95;stroke:${c.red};stroke-dashoffset:0;stroke-width:1.7}${pct(A + settleDur)}%{opacity:.17;stroke:${c.ink};stroke-dashoffset:0;stroke-width:1}${pct(FS)}%{opacity:.17;stroke:${c.ink};stroke-width:1}${pct(FS + fadeDur)}%{opacity:0}100%{opacity:0}}`;
};
const WINDOWS = [];
for (let s = 0; s <= MAX - START; s++)
  WINDOWS.push({ s, start: s * step, end: s === MAX - START ? FS : (s + 1) * step, last: s === MAX - START });
const numKF = (w) => {
  const pre = w.start > 0 ? `${pct(w.start)}%{opacity:0;transform:translateY(5px)}` : "";
  const fadeEnd = w.last ? FS + fadeDur : w.end + 0.2;
  return `@keyframes m${w.s}{0%{opacity:0;transform:translateY(5px)}${pre}${pct(w.start + 0.22)}%{opacity:1;transform:translateY(0)}${pct(w.end)}%{opacity:1;transform:translateY(0)}${pct(fadeEnd)}%{opacity:0}100%{opacity:0}}`;
};
const punchKF = `@keyframes punch{0%{opacity:0;transform:translateY(6px)}${pct(6.8)}%{opacity:0;transform:translateY(6px)}${pct(7.15)}%{opacity:1;transform:translateY(0)}${pct(FS)}%{opacity:1}${pct(FS + fadeDur)}%{opacity:0}100%{opacity:0}}`;

const nodeTimes = [...new Set(SLOTS.map((_, i) => tNode(POS[i])))].sort((a, b) => a - b);
const edgeTimes = [...new Set(EDGES.map((e) => tNode(e.appearIdx)))].sort((a, b) => a - b);

let css = `
text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.a{animation-duration:${LOOP}s;animation-iteration-count:infinite;animation-timing-function:linear;animation-fill-mode:both}
line.a{opacity:.17;stroke-dashoffset:0;stroke-width:1}
circle.a{transform-box:fill-box;transform-origin:center}
.num{transform-box:fill-box;transform-origin:left center;opacity:0}
text.fin{opacity:1}
.punch{opacity:1}
@media (prefers-reduced-motion: reduce){.a{animation:none!important}}
`;
nodeTimes.forEach((A) => (css += nodeKF(A) + "\n"));
edgeTimes.forEach((A) => (css += edgeKF(A) + "\n"));
WINDOWS.forEach((w) => (css += numKF(w) + "\n"));
css += punchKF + "\n";

let body = "";
EDGES.forEach((e) => {
  const A = tNode(e.appearIdx);
  body += `<line class="a" x1="${SLOTS[e.a].x.toFixed(1)}" y1="${SLOTS[e.a].y.toFixed(1)}" x2="${SLOTS[e.b].x.toFixed(1)}" y2="${SLOTS[e.b].y.toFixed(1)}" stroke="${c.ink}" stroke-linecap="round" stroke-dasharray="300" style="animation-name:e${Math.round(A * 100)}"/>\n`;
});
SLOTS.forEach((s, i) => {
  const A = tNode(POS[i]);
  body += `<circle class="a" cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${NODE_R}" fill="${c.ink}" style="opacity:1;animation-name:n${Math.round(A * 100)}"/>\n`;
});

const PX = 440;
let panel = `
<text x="${PX}" y="66" font-size="12" letter-spacing="1.4" fill="${c.inkSoft}">AGENTS</text>
<text x="648" y="66" font-size="12" fill="${c.inkFaint}" text-anchor="end">grows by 1</text>
`;
WINDOWS.forEach((w) => {
  panel += `<text class="a num${w.last ? " fin" : ""}" x="${PX}" y="112" font-size="42" font-weight="500" fill="${c.ink}" style="animation-name:m${w.s}">${START + w.s}</text>\n`;
});
panel += `
<text x="${PX}" y="162" font-size="12" letter-spacing="1.4" fill="${c.red}">CONNECTIONS</text>
<text x="648" y="162" font-size="12" fill="${c.inkFaint}" text-anchor="end">n(n-1)/2</text>
`;
WINDOWS.forEach((w) => {
  const v = ((START + w.s) * (START + w.s - 1)) / 2;
  panel += `<text class="a num${w.last ? " fin" : ""}" x="${PX}" y="222" font-size="58" font-weight="600" fill="${c.red}" style="animation-name:m${w.s}">${v}</text>\n`;
});
panel += `<line x1="${PX}" y1="252" x2="712" y2="252" stroke="${c.border}"/>\n`;
const teamX = MAX / START;
const coordX = (MAX * (MAX - 1)) / (START * (START - 1));
panel += `
<g class="a punch" style="animation-name:punch">
<text x="${PX}" y="284" font-size="15" fill="${c.ink}">${teamX}&#215; the team.</text>
<text x="${PX}" y="308" font-size="15" font-weight="500" fill="${c.red}">${coordX}&#215; the coordination.</text>
</g>
`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 360">
<style>${css}</style>
<rect x="1" y="1" width="758" height="358" rx="10" fill="${c.paper}" stroke="${c.border}"/>
<line x1="402" y1="44" x2="402" y2="316" stroke="${c.border}" stroke-dasharray="2 6"/>
${body}${panel}</svg>`;

mkdirSync(new URL("../figures/", import.meta.url), { recursive: true });
writeFileSync(new URL("../figures/coordination-explosion.svg", import.meta.url), svg);
console.log("wrote coordination-explosion.svg", svg.length, "bytes");
