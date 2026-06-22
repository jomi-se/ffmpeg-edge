// Reconstruct the exact RAG-injected prompt (system + raw request + retrieved
// docs) for a few queries, as a single pasteable blob for manual testing in
// Gemini/ChatGPT. Uses the same retriever + k as the benchmark.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { Retriever } from "./retrieval.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const BENCH = path.dirname(HERE);
const K = 8;

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

const readJsonl = (p) => fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const queries = readJsonl(path.join(BENCH, "eval", "queries.jsonl"));
const byId = Object.fromEntries(queries.map((q) => [q.id, q]));

const PICKS = [
  ["1_gif", "gif-neutral-1"],
  ["2_compress", "compress_video-terse-1"],
  ["3_to_mp4", "to_mp4-verbose-1"],
  ["4_slowmo", "speed_video-neutral-1"],
];

const fmtDocs = (docs) => docs.map((d, i) => `### Doc ${i + 1}: ${d.path}\n${d.text}`).join("\n\n");

const retriever = new Retriever({ corpus: "all-glued", profile: "macro" });
const outDir = path.join(HERE, "manual_prompts");
fs.mkdirSync(outDir, { recursive: true });

for (const [name, id] of PICKS) {
  const q = byId[id];
  const docs = await retriever.search(q.text, K);
  const userMsg = `User request: "${q.text}"\n\nRelevant ffmpeg documentation:\n\n${fmtDocs(docs)}\n\nNow give the single ffmpeg command.`;
  const blob =
`# Paste everything below into the chat. (System instructions first, then the request + retrieved docs.)
# Query id: ${id}  |  intent: ${q.intent}  |  retrieved k=${K} (bge-small + BM25 RRF, all-glued corpus)
# Doc sections retrieved: ${docs.map((d) => d.anchor).join(", ")}
# ============================================================================

${SYSTEM}

${userMsg}
`;
  const file = path.join(outDir, `${name}.txt`);
  fs.writeFileSync(file, blob);
  console.log(`wrote ${file}  (${blob.length} chars, ${docs.length} docs)`);
}
