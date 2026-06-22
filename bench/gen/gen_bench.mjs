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
};

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const modelKey = arg("model", "ministral-3b");
const mode = arg("mode", "rag");
const K = +arg("k", 8);
const STEPS = +arg("steps", 5);
const limit = arg("limit", null);
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

const fmtDocs = (docs) =>
  docs.map((d, i) => `### Doc ${i + 1}: ${d.path}\n${d.text}`).join("\n\n");

const searchTool = tool({
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
    const docs = await retriever.search(query, 5);
    searchLog.push(query);
    return docs.map((d) => `[${d.path}]\n${d.text.slice(0, 700)}`).join("\n\n---\n\n");
  },
});

let searchLog = [];

async function callWithRetry(opts, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try { return await generateText(opts); }
    catch (e) {
      const retryable = /429|rate|capacity|timeout|503|500|overloaded/i.test(String(e?.message || e));
      if (!retryable || attempt >= tries) throw e;
      const wait = 1500 * attempt;
      process.stderr.write(`  retry ${attempt} after ${wait}ms (${e.message?.slice(0, 60)})\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOne(q) {
  searchLog = [];
  let result, retrievedPaths = [];
  if (mode === "rag") {
    const docs = await retriever.search(q.text, K);
    retrievedPaths = docs.map((d) => d.path);
    result = await callWithRetry({
      model, system: SYSTEM, temperature: 0,
      prompt: `User request: "${q.text}"\n\nRelevant ffmpeg documentation:\n\n${fmtDocs(docs)}\n\nNow give the single ffmpeg command.`,
    });
  } else {
    result = await callWithRetry({
      model, system: SYSTEM, temperature: 0,
      tools: { search_ffmpeg_docs: searchTool },
      stopWhen: stepCountIs(STEPS),
      prompt: `User request: "${q.text}"\n\nSearch the ffmpeg docs as needed, then give the single ffmpeg command.`,
    });
    retrievedPaths = [...searchLog];
  }
  const g = grade({ text: result.text, intent: q.intent, no_answer: q.no_answer });
  return {
    id: q.id, intent: q.intent, style: q.style, no_answer: !!q.no_answer,
    request: q.text, output: result.text, command: g.command, verdict: g.verdict,
    nSteps: result.steps?.length ?? 1,
    nSearches: mode === "tool" ? searchLog.length : 1,
    searches: mode === "tool" ? [...searchLog] : retrievedPaths,
    usage: result.usage ?? null,
  };
}

console.log(`\nmodel=${modelKey} (${MODELS[modelKey]})  mode=${mode}  k=${K}  queries=${queries.length}`);
const records = [];
for (const q of queries) {
  try {
    const r = await runOne(q);
    records.push(r);
    const mark = isCorrect(r.verdict) ? "✓" : "✗";
    process.stdout.write(`  ${mark} ${r.id.padEnd(26)} ${r.verdict.padEnd(12)} ${(mode === "tool" ? `${r.nSearches} search` : "").padEnd(9)} ${r.command.slice(0, 70)}\n`);
  } catch (e) {
    process.stderr.write(`  ! ${q.id} failed: ${e.message}\n`);
    records.push({ id: q.id, intent: q.intent, style: q.style, no_answer: !!q.no_answer, request: q.text, error: String(e.message || e), verdict: "error" });
  }
  await sleep(400); // gentle on the rate limiter
}

// ---- summary ----
const real = records.filter((r) => !r.no_answer);
const noAns = records.filter((r) => r.no_answer);
const correct = real.filter((r) => isCorrect(r.verdict)).length;
const good = real.filter((r) => r.verdict === "good").length;
const abstained = noAns.filter((r) => r.verdict === "abstain_ok").length;
const pct = (n, d) => d ? (100 * n / d).toFixed(0) + "%" : "n/a";
console.log(`\n── ${modelKey} / ${mode} ──`);
console.log(`correct command: ${correct}/${real.length} (${pct(correct, real.length)})   of which high-quality: ${good}`);
console.log(`abstained on no-answer: ${abstained}/${noAns.length}`);
if (mode === "tool") {
  const avgS = real.reduce((a, r) => a + (r.nSearches || 0), 0) / Math.max(1, real.length);
  console.log(`avg searches/query: ${avgS.toFixed(1)}`);
}

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
all.runs[`${modelKey}__${mode}`] = {
  model: modelKey, modelId: MODELS[modelKey], mode, k: K, steps: STEPS,
  updated: new Date().toISOString(),
  summary: { real: real.length, correct, good, noAns: noAns.length, abstained },
  records,
};
fs.writeFileSync(outPath, JSON.stringify(all, null, 2));
console.log(`\n-> gen/results.json (${Object.keys(all.runs).length} runs)`);
