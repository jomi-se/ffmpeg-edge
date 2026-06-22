// Renders the PWA icon set from public/icons/icon.svg.
// Run with: node scripts/generate-icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "public", "icons");
const publicDir = join(root, "public");
const svg = readFileSync(join(iconsDir, "icon.svg"), "utf8");

function render(size) {
  return new Resvg(svg, { fitTo: { mode: "width", value: size } })
    .render()
    .asPng();
}

// Standard PNG outputs: [filename, size, directory]
const pngTargets = [
  ["pwa-192.png", 192, iconsDir],
  ["pwa-512.png", 512, iconsDir],
  ["maskable-512.png", 512, iconsDir], // mark sits inside the maskable safe circle
  ["apple-touch-icon.png", 180, iconsDir], // opaque (svg has an off-white backdrop)
  ["favicon-32x32.png", 32, iconsDir],
];

for (const [name, size, dir] of pngTargets) {
  writeFileSync(join(dir, name), render(size));
  console.log(`wrote ${name} (${size}px)`);
}

// favicon.ico — a real multi-size ICO with PNG-encoded entries (16/32/48).
function buildIco(sizes) {
  const images = sizes.map((size) => ({ size, data: render(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.data.length, 8); // size of image data
    e.writeUInt32LE(offset, 12); // offset
    offset += img.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

writeFileSync(join(publicDir, "favicon.ico"), buildIco([16, 32, 48]));
console.log("wrote favicon.ico (16/32/48)");
