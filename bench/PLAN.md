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
- [x] Reusable harness (`scripts/harness.py`): `(corpus×profile×method) → recall@k (k=5/20) + nDCG + bootstrap 95% CIs + coverage split + no_answer top-1 scores`. Results → `results/`.
- [x] Full-dump floor wired as row zero (recall = coverage ceiling + token-budget feasibility)

**Phase 0 COMPLETE.** ✅ Floor established (BM25 + full-dump). See run log for findings.

### Phase 1 — Architecture decision (cheap, paired chunking)

> **DECISION (2026-06-21): embed in JS, not Python.** The shipped query encoder
> runs in the browser, so build-time embedding uses **Node + transformers.js**
> (same ONNX model + same JS tokenizer at build via `onnxruntime-node` and at
> runtime via `onnxruntime-web`). This makes build↔runtime parity nearly free and
> demotes the parity test-suite from load-bearing to a sanity check. Python is
> kept ONLY for the language-agnostic data prep (parse/chunk/eval/BM25 floor —
> zero parity stakes). Static/POTION, if not natively loadable, gets a ~30-line JS
> encoder (lookup+mean-pool) — the same code that ships.

- [x] Node + transformers.js embedding harness (`scripts/embed_bench.mjs`) — dense retrieval, recall@k + CIs, embedding cache. First model: `bge-small` (anchor).
- [ ] Freeze BM25 config (done as floor — lock it before hybrids) ← carry forward
- [x] RRF hybrid (dense + BM25) in the JS harness — **best config so far: all/macro recall@20 = 0.51** (vs 0.41 dense, 0.32 BM25)
- [x] Per-style recall breakdown — **wrong_terms: BM25=0.00, dense=0.38** (the case for embeddings in one cell). Hybrid *hurts* on wrong_terms (0.25<0.38: RRF dilutes with BM25's zero signal). terse favors lexical, verbose favors dense.
- [x] static POTION (alone + hybrid) — JS lookup encoder (safetensors + bge tokenizer). all/macro: potion 0.19/0.35, potion+bm25 0.19/**0.41** — trails bge+bm25 (0.51). Captures wrong_terms semantics (0.38, =bge). **Payload caveat: potion fp32 = 124 MB, NOT smaller than bge fp32; static's edge is runtime, separable only after quantization.**
- [x] **Examples-glued corpus (`all-glued`)** — merge each filter's Examples into its parent (`scripts/glue_examples.py`, 257 merged). **Biggest lever yet:** bge+bm25 recall@5/@20 = **0.46/0.70** (was 0.30/0.51 on `all`). Every style rose; hybrid-hurts-wrong_terms bug healed. **New leader. Make `all-glued` the default corpus.**
- [x] Miss analysis on glued (per-intent + miss list). Residual gaps are TWO things, not "encoders": (a) **to_mp4 = 0.00** (doc has no "make an mp4" recipe AND eval target was mislabeled to the demuxer `mov_002fmp4_002f3gp` — FIX the label), (b) **terse/short queries** dominate the rest (query-side starvation → needs query expansion). gif & thumb_video = 1.00; compress = 0.60 (not the zero predicted).
- [x] POTION on glued: 0.41/0.57 (revived from 0.19/0.35 but still trails bge 0.46/0.68). **Hybrid barely helps on glued** (bge 0.68→0.70; potion+bm25 0.54 < potion 0.57). **POTION abstains better** (na/ans cos gap 0.30/0.42 vs bge 0.61/0.65).
- [x] FIXED eval label: to_mp4 now targets the mp4 **muxer** (`MOV_002fMPEG_002d4_002fISOMBFF-muxers`). Effect: to_mp4 0.00→1.00 (bm25/hybrid; bge-solo still 0.00 — "convert to mp4" doesn't match the muxer page semantically, **BM25 carries it**). **Leader: bge+bm25 = 0.49/0.78** (was 0.46/0.70). Correction: BM25 is NOT redundant — it rescues to_mp4.
- [x] INT8 quantization: **POTION int8 = zero collapse** (0.43/0.59 = fp32). **bge int8 costs ~8 pts @20** (0.78→0.70; not collapse — fp16 likely better). Even so, **bge+bm25 int8 (0.70) > POTION+bm25 int8 (0.59) at the same ~32 MB** → static's payload edge evaporates once quantized.

**PHASE 1 VERDICT:** winner = **bge-small + BM25 (RRF) on Examples-glued macro** — ~0.78@20 fp32, ~0.70@20 int8. BM25 stays (rescues to_mp4). POTION is the fallback only if runtime/no-GPU/abstain matters more than ~11 recall points.
- [x] Speed + payload now measured (load, query ms/text [runtime], manual ms/chunk [build-time], model size). **POTION query-encode ~0.5ms vs bge 17–44ms (~30–80×); manual ~1ms vs ~400–600ms/chunk (~300×)** — but manual is build-time (shipped precomputed), so static's edge is mostly offline; runtime query cost is "instant vs fine".
- [x] **Q4 tested: not worth it.** bge q4 = same recall as q8 (0.49/0.70) but BIGGER (61MB vs 34) and SLOWER (43ms vs 17ms) — transformers.js q4 dequant overhead. **int8 strictly dominates q4.**
- [x] HTML report (`scripts/make_report.py` → `results/report.html`): mobile-first, self-contained, methods glossary + all tables/breakdowns.
- [ ] dense on `micro` profile (low priority — content beat chunk-size)
- [ ] query expansion for terse/short queries (the other residual gap)
- [ ] Anchor × both chunk profiles control
- [ ] Decide winning *tier* on the Pareto front; kill losing tiers
- NB target to beat on `all`: BM25 recall@5=0.22 / recall@20=0.32 (macro), 0.16 / 0.43 (micro)

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

- 2026-06-22 — **CONTROL: Gemini Flash Lite WITHOUT rag (no docs).** Same 4 prompts,
  docs removed. **3/4 byte-identical to the RAG outputs** (gif, to_mp4, slowmo) — the
  capable model already knows ffmpeg for common tasks; RAG added nothing. **The
  compress case FLIPPED: no-RAG was BETTER.** With junk RAG docs it answered
  `scale=iw/2:ih/2` (fail); with no docs it answered `libx265 -crf 28` (correct).
  ⇒ **Bad retrieval is worse than no retrieval** — junk context pulled a capable
  model away from the right answer it already had. Implications: (1) RAG's value is
  concentrated in SMALL/local models (which we're removing); for a capable BYO model,
  common conversions need no RAG. (2) If we feed docs to a capable model, gate on
  relevance — inject nothing rather than junk (a relevance threshold would have saved
  compress). (3) Shifts pivot value toward recipes UI + ffmpeg.wasm, with "paste into
  your own AI" as a light helper. CAVEAT: 1 model × 4 EASY tasks. Open follow-up: test
  OBSCURE ops the model likely doesn't know — the only place RAG could still pay for
  a big model. Prompts: gen/build_manual_prompts.mjs now emits *_norag.txt controls.

- 2026-06-22 — **Anecdote: RAG prompts pasted into Gemini Flash Lite (BYO-model
  path).** Hand-tested 4 RAG-injected prompts (gen/build_manual_prompts.mjs, k=8)
  in **Gemini Flash Lite** (Google's cheapest tier). 3/4 correct AND higher quality
  than our local 8B: to_mp4 → `libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart`
  (compatibility polish we never saw locally); gif → single-graph `split…palettegen…
  paletteuse` (canonical form); slowmo → `setpts=2.0*PTS` + `atempo=0.5` (audio-synced).
  The one miss = `compress` ("shrink this video") → `scale=iw/2:ih/2`, NO -crf — the
  exact same miss as local 8B/14B, on the same weak-retrieval (junk docs) query.
  Read: (1) the copy-paste-into-your-own-AI path is strong — even a budget cloud
  model beats shipping a local model; (2) the residual hard case is intent
  AMBIGUITY ("shrink"=smaller file vs lower res), a UI/disambiguation problem, not
  retrieval or model size. n=1 model × 4 prompts — anecdotal, directional only.

- 2026-06-22 — **Why does RAG win? k-sweep + hybrid (raw-first + refine).** Two
  hypotheses for RAG > tool: (H2) RAG just feeds more chunks; (H1) searching with
  the user's RAW words beats the model's paraphrased queries. **H2 rejected** —
  RAG saturates at k=5: 8b k3/5/8/12 = 81/92/89/89, 14b = 84/89/92/89 (flat plateau
  from k=5; quantity isn't the lever, recall is the ceiling). **H1 supported** via
  new `hybrid` mode (seed with raw-prompt retrieval like RAG, THEN give the tool to
  refine): 8b hybrid = 89% with only 0.35 extra searches (8/37) — i.e. seeded with
  the raw-prompt docs it stops searching and matches RAG; refining adds nothing.
  14b hybrid = 81% but with 3.68 extra searches (34/37!) — it can't stop searching
  even holding the right docs, and that DROPS it below RAG (92) and pure tool-v3 (89).
  **Conclusion: RAG wins because raw-prompt retrieval is a better query than model
  paraphrase; the model's contribution to retrieval is neutral (8b) to negative
  (14b over-searches).** Cost seals it: RAG k=5 ~1.7k tok/q vs 14b hybrid ~14.8k (9x).
  Product call stands: **RAG (raw prompt, k=5-8), no agentic retrieval.**

- 2026-06-22 — **Prompt v3 (lighter coaching) + rate-limit hardening.** User
  rewrote the coached prompt: kept the doc taxonomy + decomposition hint, DROPPED
  the prescriptive rules (2-4 searches / don't-repeat / technical-not-casual).
  Hypothesis: the explicit how-to-search rules were doing more harm than good.
  **Confirmed.** Tool correct (mean of repeats): **14b v3 = 89/89/89% (stable!)**
  vs v2 62% and v1fair 76% — v3 ties RAG-level (92%). **8b v3 = 78/86/84% (mean 83)**
  ≈ v1fair (~86) ≈ RAG (89), i.e. v3 neither helps nor hurts 8b (the 78 was a low
  outlier). **3b v3 = 70%**, same plateau across every prompt and mode. v3 also
  cheaper than v2 (14b 7.2k vs 10.9k tok/q). Takeaways: (1) light-touch coaching
  >> prescriptive; over-specifying search tactics derails the model. (2) 14b is the
  size where good-prompt tool-use becomes viable (stable 89%, self-correcting).
  (3) RAG still ≥ tool everywhere but the gap is now small for 14b (92 vs 89).
  (4) prompt engineering cannot lift 3b off ~70%. Also hardened callWithRetry
  (honors Retry-After, exp backoff+jitter, 6 tries over SDK's 4) and dropped
  default concurrency to 2 for free-tier keys — the v3 runs dropped 0 cells (vs
  the 2 lost 14b to_mp4 cells at concurrency 5).

- 2026-06-22 — **Tool coaching (v2) + fairness fix + tokens + variance check.**
  Found the tool returned 5 chunks truncated to 700 chars while RAG sent 8 FULL
  chunks (median chunk 738c, p90 2075c → ~half were clipped, often the glued
  Examples). Fixed tool to return full chunks (parity). Added aggregate token
  logging (`totalUsage`, not last-step) + a concurrency pool (per-query search log).
  Coached prompt v2 (teaches doc taxonomy: Options/Encoders/Muxers/Filters, and
  "decompose → search each piece → verify exact names → don't repeat searches").
  **Result: coaching reliably ~doubled searches (3b 1.0→2.1, 8b 1.4→2.5, 14b
  2.2→3.1) and ~doubled tokens, but did NOT raise accuracy** — 8b ~86%→73%, 14b
  76%→~66%, 3b 62%→70% (within noise). **Variance check** (same cell ×3): 8b tool
  v1fair = 89/86/84%; so run-to-run ≈ ±3–5pt ON TOP of the n=37 sampling CI (±~14pt).
  **Verdict: RAG (8 full chunks, 1 call) is the stable winner** — 3b 70 / 8b 89 /
  14b 92%, ~2.7k tok/q — beating tool on accuracy, cost, latency AND variance.
  Coaching the *search strategy* did not unlock small models; the bottleneck is
  synthesis, not retrieval strategy. **Corrects the prior "tool catches up at 14b"**
  — that 89% was a noisy high; full-chunk repeats land 76%.

- 2026-06-22 — **+ ministral-14b.** Added 14b to the gen matrix: **89% correct in
  BOTH rag and tool** (33/37), abstain 3/3. Key: at 14b the tool path no longer
  hurts (it used **2.5 searches/query** vs 1.2–1.5 for 3b/8b and self-corrected
  cleanly) — so "static RAG > tool" was a *small-model* effect, not a general one.
  Size ladder (rag correct): 3b 76% → 8b 86% → 14b 89% (diminishing returns past
  8b; 8b still the value pick). 14b fixed trim_audio-terse + thumb_video-verbose.

- 2026-06-22 — **Generation experiment (gen/).** Wired ministral-3b / ministral-8b
  via the Vercel AI SDK against our retrieval (bge+bm25 RRF, all-glued macro), two
  ways: `mode=rag` (top-k=8 stuffed once) vs `mode=tool` (model drives a
  `search_ffmpeg_docs` tool, ≤5 steps). 40 queries, temp 0, auto-graded by a
  per-intent flag rubric (`gen/rubric.mjs`) + saved transcripts (`gen/results.json`).
  **Correct-command rate: 3b/rag 76%, 8b/rag 86%, 3b/tool 73%, 8b/tool 81%.**
  No-answer abstention near-perfect (mostly 3/3). Findings: (1) **static RAG ≥ tool**
  for these — the tool path gave the small 3b room to wander (gif 2/5→0/5 with odd
  filtergraphs) and averaged only 1.2–1.5 searches; (2) 8b > 3b on hard phrasings
  (wrong_terms 7/8 vs 4/8 in rag); (3) failures cluster on `wrong_terms`/`terse`,
  same leak buckets as retrieval. **Rubric caveat:** undercounts valid `atrim=`
  (trim) and `volume=0` (mute) — real correctness a few points higher. Verdict:
  for one-shot command generation, static RAG + 8b is the sweet spot; tool-calling
  did not pay for its extra calls at this model size. Next: user's call.

- 2026-06-22 — **Label fix + INT8.** Fixed to_mp4 target (demuxer→muxer): to_mp4
  0.00→1.00 (bm25/hybrid; bge-solo still 0.00 — BM25 carries it), lifting the
  leader bge+bm25 to **0.49/0.78** and confirming BM25 is NOT redundant. INT8:
  POTION lossless (0.43/0.59), bge loses ~8 pts @20 (0.78→0.70, fp16 likely
  better). At equal ~32 MB int8 payload, bge+bm25 (0.70) > potion+bm25 (0.59).
  **Phase 1 winner: bge-small + BM25 (RRF) on Examples-glued.** Static stays a
  fallback (no-GPU runtime + better abstain separation, ~11 pts cheaper on recall).
- 2026-06-22 — **Miss analysis + POTION on glued.** Per-intent recall@20 (hybrid):
  gif 1.00, thumb_video 1.00, mp3 0.80, crop 0.75, trim/mute/speed 0.67, compress
  0.60, thumb_image 0.50, **to_mp4 0.00**. Residual gaps are (a) to_mp4 (no
  "make mp4" recipe + Bmo's eval target was the demuxer, not muxer — needs fixing)
  and (b) terse/short queries (query-side). POTION/glued = 0.41/0.57 (revived but
  still < bge 0.46/0.68). **Hybrid's value shrank on glued** (rich chunks do the
  work; potion+bm25 even < potion). **POTION separates no_answer better** (cos gap
  0.12 vs bge 0.04) → static is the better abstain encoder. Phase-1 leaning:
  bge-small dense on Examples-glued (~0.70@20); BM25 now optional; static is the
  cheaper/abstain-friendlier alternative pending Phase-3 payload.
- 2026-06-21 — **Examples-glued = biggest win yet.** Merging each filter's
  Examples subsection into its parent chunk (surfacing the runnable recipes +
  goal vocab like "gif"/"output.gif") lifted bge+bm25 recall@5/@20 from 0.30/0.51
  (`all`) to **0.46/0.70** (`all-glued`). bm25 alone 0.32/0.51; bge alone 0.46/0.68.
  Per-style all up (neutral 0.40→0.80, verbose 0.50→0.83, wrong_terms 0.38→0.50);
  the RRF-hurts-wrong_terms problem healed (BM25 no longer zero-signal). terse
  still stuck at 0.57 (short queries starve retrieval — orthogonal problem).
  Conclusion: **chunk CONTENT > model choice or chunk SIZE.** Confirms the
  hard-ceiling was largely self-inflicted; recipes exist in ffmpeg Examples.
  Caveat: encoders (libx264/compress) have no Examples → likely the residual miss.
- 2026-06-21 — **Hard-ceiling investigation (3 subagent "BMO" reviews + spot
  checks).** Verdict on whether ffmpeg docs can ANSWER user goals:
  - Main reference pages are pure reference, NOT goal-oriented. "make a gif" = NO
    (ingredients named, but no split/-filter_complex/[labels]/scale syntax/recipe);
    "compress" = NO (**`-crf` never even mentioned** on the libx264 page); "trim a
    section" = YES, but only because Main options *contains worked examples*.
  - **KEY FINDING:** the answers DO exist — in each filter's **Examples
    subsection** (e.g. `Examples-152` palettegen, `Examples-153` paletteuse:
    "encode a GIF", `Examples-175` thumbnail: a complete recipe). Our chunker split
    these into separate units and the eval targets the MAIN page, not the Examples.
    So the ≤0.51 recall ceiling is partly self-inflicted by mis-targeting.
  - **Implication / next levers (bigger than model choice):** (a) glue each
    filter's Examples onto its parent chunk; (b) add `Examples-*` anchors as valid
    eval targets. Caveats: gif Examples are 2-pass/no-resize (suboptimal), and
    encoders (libx264) have NO Examples → "compress" may stay genuinely hard.
    This reframes Phase 1: chunking/targeting may matter more than the embedder.


- 2026-06-21 — **Phase 1 static (POTION, model2vec, JS lookup encoder):** all/macro
  potion 0.19/0.35, potion+bm25 0.19/**0.41** — trails bge+bm25 (0.51). Static
  captures the wrong_terms semantic rescue (0.38 = bge) so it's not lexical-dumb,
  but lower ceiling overall. **Reality check: potion-retrieval-32M fp32 = 124 MB,
  ~same as bge-small fp32** — static's advantage is RUNTIME (instant table-lookup,
  no GPU/forward pass), separable only after quantization (Phase 2). Current
  leader: **bge-small + BM25 hybrid, 0.51@20.** Static earns its slot only if
  Phase 3 cold-start/runtime wins justify ~10 recall points.
- 2026-06-21 — **Per-style breakdown (recall@20, all/macro):** the eval design
  pays off. wrong_terms: bm25 **0.00** / bge 0.38 / hybrid 0.25 — pure lexical
  collapses on layperson vocabulary; dense rescues it; **but RRF hybrid HURTS here**
  (dilutes dense with BM25's zero signal) → naive fusion isn't always safe. terse
  favors lexical (0.43>0.29, short queries starve the encoder); verbose favors
  dense (0.50>0.17). Implication: fusion may need to be query-adaptive, or we lean
  dense for this product. Small n/style → qualitative, but bm25=0.00 is stark.
- 2026-06-21 — **Phase 1 hybrid (RRF, bge-small+BM25):** all/macro recall@5/@20 =
  **0.30/0.51** — clearly beats dense (0.41) and BM25 (0.32) at generous-k; best
  config yet. cli still capped at 0.27 (hybrid can't beat coverage). Abstain
  threshold looks unreliable: answerable cos median 0.66 vs no_answer 0.60 (too
  close; only 3 no_answer queries though). Still ~half the answers missed at @20 →
  try micro chunks + static, and break down by style to see WHERE it fails.
- 2026-06-21 — **Phase 1 dense (bge-small fp32, JS/transformers.js):** all/macro
  recall@5/@20 = **0.30/0.41** (vs BM25 0.22/0.32) — dense beats lexical but
  modestly, CIs overlap, and both sit far below the 1.00 ceiling (ffmpeg filter
  docs are terse/hard). cli/bge = 0.22/0.27 → hits the 0.27 ceiling like BM25
  (corpus is the wall, not the method). Notable: **BM25-micro@20=0.43 ≈ dense-
  macro@20=0.41** → chunking interacts as strongly as model choice. no_answer
  top-1 cosine median ~0.60 (need answerable top-1 to set an abstain threshold).
  Crux is the hybrid. Switched build to JS (parity ≈ free) — see decision above.
- 2026-06-21 — **Phase 0 done.** Harness + floor results (37 real / 3 no_answer):
  - `cli`: coverage **0.27** and BM25 already hits it (0.27) → retrieval isn't the
    limit, the corpus is. Even full-dump of cli (20.7K tok, fits a generous window)
    = 0.27. **`cli` is definitively NOT enough.**
  - `all`: full-dump = recall 1.00 but 252K tok (**fits no budget**) → retrieval
    mandatory. BM25 alone is **weak**: recall@5/@20 = 0.22/0.32 (macro), 0.16/0.43
    (micro). That gap to 1.00 is the headroom embeddings must justify in Phase 1.
  - Chunking: micro hurts tight-k, helps generous-k. no_answer BM25 top-1 median
    score ~12 (vs ~5–8 for answerable on cli) → an abstain threshold is plausible.
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
