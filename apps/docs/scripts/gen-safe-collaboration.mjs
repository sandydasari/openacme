// "Isolated identities make collaboration safe" — the general principle, not a
// product pitch. Each agent has its own identity and its own workspace: it
// writes only its own, reads the rest, and meets the others on any shared
// surface as a distinct account, where permissions stop the collisions.
// Square corners, hairline rules, signal tokens, real GitHub mark.
//   node scripts/gen-safe-collaboration.mjs
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const GH = readFileSync("scripts/github-icon.svg", "utf8").match(/d="([^"]+)"/)[1];

const c = {
  paper: "#FCFBFA", rule: "#DAD7D1",
  ink: "#28282F", inkSoft: "#585860", inkFaint: "#908D86",
  blue: "#2E78C8", violet: "#8A5AC5", green: "#2D9566",
};
const wash = { blue: "#EFF4FC", violet: "#F4EFFB", green: "#ECF5F0" };
const SANS = "ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const esc = (s) => s.replace(/&/g, "&amp;");
const T = (x, y, font, size, fill, str, opt = {}) =>
  `<text x="${x}" y="${y}" font-family="${font === "mono" ? MONO : SANS}" font-size="${size}" fill="${fill}"${opt.w ? ` font-weight="${opt.w}"` : ""}${opt.a ? ` text-anchor="${opt.a}"` : ""}${opt.ls ? ` letter-spacing="${opt.ls}"` : ""}>${esc(str)}</text>`;

const ghLogo = (x, y, s, fill) => `<g transform="translate(${x},${y}) scale(${s / 24})"><path d="${GH}" fill="${fill}"/></g>`;
const envelope = (x, y, w, h, col) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${col}" stroke-width="1.2"/>` +
  `<path d="M${x} ${y} L${x + w / 2} ${y + h * 0.62} L${x + w} ${y}" fill="none" stroke="${col}" stroke-width="1.2"/>`;
const eye = (x, y, col) =>
  `<path d="M${x} ${y} q6 -6 12 0 q-6 6 -12 0Z" fill="none" stroke="${col}" stroke-width="1.1"/><circle cx="${x + 6}" cy="${y}" r="1.6" fill="${col}"/>`;
const database = (x, y, col) =>
  `<ellipse cx="${x + 8}" cy="${y + 3}" rx="8" ry="3" fill="none" stroke="${col}" stroke-width="1.3"/><path d="M${x} ${y + 3} V${y + 15} a8 3 0 0 0 16 0 V${y + 3}" fill="none" stroke="${col}" stroke-width="1.3"/>`;
const globe = (x, y, col) =>
  `<circle cx="${x + 8}" cy="${y + 8}" r="8" fill="none" stroke="${col}" stroke-width="1.3"/><ellipse cx="${x + 8}" cy="${y + 8}" rx="3.4" ry="8" fill="none" stroke="${col}" stroke-width="1.3"/><line x1="${x}" y1="${y + 8}" x2="${x + 16}" y2="${y + 8}" stroke="${col}" stroke-width="1.3"/>`;
const avatar = (x, y, sz, col, ch, fs) =>
  `<rect x="${x}" y="${y}" width="${sz}" height="${sz}" fill="${col}"/>` +
  `<text x="${x + sz / 2}" y="${y + sz / 2 + fs * 0.36}" font-family="${SANS}" font-size="${fs}" font-weight="700" fill="#FFFFFF" text-anchor="middle">${ch}</text>`;

const W = 944, H = 600;
let b = "";

// header
b += T(48, 50, "sans", 21, c.ink, "Isolated identities make it safe", { w: 700 });
b += T(48, 77, "sans", 13.5, c.inkSoft, "Give each agent its own identity and its own workspace, so it writes only its own and reads the rest.");
b += `<line x1="48" y1="98" x2="896" y2="98" stroke="${c.rule}"/>`;

