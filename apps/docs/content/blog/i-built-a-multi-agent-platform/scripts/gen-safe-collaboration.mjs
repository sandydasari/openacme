// "Isolated identities make it safe" — animated. Each agent is its own account
// with its own permissions, and works on shared platforms (GitHub, Salesforce,
// a database) as itself. One connection per agent-platform pair (reading and
// changing go the same way, through the agent's own identity); colored pulses
// flow along them. Square corners, hairline rules, signal washes, real logos.
// SMIL so it plays via <img>; t=0 is a clean static frame.
//   node content/blog/i-built-a-multi-agent-platform/scripts/gen-safe-collaboration.mjs
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const c = {
  paper: "#FCFBFA", rule: "#DAD7D1",
  ink: "#28282F", inkSoft: "#585860", inkFaint: "#94918B",
  blue: "#2E78C8", violet: "#8A5AC5", green: "#2D9566",
};
const wash = { blue: "#EFF4FC", violet: "#F4EFFB", green: "#ECF5F0" };
const SANS = "ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const esc = (s) => s.replace(/&/g, "&amp;");
const T = (x, y, font, size, fill, str, o = {}) =>
  `<text x="${x}" y="${y}" font-family="${font === "mono" ? MONO : SANS}" font-size="${size}" fill="${fill}"${o.w ? ` font-weight="${o.w}"` : ""}${o.a ? ` text-anchor="${o.a}"` : ""}${o.ls ? ` letter-spacing="${o.ls}"` : ""}>${esc(str)}</text>`;

const pathOf = (file) => readFileSync(new URL(`./logos/${file}`, import.meta.url), "utf8").match(/ d="([^"]+)"/)[1];
const GH = pathOf("github.svg");
const SF = pathOf("salesforce.svg");
const PG = pathOf("postgres.svg");
const logo = (d, x, y, s, fill) => `<g transform="translate(${x},${y}) scale(${s / 24})"><path d="${d}" fill="${fill}"/></g>`;
const envelope = (x, y, w, h, col) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${col}" stroke-width="1.1"/>` +
  `<path d="M${x} ${y} L${x + w / 2} ${y + h * 0.6} L${x + w} ${y}" fill="none" stroke="${col}" stroke-width="1.1"/>`;
const avatar = (x, y, sz, col, ch, fs) =>
  `<rect x="${x}" y="${y}" width="${sz}" height="${sz}" fill="${col}"/>` +
  `<text x="${x + sz / 2}" y="${y + sz / 2 + fs * 0.35}" font-family="${SANS}" font-size="${fs}" font-weight="700" fill="#fff" text-anchor="middle">${ch}</text>`;

const W = 944, H = 492;

const agents = [
  { color: c.blue, wash: wash.blue, ch: "A", name: "Agent A", email: "a@acme.dev", handle: "@agent-a", y: 124 },
  { color: c.violet, wash: wash.violet, ch: "B", name: "Agent B", email: "b@acme.dev", handle: "@agent-b", y: 222 },
  { color: c.green, wash: wash.green, ch: "C", name: "Agent C", email: "c@acme.dev", handle: "@agent-c", y: 320 },
];
const AX = 32, AW = 210, AH = 82;
const aOut = (a) => ({ x: AX + AW, y: a.y + AH / 2 });

const platforms = [
  { name: "GitHub", sub: "repositories", d: GH, y: 124 },
  { name: "Salesforce", sub: "CRM records", d: SF, y: 222 },
  { name: "Postgres", sub: "shared database", d: PG, y: 320 },
];
const PX = 636, PW = 280, PH = 82;
const pIn = (p) => ({ x: PX, y: p.y + PH / 2 });

let defs = "", lines = "", pulses = "";

// header
let b = "";
b += T(AX, 42, "sans", 21, c.ink, "Isolated identities make it safe", { w: 700 });
b += T(AX, 66, "sans", 13, c.inkSoft, "Each agent is its own account with its own permissions on every shared platform.");
b += T(AX, 84, "sans", 13, c.inkSoft, "It works as itself, never through a shared login, so its actions can't collide with another's.");
b += `<line x1="${AX}" y1="102" x2="${W - AX}" y2="102" stroke="${c.rule}"/>`;

// connection mesh: every agent reaches every platform as its own account
agents.forEach((a, i) => {
  const o = aOut(a);
  platforms.forEach((p, j) => {
    const t = pIn(p);
    const id = `c${i}${j}`;
    defs += `<path id="${id}" d="M${o.x} ${o.y} L${t.x} ${t.y}"/>`;
    lines += `<line x1="${o.x}" y1="${o.y}" x2="${t.x}" y2="${t.y}" stroke="${a.color}" stroke-opacity="0.22" stroke-width="1"/>`;
    const dur = 3.6, begin = (i * 1.1 + j * 0.7).toFixed(2);
    pulses += `<rect x="-4" y="-4" width="8" height="8" fill="${a.color}" opacity="0">
<animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite"><mpath xlink:href="#${id}"/></animateMotion>
<animate attributeName="opacity" dur="${dur}s" begin="${begin}s" repeatCount="indefinite" keyTimes="0;0.12;0.88;1" values="0;1;1;0"/>
</rect>`;
  });
});

// agent identity cards
agents.forEach((a) => {
  b += `<rect x="${AX}" y="${a.y}" width="${AW}" height="${AH}" fill="${a.wash}" stroke="${a.color}" stroke-opacity="0.5"/>`;
  b += avatar(AX + 16, a.y + 16, 30, a.color, a.ch, 15);
  b += T(AX + 58, a.y + 31, "sans", 14, c.ink, a.name, { w: 600 });
  b += logo(GH, AX + 58, a.y + 40, 13, c.inkSoft);
  b += T(AX + 76, a.y + 51, "mono", 11, c.inkSoft, a.handle);
  b += envelope(AX + 58, a.y + 60, 14, 9, c.inkFaint);
  b += T(AX + 76, a.y + 68, "mono", 11, c.inkSoft, a.email);
});

// platform nodes — agents meet here as distinct accounts
platforms.forEach((p) => {
  b += `<rect x="${PX}" y="${p.y}" width="${PW}" height="${PH}" fill="${c.paper}" stroke="${c.rule}"/>`;
  b += logo(p.d, PX + 18, p.y + 16, 22, c.ink);
  b += T(PX + 50, p.y + 27, "sans", 14, c.ink, p.name, { w: 600 });
  b += T(PX + 50, p.y + 45, "mono", 10.5, c.inkSoft, p.sub);
  // distinct accounts
  agents.forEach((a, k) => (b += avatar(PX + 18 + k * 19, p.y + 56, 15, a.color, a.ch, 9.5)));
  b += T(PX + 18 + 3 * 19 + 8, p.y + 67, "mono", 9.5, c.inkFaint, "distinct accounts, own permissions");
});

// footer principle
b += `<line x1="${AX}" y1="436" x2="${W - AX}" y2="436" stroke="${c.rule}"/>`;
b += T(AX, 464, "sans", 13.5, c.ink, "Shared credentials and shared workspaces are where it breaks. Distinct ones, with real permissions, are where it works.");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}">
<defs>${defs}</defs>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="${c.paper}" stroke="${c.rule}"/>
${lines}${b}${pulses}</svg>`;

mkdirSync(new URL("../figures/", import.meta.url), { recursive: true });
writeFileSync(new URL("../figures/safe-collaboration.svg", import.meta.url), svg);
console.log("wrote safe-collaboration.svg", svg.length, "bytes");
