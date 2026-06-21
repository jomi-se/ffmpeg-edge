# Edge RAG Retrieval Benchmark — Plan & Progress

> **Branch:** `edge-rag-benchmark` · **Status doc — keep updated as we go so we can
> resume after any interruption.** This is the committed source of truth (the
> uncommitted `../PIVOT.md` holds the broader product pivot this feeds into).

## What we're deciding

The single best **docs/context retrieval** config for a local-first, in-browser
FFmpeg command planner. **Retrieval feeds an LLM only** (in-browser small model
*or* external big model via copy-paste) — **there is no human-facing docs-search
widget.** That scoping drives every metric choice below.

Corpus is bundled and **pre-embedded at build time**; only the **query** is
embedded at runtime (so a cheap static query encoder is architecturally viable).
Decisions must be **reversible**: swapping model/chunking later is a *rebuild*,
recorded in an index manifest, not a rewrite.

## Corpus (two variants — coverage vs size is its own axis)

- `cli`  — `ffmpeg.html` (the command-line tool reference, ~189 KB)
- `all`  — `ffmpeg-all.html` (everything: codecs, filters, formats, … ~2.5 MB)

Open product question baked into the benchmark: **is `cli` enough, or do we need
`all`?** This is a **coverage** question, not a retrieval-quality one — see metrics.

## Metrics (LLM is the only consumer)

- **recall@k — THE boss metric.** k = chunks placed in the prompt. An LLM reader
  doesn't care about rank order, only that the needed chunk is *present*. Measure
  at **two budgets**: tight (in-browser small model) and generous (external model).
- **nDCG@k — tiebreaker only** (slightly prefer packing answers into fewer chunks
  so a smaller k works). Demoted from "primary"; do not build an elaborate graded
  scale.
- **success@1 — DROPPED.** No human reads a ranked list.
- **Always report bootstrap confidence intervals** on recall — with a small eval
  set, differences are often within noise; CIs stop us crowning noise.
- **Coverage ceiling vs retrieval recall — reported separately per corpus.** Label
  each query "answerable-in-`cli`?". Coverage ceiling = is a correct chunk even
  present (answers "is cli enough"); retrieval recall = of present ones, did we
  find them (answers "is the retriever good").
- **Constraints, not tiebreakers:** model download size, in-RAM index size, peak
  mobile memory, warm latency, and **cold-start measured cache-EVICTED** (the
  common mobile case) including **runtime-init cost (WASM load), not just bytes**.

Report a **Pareto table**, not a single winner. New axis column: `corpus ∈ {cli,all}`.

## Baselines & controls

- **Full-dump floor:** for `cli` (small enough it *might* fit a big window), include
  "paste all headings / whole corpus, no ranking" as row zero. If retrieval can't
  beat it for the external reader, that's a real ship-lexical/ship-dump result.
  (`all` cannot be dumped — retrieval is justified there by construction.)
- **Boring anchor model** (`bge-small-en-v1.5`) in every table for interpretability.
- **Freeze code-aware BM25 config BEFORE running any hybrid** (tune only on the
  lexical bucket) so hybrid gains aren't BM25 over-fit to the eval queries.
- **Anchor × BOTH chunk profiles** (the "#5" control): run the anchor model under
  micro *and* macro chunking to read the chunking main-effect and detect a
  model×chunking interaction the paired design would otherwise hide.

## Candidate configs (config = model + chunking + prefixes + quantization + fusion)

| Tier | Candidates | Role |
|------|-----------|------|
| Lexical floor | code-aware BM25 / MiniSearch / FlexSearch (tuned for symbols) | Floor to beat |
| Static (hypothesized default) | potion-base-32M, potion-retrieval-32M, static-retrieval-mrl-en-v1 | Cheap query encoder |
| Tiny transformer | snowflake-arctic-embed-xs/-s, bge-small-en-v1.5 | Quality upgrade |
| Long-context small | nomic-embed-text-v1.5, jina-embeddings-v2-small-en | Macro chunks, MRL compression |
| Premium (optional, gated) | embeddinggemma-300m, Jina v5 nano, Qwen3-0.6B | Only if browser path proven |

Default to beat: **static (POTION) + code-aware BM25 hybrid.**
Every dense model tested **solo AND +BM25**. Chunking: **paired** profiles
(micro=static, macro=long-context), not a full cross-product.

## Fusion

- **RRF = decision-driver** (scale-free, robust on a tiny eval set).
- **Score-based linear + min-max = observation-only column**, never allowed to win
  on the small set; no aggressive weight tuning (small fixed grid at most).

## Quantization & parity

- **INT8 before Q4** — 4-bit can cause embedding *vector collapse*, far worse for
  retrieval than for generation. Validate the **shipped quantized artifact in a
  real browser**, not FP32-in-Python.
- **Build↔runtime parity = a tiny test suite**: for normal / code-symbol /
  unicode / markdown-code / long queries, assert (a) browser tokenizer emits
  **identical token IDs** to the Python build tokenizer, and (b) **top-k matches**
  (not just cosine≈1). Run parity on the **actual shipped backend on a mobile GPU**
  (`arm/valhall` — this repo has seen WebGPU non-determinism there).

## Eval set (stratified, graded-light, with adversarial buckets)

Hand-written queries with known-correct chunk(s). Started at **40 (provisional)**;
grow only where bootstrap CIs overlap on a decision-relevant comparison.

**Bucket = phrasing STYLE, not lexical-vs-semantic.** Rationale: the target user
knows nothing about ffmpeg flags — they never type `-crf`/`scale=`. So we take
clueless intents and vary the *style*: `neutral` (well-written) / `verbose` /
`terse` / `typo` / `wrong_terms`. This is what actually stresses static-vs-
transformer + typo robustness for this product. (The original exact-symbol/code
buckets were dropped as unrealistic here.)

