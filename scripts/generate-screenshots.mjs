// Captures PWA manifest screenshots (wide + narrow) of the running app.
// Requires the dev/preview server to be up. Usage:
//   npm run preview &   # or npm run dev
//   node scripts/generate-screenshots.mjs [baseUrl]
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "screenshots");
mkdirSync(outDir, { recursive: true });

const baseUrl = process.argv[2] || "http://127.0.0.1:5173/";

// deviceScaleFactor 1 so the PNG pixel size equals the CSS viewport, matching
// the "sizes" we declare in the manifest. headless + no-sandbox per .codex.
const shots = [
  { name: "desktop.png", width: 1280, height: 800 },
  { name: "mobile.png", width: 412, height: 915 },
];

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});

for (const shot of shots) {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  // coi-serviceworker reloads once on first load to gain control; wait it out.
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("h1", { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: join(outDir, shot.name),
    fullPage: false,
  });
  console.log(`wrote ${shot.name} (${shot.width}x${shot.height})`);
  await context.close();
}

await browser.close();
