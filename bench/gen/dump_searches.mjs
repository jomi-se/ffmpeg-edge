import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const d = JSON.parse(fs.readFileSync(path.join(HERE, "results.json"), "utf8")).runs;
const ok = (v) => v === "good" || v === "pass" || v === "abstain_ok";
const get = (k, id) => d[k]?.records.find((r) => r.id === id);
const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["to_mp4-neutral-1", "gif-neutral-1", "compress_video-terse-1", "thumb_video-neutral-1", "speed_video-neutral-1", "mp3-wrong_terms-1"];
for (const id of ids) {
  const req = get("ministral-8b__tool__v2", id)?.request ?? get("ministral-3b__tool__v2", id)?.request;
  console.log("\n===== " + id + "  --  " + JSON.stringify(req));
  for (const m of ["3b", "8b", "14b"]) {
    for (const [lbl, k] of [["base ", `ministral-${m}__tool__v1fair`], ["coach", `ministral-${m}__tool__v2`]]) {
      const r = get(k, id);
      if (!r) continue;
      console.log(`  ${m.padEnd(3)} ${lbl} ${ok(r.verdict) ? "OK " : "x  "}(${r.nSearches}x): ${JSON.stringify(r.searches)}`);
    }
  }
}