// band 1 — agents
b += T(48, 128, "mono", 11, c.inkSoft, "OWN IDENTITY, OWN WORKSPACE", { ls: "0.7" });
const agents = [
  { x: 48, color: c.blue, wash: wash.blue, ch: "A", name: "Agent A", email: "a@agents.dev", handle: "@agent-a", files: ["plan.md", "src/api.ts"] },
  { x: 350, color: c.violet, wash: wash.violet, ch: "B", name: "Agent B", email: "b@agents.dev", handle: "@agent-b", files: ["review.md", "tests/"] },
  { x: 652, color: c.green, wash: wash.green, ch: "C", name: "Agent C", email: "c@agents.dev", handle: "@agent-c", files: ["CHANGELOG", "release/"] },
];
const CW = 244;
for (const a of agents) {
  const x = a.x;
  b += `<rect x="${x}" y="148" width="${CW}" height="232" fill="${a.wash}" stroke="${a.color}" stroke-opacity="0.5"/>`;
  b += avatar(x + 20, 168, 30, a.color, a.ch, 15);
  b += T(x + 62, 190, "sans", 15, c.ink, a.name, { w: 600 });
  b += `<line x1="${x + 16}" y1="208" x2="${x + CW - 16}" y2="208" stroke="${a.color}" stroke-opacity="0.25"/>`;
  b += envelope(x + 20, 224, 16, 11, c.inkSoft);
  b += T(x + 46, 234, "mono", 11.5, c.inkSoft, a.email);
  b += ghLogo(x + 20, 246, 15, c.ink);
  b += T(x + 46, 259, "mono", 11.5, c.inkSoft, a.handle);
  // workspace
  b += `<rect x="${x + 16}" y="272" width="212" height="92" fill="${c.paper}" stroke="${a.color}" stroke-opacity="0.4"/>`;
  b += T(x + 30, 290, "mono", 9.5, c.inkSoft, "WORKSPACE", { ls: "0.6" });
  b += `<rect x="${x + 150}" y="280" width="62" height="16" fill="${a.color}"/>`;
  b += T(x + 181, 291, "mono", 9.5, "#FFFFFF", "writable", { a: "middle" });
  b += T(x + 30, 312, "mono", 10.5, c.inkFaint, a.files[0]);
  b += T(x + 30, 330, "mono", 10.5, c.inkFaint, a.files[1]);
  b += eye(x + 34, 352, c.inkFaint);
  b += T(x + 50, 356, "mono", 9.5, c.inkFaint, "read-only to the others");
}
b += T(472, 404, "sans", 12.5, c.inkSoft, "Every workspace is readable by every agent. None is writable by another.", { a: "middle" });

// band 2 — any shared surface
b += T(48, 444, "mono", 11, c.inkSoft, "MEET ON ANY SHARED SURFACE, AS A DISTINCT ACCOUNT", { ls: "0.7" });
const surfaces = [
  { x: 48, name: "Repository", icon: (X) => ghLogo(X + 16, 472, 22, c.ink) },
  { x: 268, name: "Inbox", icon: (X) => envelope(X + 16, 476, 20, 14, c.ink) },
  { x: 488, name: "Data store", icon: (X) => database(X + 16, 472, c.ink) },
  { x: 708, name: "Web app", icon: (X) => globe(X + 16, 473, c.ink) },
];
const SW = 196;
for (const s of surfaces) {
  const x = s.x;
  b += `<rect x="${x}" y="458" width="${SW}" height="92" fill="${c.paper}" stroke="${c.rule}"/>`;
  b += s.icon(x);
  b += T(x + 48, 490, "sans", 13.5, c.ink, s.name, { w: 600 });
  b += avatar(x + 16, 508, 15, c.blue, "A", 9.5);
  b += avatar(x + 37, 508, 15, c.violet, "B", 9.5);
  b += avatar(x + 58, 508, 15, c.green, "C", 9.5);
  b += T(x + 16, 538, "mono", 9.5, c.inkFaint, "distinct accounts, own scope");
}

// footer
b += `<line x1="48" y1="572" x2="896" y2="572" stroke="${c.rule}"/>`;
b += T(48, 593, "sans", 13, c.ink, "Shared credentials and shared workspaces are where it breaks. Distinct ones, with real permissions, are where it works.");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="${c.paper}" stroke="${c.rule}"/>
${b}</svg>`;

mkdirSync("public/media/i-built-a-multi-agent-platform", { recursive: true });
writeFileSync("public/media/i-built-a-multi-agent-platform/safe-collaboration.svg", svg);
console.log("wrote safe-collaboration.svg", svg.length, "bytes");
