// Generation benchmark: can a small model turn a plain-language media request
// into a correct ffmpeg command, given our retrieval? Two approaches:
//
//   mode=rag   static RAG — retrieve top-k docs once, stuff them in the prompt.
//   mode=tool  agentic — expose search_ffmpeg_docs; the model searches (and may
//              re-search to self-correct) before answering.
//
// Models: Mistral's ministral-3b / ministral-8b via the Vercel AI SDK.
//
// Usage:
//   node gen/gen_bench.mjs --model ministral-3b --mode rag  [--k 8] [--limit N]
//   node gen/gen_bench.mjs --model ministral-8b --mode tool [--steps 5]
// Results merge into gen/results.json; every transcript is saved verbatim.

import { generateText, tool, stepCountIs, jsonSchema } from "ai";
import { createMistral } from "@ai-sdk/mistral";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { Retriever } from "./retrieval.mjs";
import { grade, isCorrect } from "./rubric.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const BENCH = path.dirname(HERE);
const ROOT = path.dirname(BENCH);

// ---- load MISTRAL_API_KEY from repo-root .env (no extra dep) ----
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!process.env.MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY not found in .env");

const MODELS = {
  "ministral-3b": "ministral-3b-latest",
  "ministral-8b": "ministral-8b-latest",
  "ministral-14b": "ministral-14b-latest",
};

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const modelKey = arg("model", "ministral-3b");
const mode = arg("mode", "rag");
const K = +arg("k", 8);
const STEPS = +arg("steps", 5);
const limit = arg("limit", null);
const variant = arg("variant", "v1"); // v1=base prompt, v2=coached tool prompt
if (!MODELS[modelKey]) throw new Error(`unknown model ${modelKey}; have ${Object.keys(MODELS)}`);
if (!["rag", "tool"].includes(mode)) throw new Error(`mode must be rag|tool`);

const mistral = createMistral({ apiKey: process.env.MISTRAL_API_KEY });
const model = mistral(MODELS[modelKey]);

const readJsonl = (p) => fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
let queries = readJsonl(path.join(BENCH, "eval", "queries.jsonl"));
if (limit) queries = queries.slice(0, +limit);

const retriever = new Retriever({ corpus: "all-glued", profile: "macro" });

const SYSTEM = `You are an ffmpeg expert helping non-technical people.
The user describes, in plain language, what they want to do with a media file.
Your job: produce ONE ffmpeg command that accomplishes it.

Rules:
- Use only real ffmpeg flags, encoders and filters. Do not invent options.
- Use input.ext / output.ext as placeholder filenames.
- Reply with a single fenced bash code block containing exactly one ffmpeg command,
  then one short plain-language line explaining what it does.
- If the request is something ffmpeg fundamentally cannot do (e.g. understanding or
  summarizing the *content* of a video), do NOT output a command. Say it is out of
  scope for ffmpeg and stop.`;

// v2: coaches HOW to search our docs and HOW to reason about ffmpeg solutions —
// process and doc taxonomy only, never the per-task answer (that would be leakage).
const SYSTEM_TOOL_V2 = `You are an ffmpeg expert helping non-technical people.
The user describes, in plain language, what they want to do with a media file.
Your job: search the official ffmpeg docs, then produce ONE ffmpeg command.

How the search tool works (use this to search well):
- It does hybrid keyword+semantic search over the real ffmpeg manual and returns
  the most relevant sections, each with its title in [brackets].
- The manual is organized into: command-line Options (e.g. -ss, -t, -an, -b:v),
  Encoders (codecs like the names after -c:v / -c:a), Muxers (output containers /
  file extensions), and Filters (audio & video transforms used in -vf / -af / -filter_complex).

How to search effectively:
- First, decompose the task into the pieces an ffmpeg command needs. Most tasks need
  one or more of: (a) a FILTER for a transform, (b) an ENCODER for the target format,
  (c) a MUXER/container for the output extension, (d) plain Options for trimming or
  stream selection. A format conversion almost always needs BOTH the right encoder
  AND the right container — search for each separately.
- Search by the technical operation or component, not casual words. Issue a separate,
  targeted search for each unknown piece. 2-4 searches is normal; one is rarely enough.
- Before using any flag/encoder/filter, confirm its EXACT name and syntax appears in a
  returned section. Never invent names. If a result lacks what you need, search again
  with different wording. Do NOT repeat an identical search — rephrase instead.

Rules:
- Use only real ffmpeg flags, encoders and filters confirmed by the docs.
- Use input.ext / output.ext as placeholder filenames.
- Reply with a single fenced bash code block containing exactly one ffmpeg command,
  then one short plain-language line explaining what it does.
- If the request is something ffmpeg fundamentally cannot do (e.g. understanding or
  summarizing the *content* of a video), do NOT output a command. Say it is out of
  scope for ffmpeg and stop.`;

