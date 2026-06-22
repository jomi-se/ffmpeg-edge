// Reusable retriever — the same machine scripts/embed_bench.mjs benchmarked
// (bge-small dense + BM25, fused with RRF) wrapped as a callable so both the
// static-RAG path and the live doc-search tool query identical docs.
//
// Manual embeddings are read from the precomputed cache (.cache/emb/...), so a
// search only embeds the query (~one bge-small forward), never the whole manual.

import { pipeline, env } from "@huggingface/transformers";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const BENCH = path.dirname(HERE);
env.cacheDir = path.join(BENCH, ".cache", "hf");
env.allowLocalModels = false;

const BGE = {
  key: "bge-small",
  id: "Xenova/bge-small-en-v1.5",
  query: "Represent this sentence for searching relevant passages: ",
  doc: "",
};

const readJsonl = (p) =>
  fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// ---- BM25 (mirrors scripts/embed_bench.mjs / harness.py for parity) ----
const TOK = /[a-z0-9]+/g;
const toks = (s) => s.toLowerCase().match(TOK) || [];
class BM25 {
  constructor(chunks, k1 = 1.5, b = 0.75) {
    this.k1 = k1; this.b = b;
    this.docs = chunks.map((c) => toks(c.text));
    this.dl = this.docs.map((d) => d.length);
    this.avgdl = this.dl.reduce((a, x) => a + x, 0) / Math.max(1, this.docs.length);
    this.tf = this.docs.map((d) => { const m = new Map(); for (const t of d) m.set(t, (m.get(t) || 0) + 1); return m; });
    const df = new Map();
    for (const m of this.tf) for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);
    const N = this.docs.length;
    this.idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + (N - n + 0.5) / (n + 0.5))]));
    this.postings = new Map();
    this.tf.forEach((m, i) => { for (const t of m.keys()) { if (!this.postings.has(t)) this.postings.set(t, []); this.postings.get(t).push(i); } });
  }
  search(query) {
    const scores = new Map();
    for (const t of toks(query)) {
      const idf = this.idf.get(t); if (idf === undefined) continue;
      for (const i of this.postings.get(t)) {
        const f = this.tf[i].get(t);
        const denom = f + this.k1 * (1 - this.b + this.b * this.dl[i] / this.avgdl);
        scores.set(i, (scores.get(i) || 0) + idf * (f * (this.k1 + 1)) / denom);
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
  }
}
// RRF over ranked index lists (scale-free), returning fused chunk indices.
function rrf(lists, k = 60) {
  const score = new Map();
  for (const list of lists) list.forEach((i, r) => score.set(i, (score.get(i) || 0) + 1 / (k + r + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

export class Retriever {
  constructor({ corpus = "all-glued", profile = "macro" } = {}) {
    this.corpus = corpus; this.profile = profile;
    this.chunks = readJsonl(path.join(BENCH, "corpus", "chunked", `${corpus}.${profile}.jsonl`));
    const cache = path.join(BENCH, ".cache", "emb", `${BGE.key}.fp32.${corpus}.${profile}.json`);
    if (!fs.existsSync(cache))
      throw new Error(`missing manual embeddings ${cache} — run embed_bench first`);
    this.dvs = JSON.parse(fs.readFileSync(cache, "utf8"));
    this.bm25 = new BM25(this.chunks);
    this.enc = null;
  }
  async #encoder() {
    if (!this.enc) this.enc = await pipeline("feature-extraction", BGE.id, { dtype: "fp32" });
    return this.enc;
  }
  async embedQuery(text) {
    const ex = await this.#encoder();
    const res = await ex([BGE.query + text], { pooling: "mean", normalize: true });
    return res.tolist()[0];
  }
  // Returns top-k fused docs (anchor-deduped): [{ rank, anchor, path, text, n_words }]
  async search(query, k = 8) {
    const qv = await this.embedQuery(query);
    const dense = this.dvs
      .map((v, i) => [i, dot(qv, v)])
      .sort((a, b) => b[1] - a[1]).map(([i]) => i);
    const lexical = this.bm25.search(query);
    const fused = rrf([dense, lexical]);
    const out = [], seen = new Set();
    for (const i of fused) {
      const c = this.chunks[i];
      if (seen.has(c.anchor)) continue;
      seen.add(c.anchor);
      out.push({ rank: out.length + 1, anchor: c.anchor, path: c.path, text: c.text, n_words: c.n_words });
      if (out.length >= k) break;
    }
    return out;
  }
}
