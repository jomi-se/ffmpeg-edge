#!/usr/bin/env python3
"""Retrieval benchmark harness: (corpus x profile x method) -> metric vector.

Metrics (LLM is the only consumer, so recall is boss):
  recall@k   - any-of targets in top-k, at TIGHT and GENEROUS budgets, with
               bootstrap 95% CIs.
  nDCG@k     - tiebreaker (binary relevance).
  coverage   - fraction of real queries whose targets exist in this corpus
               (the ceiling recall can't exceed; answers "is cli enough").
  no_answer  - mean/median top-1 score (for picking an abstain threshold later).

Methods so far (Phase 0 floor — no embeddings yet):
  bm25       - lexical floor everything must beat.
  full_dump  - paste the whole corpus: recall == coverage ceiling, but only
               viable if the corpus fits the token budget (reported).

stdlib only. Usage: harness.py [--k-tight 5] [--k-generous 20] [--bootstrap 2000]
"""
import argparse
import json
import math
import os
import random
import re
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(HERE)
TOKEN = re.compile(r"[a-z0-9]+")
# Dump feasibility budgets (prompt tokens). ~ in-browser small model vs external.
DUMP_TIGHT_TOKENS = 8_000
DUMP_GENEROUS_TOKENS = 128_000


def toks(s):
    return TOKEN.findall(s.lower())


def load_chunks(corpus, profile):
    path = os.path.join(BENCH, "corpus", "chunked", f"{corpus}.{profile}.jsonl")
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def load_queries():
    path = os.path.join(BENCH, "eval", "queries.jsonl")
    return [json.loads(l) for l in open(path, encoding="utf-8")]


# ---------- retrieval methods: return [(chunk_idx, score), ...] desc ----------

class BM25:
    def __init__(self, chunks, k1=1.5, b=0.75):
        self.k1, self.b = k1, b
        self.docs = [toks(c["text"]) for c in chunks]
        self.dl = [len(d) for d in self.docs]
        self.avgdl = sum(self.dl) / max(1, len(self.docs))
        self.tf = [Counter(d) for d in self.docs]
        df = Counter()
        for d in self.tf:
            df.update(d.keys())
        N = len(self.docs)
        self.idf = {t: math.log(1 + (N - n + 0.5) / (n + 0.5)) for t, n in df.items()}
        self.postings = defaultdict(list)
        for i, c in enumerate(self.tf):
            for t in c:
                self.postings[t].append(i)

    def search(self, query):
        q = toks(query)
        scores = defaultdict(float)
        for t in q:
            idf = self.idf.get(t)
            if idf is None:
                continue
            for i in self.postings[t]:
                f = self.tf[i][t]
                denom = f + self.k1 * (1 - self.b + self.b * self.dl[i] / self.avgdl)
                scores[i] += idf * (f * (self.k1 + 1)) / denom
        return sorted(scores.items(), key=lambda x: -x[1])


def ranked_anchors(chunks, scored):
    """Dedup to first-seen anchor, preserving rank."""
    out, seen = [], set()
    for idx, _ in scored:
        a = chunks[idx]["anchor"]
        if a not in seen:
            seen.add(a)
            out.append(a)
    return out


# ---------- metrics ----------

def recall_at_k(ranked, targets, k):
    return 1.0 if any(a in targets for a in ranked[:k]) else 0.0


def ndcg_at_k(ranked, targets, k):
    dcg = sum(1.0 / math.log2(i + 2) for i, a in enumerate(ranked[:k]) if a in targets)
    n_rel = min(len(targets), k)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(n_rel))
    return dcg / idcg if idcg else 0.0


def bootstrap_ci(values, B, agg=lambda v: sum(v) / len(v)):
    if not values:
        return (0.0, 0.0, 0.0)
    point = agg(values)
    n = len(values)
    samples = []
    for _ in range(B):
        samples.append(agg([values[random.randrange(n)] for _ in range(n)]))
    samples.sort()
    lo = samples[int(0.025 * B)]
    hi = samples[int(0.975 * B)]
    return (point, lo, hi)


# ---------- run ----------

