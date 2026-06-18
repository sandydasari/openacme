// 1200x630 social card for the multi-agent essay, rasterized to PNG so it
// unfurls on X / Reddit / Slack (an SVG will not). Console aesthetic: paper,
// hairline rule, the real OpenAcme logo lockup, a faint complete-graph motif
// echoing the coordination figure.  node scripts/gen-og-cover.mjs
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const W = 1200, H = 630;
const c = {
  paper: "#FCFBFA", rule: "#D7D4CE", ink: "#23232A", inkSoft: "#5C5C64",
  red: "#C0392B", blue: "#2E78C8", violet: "#8A5AC5", green: "#2D9566", amber: "#C9862A",
};
const SANS = "ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// --- OpenAcme logo (from components/logo.tsx) ---
const LOGOMARK =
  '<rect x="3" y="1" width="3" height="1"/><rect x="4" y="2" width="1" height="2"/>' +
  '<rect x="1" y="5" width="1" height="1"/><rect x="2" y="4" width="6" height="2"/>' +
  '<rect x="8" y="5" width="1" height="1"/><rect x="0" y="6" width="2" height="2"/>' +
  '<rect x="4" y="6" width="2" height="2"/><rect x="8" y="6" width="2" height="2"/>' +
  '<rect x="0" y="8" width="10" height="2"/>';
const WORDMARK_PATH =
  'M0 390 l0 -390 2500 0 2500 0 0 390 0 390 -2500 0 -2500 0 0 -390z m560 -10 l0 -280 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -280z m560 70 l0 -210 -140 0 -140 0 0 -70 0 -70 -70 0 -70 0 0 280 0 280 210 0 210 0 0 -210z m560 140 l0 -70 -140 0 -140 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -70z m280 0 l0 -70 70 0 70 0 0 -70 0 -70 70 0 70 0 0 140 0 140 70 0 70 0 0 -280 0 -280 -70 0 -70 0 0 70 0 70 -70 0 -70 0 0 70 0 70 -70 0 -70 0 0 -140 0 -140 -70 0 -70 0 0 280 0 280 70 0 70 0 0 -70z m980 -210 l0 -280 -70 0 -70 0 0 70 0 70 -70 0 -70 0 0 -70 0 -70 -70 0 -70 0 0 210 0 210 70 0 70 0 0 70 0 70 140 0 140 0 0 -280z m560 210 l0 -70 -140 0 -140 0 0 -140 0 -140 140 0 140 0 0 -70 0 -70 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -70z m420 0 l0 -70 70 0 70 0 0 70 0 70 140 0 140 0 0 -280 0 -280 -70 0 -70 0 0 210 0 210 -70 0 -70 0 0 -140 0 -140 -70 0 -70 0 0 140 0 140 -70 0 -70 0 0 -210 0 -210 -70 0 -70 0 0 280 0 280 140 0 140 0 0 -70z m980 0 l0 -70 -140 0 -140 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 70 0 70 0 0 -70 0 -70 -210 0 -210 0 0 280 0 280 210 0 210 0 0 -70z';
const WORDMARK_DEFS =
  `<mask id="wm" maskUnits="userSpaceOnUse" x="0" y="0" width="500" height="78">` +
  `<rect width="500" height="78" fill="white"/>` +
  `<g transform="translate(0,78) scale(0.1,-0.1)" fill="black" stroke="none">` +
  `<path d="${WORDMARK_PATH}"/>` +
  `<path d="M280 380 l0 -140 70 0 70 0 0 140 0 140 -70 0 -70 0 0 -140z"/>` +
  `<path d="M840 450 l0 -70 70 0 70 0 0 70 0 70 -70 0 -70 0 0 -70z"/>` +
  `<path d="M2660 450 l0 -70 70 0 70 0 0 70 0 70 -70 0 -70 0 0 -70z"/>` +
  `</g></mask>`;
const logomark = (x, y, s, fill) => `<g transform="translate(${x},${y}) scale(${s})" fill="${fill}">${LOGOMARK}</g>`;
const wordmark = (x, y, s, fill) => `<g transform="translate(${x},${y}) scale(${s})"><rect width="500" height="78" fill="${fill}" mask="url(#wm)"/></g>`;

// faint complete graph (5 nodes) on the right
const cx = 972, cy = 332, R = 98;
const nodes = Array.from({ length: 5 }, (_, i) => {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
  return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
});
let edges = "";
for (let i = 0; i < nodes.length; i++)
  for (let j = i + 1; j < nodes.length; j++)
    edges += `<line x1="${nodes[i].x.toFixed(1)}" y1="${nodes[i].y.toFixed(1)}" x2="${nodes[j].x.toFixed(1)}" y2="${nodes[j].y.toFixed(1)}" stroke="${c.rule}" stroke-width="1.4"/>`;
const cols = [c.blue, c.violet, c.green, c.amber, c.red];
const dots = nodes
  .map((n, i) => `<rect x="${(n.x - 7).toFixed(1)}" y="${(n.y - 7).toFixed(1)}" width="14" height="14" fill="${cols[i]}"/>`)
  .join("");

const titleLines = ["I built a multi-agent", "platform. You probably", "shouldn't use one."];
const title = titleLines
  .map((t, i) => `<text x="80" y="${300 + i * 68}" font-family="${SANS}" font-size="58" font-weight="700" fill="${c.ink}">${t}</text>`)
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>${WORDMARK_DEFS}</defs>
<rect width="${W}" height="${H}" fill="${c.paper}"/>
<rect x="20.5" y="20.5" width="${W - 41}" height="${H - 41}" fill="none" stroke="${c.rule}"/>
${edges}${dots}
${logomark(80, 62, 4.2, c.red)}
${wordmark(146, 67, 0.42, c.ink)}
${title}
<line x1="80" y1="520" x2="620" y2="520" stroke="${c.rule}"/>
<text x="80" y="562" font-family="${SANS}" font-size="23" fill="${c.inkSoft}">Why almost everyone is better off with a single agent.</text>
</svg>`;

mkdirSync("public/media/i-built-a-multi-agent-platform", { recursive: true });
await sharp(Buffer.from(svg)).png().toFile("public/media/i-built-a-multi-agent-platform/cover.png");
console.log("wrote cover.png 1200x630");
