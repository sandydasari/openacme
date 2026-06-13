/* Optimize raw 2x captures from /tmp/shots into site assets + README pngs.
   Usage: node scripts/optimize-shots.mjs */
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const SRC = "/tmp/shots";
const SCREENS = new URL("../public/screens/", import.meta.url).pathname;
const README_IMAGES = new URL("../../../docs/images/", import.meta.url)
  .pathname;

// site: <theme>/<name>.{avif,webp} at full 2880w
const SITE = [
  ["board-light.png", "light/board"],
  ["home-light.png", "light/home"],
  ["taskdetail1-light.png", "light/brief"],
  ["taskdetail-light.png", "light/result"],
  ["chat-cole-light.png", "light/chat"],
  ["board-dark.png", "dark/board"],
  ["home-dark.png", "dark/home"],
  ["taskdetail1-dark.png", "dark/brief"],
  ["taskdetail4-dark.png", "dark/result"],
  ["chat-cole-dark.png", "dark/chat"],
];

// README: 1440w pngs, same filenames the README already references
const README = [
  ["home-light.png", "hero.png"],
  ["agents-light.png", "workforce.png"],
  ["board-light.png", "tasks.png"],
  ["chat-cole-light.png", "chat.png"],
];

await mkdir(path.join(SCREENS, "light"), { recursive: true });
await mkdir(path.join(SCREENS, "dark"), { recursive: true });

for (const [src, out] of SITE) {
  const input = sharp(path.join(SRC, src));
  await input
    .clone()
    .avif({ quality: 55, effort: 6 })
    .toFile(path.join(SCREENS, `${out}.avif`));
  await input
    .clone()
    .webp({ quality: 80 })
    .toFile(path.join(SCREENS, `${out}.webp`));
  console.log("site:", out);
}

for (const [src, out] of README) {
  await sharp(path.join(SRC, src))
    .resize({ width: 1440 })
    .png({ compressionLevel: 9, palette: true })
    .toFile(path.join(README_IMAGES, out));
  console.log("readme:", out);
}
console.log("done");