def anchor_set(corpus):
    path = os.path.join(BENCH, "corpus", "parsed", f"{corpus}.jsonl")
    return {json.loads(l)["anchor"] for l in open(path, encoding="utf-8")}


def corpus_tokens(corpus):
    path = os.path.join(BENCH, "corpus", "parsed", f"{corpus}.jsonl")
    return sum(len(toks(json.loads(l)["body"])) for l in open(path, encoding="utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--k-tight", type=int, default=5)
    ap.add_argument("--k-generous", type=int, default=20)
    ap.add_argument("--bootstrap", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    random.seed(args.seed)

    queries = load_queries()
    real = [q for q in queries if not q["no_answer"]]
    no_ans = [q for q in queries if q["no_answer"]]
    results = []

    for corpus in ("cli", "all"):
        aset = anchor_set(corpus)
        # coverage: real queries with >=1 target present in this corpus
        covered = [q for q in real if any(t in aset for t in q["targets"])]
        coverage = len(covered) / len(real)
        ctoks = corpus_tokens(corpus)

        # full_dump row (per corpus, profile-independent)
        results.append({
            "config": f"{corpus} / full_dump",
            "corpus": corpus, "method": "full_dump",
            "recall_tight": (coverage, coverage, coverage),
            "recall_gen": (coverage, coverage, coverage),
            "ndcg_tight": coverage, "coverage": coverage,
            "note": f"{ctoks:,} tok; "
                    f"fits_tight={ctoks <= DUMP_TIGHT_TOKENS} "
                    f"fits_generous={ctoks <= DUMP_GENEROUS_TOKENS}",
        })

        for profile in ("macro", "micro"):
            chunks = load_chunks(corpus, profile)
            bm25 = BM25(chunks)
            rt, rg, ndt = [], [], []
            for q in real:
                ra = ranked_anchors(chunks, bm25.search(q["text"]))
                rt.append(recall_at_k(ra, set(q["targets"]), args.k_tight))
                rg.append(recall_at_k(ra, set(q["targets"]), args.k_generous))
                ndt.append(ndcg_at_k(ra, set(q["targets"]), args.k_tight))
            # no-answer top-1 scores (for abstain threshold)
            na_top = []
            for q in no_ans:
                s = bm25.search(q["text"])
                na_top.append(s[0][1] if s else 0.0)
            results.append({
                "config": f"{corpus} / bm25 / {profile}",
                "corpus": corpus, "method": "bm25", "profile": profile,
                "recall_tight": bootstrap_ci(rt, args.bootstrap),
                "recall_gen": bootstrap_ci(rg, args.bootstrap),
                "ndcg_tight": sum(ndt) / len(ndt), "coverage": coverage,
                "n_chunks": len(chunks),
                "na_top1_med": sorted(na_top)[len(na_top) // 2] if na_top else None,
            })

    # ---- print table ----
    def fmt(ci):
        p, lo, hi = ci
        return f"{p:.2f} [{lo:.2f},{hi:.2f}]"

    print(f"\nrecall@k:  TIGHT k={args.k_tight}   GENEROUS k={args.k_generous}   "
          f"(bootstrap {args.bootstrap}x, 95% CI)")
    print(f"real queries: {len(real)}   no_answer: {len(no_ans)}\n")
    hdr = f"{'config':28} {'recall@tight':20} {'recall@gen':20} {'nDCG@t':7} {'cov':5}  notes"
    print(hdr)
    print("-" * len(hdr))
    for r in results:
        notes = r.get("note", "")
        if r["method"] == "bm25":
            notes = f"{r['n_chunks']} chunks; na_top1_med={r['na_top1_med']:.2f}"
        print(f"{r['config']:28} {fmt(r['recall_tight']):20} {fmt(r['recall_gen']):20} "
              f"{r['ndcg_tight']:.2f}   {r['coverage']:.2f}  {notes}")

    out = os.path.join(BENCH, "results")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "phase0_floor.json"), "w") as f:
        json.dump({"args": vars(args), "results": results}, f, indent=2)
    print(f"\n-> results/phase0_floor.json")


if __name__ == "__main__":
    main()