// v3 (user-authored): keeps the doc taxonomy + decomposition, but drops the
// prescriptive search-count / "don't repeat" / "technical not casual" rules —
// testing whether the explicit how-to-search/build rules were doing more harm than good.
const SYSTEM_TOOL_V3 = `You are an ffmpeg expert assistant helping people unfamiliar with its options so they can use it effectively.
The user describes, in plain language, what they want to do with a media file.
Your job: figure out how to build the right ffmpeg command that will do what the user wants.

You have a tool to search the ffmpeg full official docs. How the search tool works (use this to search well):
- It does hybrid keyword+semantic search over the real ffmpeg manual and returns
  the most relevant sections, each with its title in [brackets].
- The manual is organized into: command-line Options (e.g. -ss, -t, -an, -b:v),
  Encoders (codecs like the names after -c:v / -c:a), Muxers (output containers /
  file extensions), and Filters (audio & video transforms used in -vf / -af / -filter_complex).

How to search effectively:
- First, decompose the task into the pieces an ffmpeg command needs. Most tasks need
  one or more of: (a) a FILTER for a transform, (b) an ENCODER for the target format,
  (c) a MUXER/container for the output extension, (d) plain Options for trimming or
  stream selection. A format conversion almost always needs BOTH the right encoder
  AND the right container. The docs for these might be separate and need multiple searches.
- Before using any flag/encoder/filter, confirm its name and syntax with the docs.

Rules:
- Use input.ext / output.ext as placeholder filenames.
- Reply with a single fenced bash code block containing exactly one ffmpeg command,
  then one short plain-language line explaining what it does.
- If the request is something ffmpeg fundamentally cannot do (e.g. understanding or
  summarizing the *content* of a video), do NOT output a command. Say it is out of
  scope for ffmpeg and stop.`;

const TOOL_PROMPTS = { v2: SYSTEM_TOOL_V2, v3: SYSTEM_TOOL_V3 };
const systemFor = () => (mode === "tool" && TOOL_PROMPTS[variant]) || SYSTEM;

const fmtDocs = (docs) =>
  docs.map((d, i) => `### Doc ${i + 1}: ${d.path}\n${d.text}`).join("\n\n");

