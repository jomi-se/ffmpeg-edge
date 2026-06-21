// Dense-retrieval benchmark in Node + transformers.js (same stack as the browser
// runtime, so build↔runtime parity is near-free). Embeds chunks + queries with a
// chosen model, ranks by cosine, reports recall@k (tight/generous) + nDCG +
// bootstrap CIs + coverage split — mirroring scripts/harness.py (the BM25 floor).
//
// Usage:
//   node scripts/embed_bench.mjs --model bge-small [--corpus all] [--profile macro]
//        [--dtype fp32|q8] [--k-tight 5] [--k-generous 20] [--bootstrap 2000]
// Chunk embeddings are cached under .cache/emb/ keyed by model+dtype+corpus+profile.

import { pipeline, env } from "@huggingface/transformers";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const BENCH = path.dirname(HERE);
env.cacheDir = path.join(BENCH, ".cache", "hf");
env.allowLocalModels = false;

// ---- model registry: id + asymmetric prefixes (wrong/missing prefix = false neg) ----
const MODELS = {
  "bge-small": {
    id: "Xenova/bge-small-en-v1.5",
    query: "Represent this sentence for searching relevant passages: ",
    doc: "",
  },
  "minilm": { id: "Xenova/all-MiniLM-L6-v2", query: "", doc: "" },
  "gte-small": { id: "Xenova/gte-small", query: "", doc: "" },
};

// ---- args ----
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const modelKey = arg("model", "bge-small");
const dtype = arg("dtype", "fp32");
const kT = +arg("k-tight", 5);
const kG = +arg("k-generous", 20);
const B = +arg("bootstrap", 2000);
const onlyCorpus = arg("corpus", null);
const onlyProfile = arg("profile", null);
const m = MODELS[modelKey];
if (!m) throw new Error(`unknown model ${modelKey}; have ${Object.keys(MODELS)}`);

// ---- data ----
const readJsonl = (p) =>
  fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const queries = readJsonl(path.join(BENCH, "eval", "queries.jsonl"));
const real = queries.filter((q) => !q.no_answer);
const noAns = queries.filter((q) => q.no_answer);
const anchorSet = (corpus) =>
  new Set(readJsonl(path.join(BENCH, "corpus", "parsed", `${corpus}.jsonl`)).map((u) => u.anchor));

// ---- embedding (cached) ----
let extractor = null;
async function getExtractor() {
  if (!extractor) {
    process.stderr.write(`loading ${m.id} (${dtype})…\n`);
    extractor = await pipeline("feature-extraction", m.id, { dtype });
  }
  return extractor;
}
async function embed(texts, prefix) {
  const ex = await getExtractor();
  const out = [];
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => prefix + t);
    const res = await ex(batch, { pooling: "mean", normalize: true });
    out.push(...res.tolist());
    if (i % 1024 === 0) process.stderr.write(`  embedded ${i}/${texts.length}\r`);
  }
  return out; // array of normalized vectors
}
async function chunkEmbeddings(corpus, profile, chunks) {
  const dir = path.join(BENCH, ".cache", "emb");
  fs.mkdirSync(dir, { recursive: true });
  const key = `${modelKey}.${dtype}.${corpus}.${profile}.json`;
  const cp = path.join(dir, key);
  if (fs.existsSync(cp)) return JSON.parse(fs.readFileSync(cp, "utf8"));
  const vecs = await embed(chunks.map((c) => c.text), m.doc);
  fs.writeFileSync(cp, JSON.stringify(vecs));
  process.stderr.write(`  cached ${key}\n`);
  return vecs;
}