- **no_answer** queries (ffmpeg can't do it, e.g. "extract the theme") score
  inverted: success = retrieve nothing above threshold + reader abstains.
- Per query: `answerable_in_cli` flag drives the coverage-ceiling split. Mechanic:
  cli has command mechanics (`-ss`/`-t`/`-an`/`-vn`/`-frames:v`) but not
  encoder/filter *names* (libmp3lame/libx264/crop/palettegen) → name-dependent
  intents are `all`-only. **Early result: 27 of 37 real intents are `all`-only.**
- NB: static models subword-tokenize, so expect *graceful degradation* on typos,
  not OOV collapse — measure it.
- **Caveat:** author-written queries may echo the docs and inflate lexical configs;
  mix in genuinely user-sourced phrasings before trusting lexical wins. Thin
  buckets are qualitative at n=40, not statistically powered.

## What gets embedded

**Prepend the heading/anchor breadcrumb** to each chunk body (e.g.
`Filters > Video filters > scale` + body). ffmpeg's texinfo docs are already
deeply hierarchical, so this is nearly free and a large recall win.

## Index manifest (from day one)

Record: model name, **model revision**, chunker version, embedding dimension,
normalization, prefix scheme, corpus id, **docs version + fetch date**. Prevents
silently mixing incompatible cached assets; this is what makes the decision
reversible.

## Not measured here / accepted risks

- **Query-distribution external validity** — our hand-written queries are *our*
  mental model; real users are lazier/messier. Mitigation: log real queries
  post-launch and re-score. (Biggest un-fixable-now risk.)
- Multilingual, thermal throttling, index rebuild cost on doc churn — deferred
  unless the audience demands them.

---

## Phases & progress

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

### Phase 0 — Harness, data, manifest
- [x] Create `bench/` structure + this plan
- [x] Fetch `ffmpeg.html` (cli) and `ffmpeg-all.html` (all) → `corpus/raw/` (reproducible via `scripts/fetch_docs.sh`, provenance + sha256 in `corpus/PROVENANCE.txt`)
- [x] Parse HTML → section-anchored units (breadcrumb + body) → `corpus/parsed/` (`scripts/parse_docs.py`; cli=41 units/~25.6K tok, all=1590 units/~305K tok)
- [x] Index manifest format (`bench/manifest.schema.json` — full contract; per-build manifest emitted in Phase 1 once an embedding model is chosen)
- [x] Chunking strategies (micro / macro) over parsed units (`scripts/chunk_docs.py`, breadcrumb-prefixed; chunked output gitignored, regenerable)
- [x] Stratified eval set (`eval/queries.jsonl`, generated by `eval/build_eval.py`; 40 queries/12 intents). **Bucket = phrasing style** (neutral/verbose/terse/typo/wrong_terms), since the target user never types flags. All target anchors validated against the corpus; coverage flags consistent.
- [ ] Reusable harness: `(config) → recall@k (two budgets) + nDCG + bootstrap CIs` ← **NEXT**
- [ ] Full-dump floor wired as row zero

### Phase 1 — Architecture decision (cheap, paired chunking)
- [ ] BM25-alone (frozen) vs static-alone vs static+BM25 vs one tiny transformer (solo + hybrid)
- [ ] Anchor × both chunk profiles control
- [ ] Decide winning *tier* on the Pareto front; kill losing tiers

### Phase 2 — Model sweep within winning tier
- [ ] Full candidate sweep, correct asymmetric prefixes, solo + hybrid
- [ ] Fusion small fixed grid (RRF driver; min-max observation-only)
- [ ] Quantized artifacts, INT8 first

### Phase 3 — Browser / payload validation
- [ ] Real-browser cold-start (cache-evicted), time-to-first-useful-result, warm latency, mobile memory
- [ ] Build↔runtime parity suite on actual mobile backend
- [ ] Verify optional-premium browser path exists + weight before counting it viable

### Phase 4 — Decision
- [ ] Pick best in-budget config; lock chunking+prefix+quantization+fusion in the manifest

---

## Run log (newest first)

- 2026-06-21 — Built eval set: 40 queries / 12 intents, **stratified by phrasing
  style** (user knows no flags, so style replaces the lexical/symbol buckets).
  Labels defined once per intent (`eval/build_eval.py`), all target anchors
  validated against the corpus, coverage flags consistent. **Coverage result: 27
  of 37 real intents are `all`-only** (only trim/mute/grab-frame mechanics live in
  `cli`) — strong evidence `cli` is NOT enough for this product. Next: the harness.
- 2026-06-21 — Built chunkers (macro/micro) + manifest contract. Chunk counts:
  cli/macro=83, cli/micro=1454, all/macro=1863, **all/micro=21,177** (the last is
  a real in-RAM index-size signal for static models — log as a payload constraint).
  Each chunk's embedded text is breadcrumb-prefixed. **Next: eval set scaffold.**
- 2026-06-21 — Parsed both corpora into section-anchored units. **Early coverage
  finding:** `cli` (41 units, ~25.6K tok — small enough to dump into a big window)
  has the command *mechanics* but **lacks filter/encoder reference detail** —
  `palettegen`/`paletteuse` are entirely absent, so GIF-quality queries hit a hard
  coverage ceiling in `cli`. `all` (1590 units, ~305K tok) covers them. Confirms
  the coverage-vs-retrieval split is real and worth measuring separately.
- 2026-06-21 — Fetched cli (189 KB) + all (2.5 MB) docs; confirmed `all` far
  exceeds any context window (retrieval justified). Built `bench/` + this plan.
