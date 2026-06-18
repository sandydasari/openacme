// Generates the write-conflict cascade in the site's console language:
// sharp 0px corners, hairline rules, no shadows, signal color tokens.
// Each card is color-coded by a light wash + matching rule, no flat grey.
// Concept after Galileo's write-conflict diagram.
//   node scripts/gen-write-cascade.mjs
import { writeFileSync, mkdirSync } from "node:fs";

const c = {
  paper: "#FCFBFA", rule: "#D9D6D1",
  ink: "#28282F", inkSoft: "#585860", inkFaint: "#8E8B84",
  red: "#CB4632", redDeep: "#A6361F",
  blue: "#2E78C8", amber: "#C9862A", green: "#2D9566",
};
// light washes per signal color
const wash = { blue: "#EEF4FB", amber: "#FBF3E4", red: "#FBEBE7", green: "#EBF4EF" };
const SANS = "ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const esc = (s) => s.replace(/&/g, "&amp;");

// color-coded card: light wash fill, soft colored rule, solid accent bar
function card(x, y, w, h, accent, fill, title, sub) {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${accent}" stroke-opacity="0.5"/>` +
    `<rect x="${x}" y="${y}" width="4" height="${h}" fill="${accent}"/>` +
    `<text x="${x + 16}" y="${y + 25}" font-family="${SANS}" font-size="13" font-weight="600" fill="${accent}">${esc(title)}</text>` +
    `<text x="${x + 16}" y="${y + 44}" font-family="${MONO}" font-size="11" fill="${c.inkSoft}">${esc(sub)}</text>`
  );
}
const panel = (x, y, w, h, label, lc) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${c.rule}"/>` +
  `<text x="${x + 16}" y="${y + 25}" font-family="${MONO}" font-size="11" letter-spacing="0.6" fill="${lc}">${label}</text>`;
const arrow = (x1, y1, x2, y2, col, dash) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${dash ? 1.2 : 1.8}" ${dash ? 'stroke-dasharray="3 3"' : ""} marker-end="url(#${col === c.red ? "ar" : "ai"})"/>`;

const W = 944, H = 462, CY = 232;
let b = "";

b += `<text x="32" y="46" font-family="${SANS}" font-size="20" font-weight="700" fill="${c.ink}">Writes do not parallelize</text>`;
b += `<text x="32" y="69" font-family="${SANS}" font-size="13" fill="${c.inkSoft}">Two agents writing the same shared state cascade into one incompatible system.</text>`;

// input
b += `<rect x="32" y="${CY - 28}" width="120" height="56" fill="${c.paper}" stroke="${c.inkFaint}"/>`;
b += `<text x="92" y="${CY - 2}" font-family="${SANS}" font-size="13" font-weight="600" fill="${c.ink}" text-anchor="middle">user profile</text>`;
b += `<text x="92" y="${CY + 16}" font-family="${MONO}" font-size="10.5" fill="${c.inkSoft}" text-anchor="middle">to create</text>`;
b += arrow(152, CY, 178, CY, c.inkSoft);

// panel 1: parallel writes (C sits clearly to the right of A and B)
b += panel(180, 100, 324, 264, "PARALLEL WRITES", c.inkSoft);
b += card(198, 136, 146, 58, c.blue, wash.blue, "Agent A", "{ id, name, role }");
b += card(198, 272, 146, 58, c.blue, wash.blue, "Agent B", "{ userId, fullName }");
b += card(360, 203, 138, 58, c.amber, wash.amber, "Agent C", "merges into a 3rd");
b += arrow(344, 188, 362, 209, c.inkFaint, true);
b += arrow(344, 280, 362, 255, c.inkFaint, true);
b += arrow(506, CY, 526, CY, c.red);

// panel 2: cascading conflicts
b += panel(528, 100, 230, 264, "CASCADING CONFLICTS", c.red);
["three incompatible structures", "auth expects different fields", "database schema mismatched", "API endpoints broken"].forEach((t, i) => {
  const y = 140 + i * 55;
  b += `<rect x="544" y="${y}" width="198" height="48" fill="${wash.red}" stroke="${c.red}" stroke-opacity="0.5"/>`;
  b += `<rect x="544" y="${y}" width="4" height="48" fill="${c.red}"/>`;
  b += `<text x="560" y="${y + 29}" font-family="${SANS}" font-size="12" fill="${c.ink}">${esc(t)}</text>`;
});
b += arrow(760, CY, 780, CY, c.red);

// failure
b += `<rect x="782" y="${CY - 32}" width="154" height="64" fill="${c.red}" stroke="${c.redDeep}"/>`;
b += `<text x="859" y="${CY - 4}" font-family="${SANS}" font-size="14" font-weight="700" fill="${c.paper}" text-anchor="middle">SYSTEM FAILURE</text>`;
b += `<text x="859" y="${CY + 16}" font-family="${SANS}" font-size="11" fill="#F6D9D2" text-anchor="middle">complete rewrite</text>`;

// reads contrast strip
b += `<rect x="32" y="392" width="904" height="56" fill="${wash.green}" stroke="${c.green}" stroke-opacity="0.5"/>`;
b += `<rect x="32" y="392" width="4" height="56" fill="${c.green}"/>`;
b += `<text x="50" y="417" font-family="${MONO}" font-size="11" letter-spacing="0.5" fill="${c.green}">READS DO THE OPPOSITE</text>`;
b += `<text x="50" y="437" font-family="${SANS}" font-size="12.5" fill="${c.ink}">Many agents read the same state at once and merge what they find. Nothing to reconcile, nothing to break.</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<defs>
<marker id="ai" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6.5,3 L0,6 Z" fill="${c.inkSoft}"/></marker>
<marker id="ar" markerWidth="9" markerHeight="9" refX="6.5" refY="3.2" orient="auto"><path d="M0,0 L7,3.2 L0,6.4 Z" fill="${c.red}"/></marker>
</defs>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="${c.paper}" stroke="${c.rule}"/>
${b}</svg>`;

mkdirSync("public/media/i-built-a-multi-agent-platform", { recursive: true });
writeFileSync("public/media/i-built-a-multi-agent-platform/write-conflict-cascade.svg", svg);
console.log("wrote write-conflict-cascade.svg", svg.length, "bytes");