// ---- metrics ----
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function rankedAnchors(chunks, qv, dvs) {
  const scored = dvs.map((v, i) => [i, dot(qv, v)]).sort((a, b) => b[1] - a[1]);
  const out = [], seen = new Set();
  for (const [i] of scored) {
    const a = chunks[i].anchor;
    if (!seen.has(a)) { seen.add(a); out.push(a); }
  }
  return out;
}
const recallAt = (ranked, targets, k) => ranked.slice(0, k).some((a) => targets.has(a)) ? 1 : 0;
function ndcgAt(ranked, targets, k) {
  let dcg = 0;
  ranked.slice(0, k).forEach((a, i) => { if (targets.has(a)) dcg += 1 / Math.log2(i + 2); });
  const nRel = Math.min(targets.size, k);
  let idcg = 0;
  for (let i = 0; i < nRel; i++) idcg += 1 / Math.log2(i + 2);
  return idcg ? dcg / idcg : 0;
}
function bootstrapCI(vals) {
  if (!vals.length) return [0, 0, 0];
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const point = mean(vals), n = vals.length, samp = [];
  for (let b = 0; b < B; b++) {
    const s = [];
    for (let i = 0; i < n; i++) s.push(vals[(Math.random() * n) | 0]);
    samp.push(mean(s));
  }
  samp.sort((a, b) => a - b);
  return [point, samp[(0.025 * B) | 0], samp[(0.975 * B) | 0]];
}
const fmt = ([p, lo, hi]) => `${p.toFixed(2)} [${lo.toFixed(2)},${hi.toFixed(2)}]`;

// ---- run ----
const corpora = onlyCorpus ? [onlyCorpus] : ["cli", "all"];
const profiles = onlyProfile ? [onlyProfile] : ["macro"];
const rows = [];
for (const corpus of corpora) {
  const aset = anchorSet(corpus);
  const covered = real.filter((q) => q.targets.some((t) => aset.has(t)));
  const coverage = covered.length / real.length;
  for (const profile of profiles) {
    const chunks = readJsonl(path.join(BENCH, "corpus", "chunked", `${corpus}.${profile}.jsonl`));
    const dvs = await chunkEmbeddings(corpus, profile, chunks);
    const qvs = await embed(real.map((q) => q.text), m.query);
    const naqvs = await embed(noAns.map((q) => q.text), m.query);
    const rt = [], rg = [], nd = [];
    real.forEach((q, qi) => {
      const ranked = rankedAnchors(chunks, qvs[qi], dvs);
      const T = new Set(q.targets);
      rt.push(recallAt(ranked, T, kT));
      rg.push(recallAt(ranked, T, kG));
      nd.push(ndcgAt(ranked, T, kT));
    });
    // no_answer: top-1 cosine (for abstain threshold)
    const naTop = naqvs.map((qv) => Math.max(...dvs.map((v) => dot(qv, v))));
    naTop.sort((a, b) => a - b);
    rows.push({
      config: `${corpus} / ${modelKey} / ${profile}`,
      rt: bootstrapCI(rt), rg: bootstrapCI(rg),
      nd: nd.reduce((a, b) => a + b, 0) / nd.length,
      coverage, nChunks: chunks.length,
      naMed: naTop[naTop.length >> 1],
    });
  }
}

console.log(`\nmodel=${modelKey} (${m.id}) dtype=${dtype}  recall@k tight=${kT} generous=${kG}  (bootstrap ${B}x, 95% CI)`);
console.log(`real=${real.length} no_answer=${noAns.length}\n`);
const hdr = `${"config".padEnd(28)} ${"recall@tight".padEnd(20)} ${"recall@gen".padEnd(20)} ${"nDCG".padEnd(6)} ${"cov".padEnd(5)} notes`;
console.log(hdr); console.log("-".repeat(hdr.length));
for (const r of rows) {
  console.log(`${r.config.padEnd(28)} ${fmt(r.rt).padEnd(20)} ${fmt(r.rg).padEnd(20)} ${r.nd.toFixed(2).padEnd(6)} ${r.coverage.toFixed(2).padEnd(5)} ${r.nChunks} chunks; na_top1_med=${r.naMed.toFixed(2)}`);
}
const outDir = path.join(BENCH, "results");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `phase1_${modelKey}_${dtype}.json`),
  JSON.stringify({ model: m.id, dtype, kT, kG, rows }, null, 2));
console.log(`\n-> results/phase1_${modelKey}_${dtype}.json`);