const SEARCH_K = 5;          // chunks returned per search call
const SEARCH_CHARS = 3200;  // > longest macro chunk (3014) ⇒ full chunks, parity with RAG
// Built per query so the search log is local — safe under concurrency.
const makeSearchTool = (localLog) => tool({
  description:
    "Search the official ffmpeg documentation for flags, encoders, muxers and filters. " +
    "Call this before answering, and again if the first results don't cover what you need. " +
    "Returns the most relevant documentation sections.",
  inputSchema: jsonSchema({
    type: "object",
    properties: {
      query: { type: "string", description: "what to look up, e.g. 'convert audio to mp3 encoder' or 'crop filter'" },
    },
    required: ["query"],
  }),
  execute: async ({ query }) => {
    const docs = await retriever.search(query, SEARCH_K);
    localLog.push(query);
    return docs.map((d) => `[${d.path}]\n${d.text.slice(0, SEARCH_CHARS)}`).join("\n\n---\n\n");
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Read a Retry-After hint (seconds, or *-ms) from whichever layer carries headers.
function retryAfterMs(e) {
  const h = e?.responseHeaders || e?.cause?.responseHeaders || e?.data?.responseHeaders;
  if (!h) return null;
  if (h["retry-after-ms"]) return Number(h["retry-after-ms"]) || null;
  if (h["retry-after"]) { const n = Number(h["retry-after"]); return Number.isFinite(n) ? n * 1000 : null; }
  return null;
}
// Outer safety net on top of the SDK's own retries: honor Retry-After, else
// exponential backoff with jitter. Gentle enough for a free-tier key.
async function callWithRetry(opts, tries = 6) {
  for (let attempt = 1; ; attempt++) {
    try { return await generateText({ maxRetries: 4, ...opts }); }
    catch (e) {
      const is429 = e?.statusCode === 429 || /429|rate|capacity|quota/i.test(String(e?.message || e));
      const retryable = is429 || /timeout|503|500|overloaded|ECONNRESET|fetch failed/i.test(String(e?.message || e));
      if (!retryable || attempt >= tries) throw e;
      const wait = retryAfterMs(e) ?? Math.min(30000, 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      process.stderr.write(`  retry ${attempt}/${tries} after ${wait}ms (${String(e.message).slice(0, 50)})\n`);
      await sleep(wait);
    }
  }
}


async function runOne(q) {
  const localLog = [];
  let result, retrievedPaths = [];
  if (mode === "rag") {
    const docs = await retriever.search(q.text, K);
    retrievedPaths = docs.map((d) => d.path);
    result = await callWithRetry({
      model, system: systemFor(), temperature: 0,
      prompt: `User request: "${q.text}"\n\nRelevant ffmpeg documentation:\n\n${fmtDocs(docs)}\n\nNow give the single ffmpeg command.`,
    });
  } else {
    result = await callWithRetry({
      model, system: systemFor(), temperature: 0,
      tools: { search_ffmpeg_docs: makeSearchTool(localLog) },
      stopWhen: stepCountIs(STEPS),
      prompt: `User request: "${q.text}"\n\nSearch the ffmpeg docs as needed, then give the single ffmpeg command.`,
    });
    retrievedPaths = [...localLog];
  }
  const g = grade({ text: result.text, intent: q.intent, no_answer: q.no_answer });
  // totalUsage = aggregate over all tool steps; usage = last step only.
  const tu = result.totalUsage ?? result.usage ?? null;
  return {
    id: q.id, intent: q.intent, style: q.style, no_answer: !!q.no_answer,
    request: q.text, output: result.text, command: g.command, verdict: g.verdict,
    nSteps: result.steps?.length ?? 1,
    nSearches: mode === "tool" ? localLog.length : 1,
    searches: mode === "tool" ? [...localLog] : retrievedPaths,
    tokensIn: tu?.inputTokens ?? null, tokensOut: tu?.outputTokens ?? null,
    tokensTotal: tu?.totalTokens ?? null,
  };
}

const CONC = +arg("concurrency", 2); // requests in flight; keep low for free-tier keys
console.log(`\nmodel=${modelKey} (${MODELS[modelKey]})  mode=${mode}  variant=${variant}  k=${K}  conc=${CONC}  queries=${queries.length}`);
const records = new Array(queries.length);
let next = 0;
async function worker() {
  while (true) {
    const i = next++;
    if (i >= queries.length) return;
    const q = queries[i];
    try {
      const r = await runOne(q);
      records[i] = r;
      const mark = isCorrect(r.verdict) ? "✓" : "✗";
      process.stdout.write(`  ${mark} ${r.id.padEnd(26)} ${r.verdict.padEnd(12)} ${(mode === "tool" ? `${r.nSearches} search` : "").padEnd(9)} ${r.command.slice(0, 70)}\n`);
    } catch (e) {
      process.stderr.write(`  ! ${q.id} failed: ${e.message}\n`);
      records[i] = { id: q.id, intent: q.intent, style: q.style, no_answer: !!q.no_answer, request: q.text, error: String(e.message || e), verdict: "error" };
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, queries.length) }, worker));

// ---- summary ----
const real = records.filter((r) => !r.no_answer);
const noAns = records.filter((r) => r.no_answer);
const correct = real.filter((r) => isCorrect(r.verdict)).length;
const good = real.filter((r) => r.verdict === "good").length;
const abstained = noAns.filter((r) => r.verdict === "abstain_ok").length;
const pct = (n, d) => d ? (100 * n / d).toFixed(0) + "%" : "n/a";
const graded = records.filter((r) => r.verdict !== "error");
const sum = (f) => graded.reduce((a, r) => a + (f(r) || 0), 0);
const tokIn = sum((r) => r.tokensIn), tokOut = sum((r) => r.tokensOut), tokTot = sum((r) => r.tokensTotal);
const tokens = { in: tokIn, out: tokOut, total: tokTot, perQuery: graded.length ? Math.round(tokTot / graded.length) : 0 };
console.log(`\n── ${modelKey} / ${mode} / ${variant} ──`);
console.log(`correct command: ${correct}/${real.length} (${pct(correct, real.length)})   of which high-quality: ${good}`);
console.log(`abstained on no-answer: ${abstained}/${noAns.length}`);
const avgS = real.reduce((a, r) => a + (r.nSearches || 0), 0) / Math.max(1, real.length);
if (mode === "tool") console.log(`avg searches/query: ${avgS.toFixed(2)}`);
console.log(`tokens: total=${tokTot}  in=${tokIn}  out=${tokOut}  (~${tokens.perQuery}/query)`);

// per-style
const styles = [...new Set(real.map((r) => r.style))];
console.log(`\nper-style correct:`);
for (const s of styles) {
  const rs = real.filter((r) => r.style === s);
  console.log(`  ${s.padEnd(13)} ${pct(rs.filter((r) => isCorrect(r.verdict)).length, rs.length)} (${rs.length})`);
}

// merge into results.json
const outPath = path.join(HERE, "results.json");
const all = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : { runs: {} };
const runKey = variant === "v1" ? `${modelKey}__${mode}` : `${modelKey}__${mode}__${variant}`;
all.runs[runKey] = {
  model: modelKey, modelId: MODELS[modelKey], mode, variant, k: K, steps: STEPS,
  updated: new Date().toISOString(),
  summary: { real: real.length, correct, good, noAns: noAns.length, abstained, avgSearches: +avgS.toFixed(2), tokens },
  records,
};
fs.writeFileSync(outPath, JSON.stringify(all, null, 2));
console.log(`\n-> gen/results.json (${Object.keys(all.runs).length} runs)`);
