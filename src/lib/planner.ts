import { create, insertMultiple, search, type AnyOrama } from "@orama/orama";
import type { InitProgressReport, MLCEngine } from "@mlc-ai/web-llm";
import {
  argsToCommand,
  type PlannedCommand,
  suggestedOutputName,
} from "./command";
import type { MediaMetadata } from "./media";
import { ffmpegDocChunks, type FfmpegDocChunk } from "./ffmpegDocs";

export interface PlanRequest {
  prompt: string;
  file?: File;
  metadata?: MediaMetadata | null;
  modelId?: string;
  useLocalModel?: boolean;
  onModelProgress?: (report: InitProgressReport) => void;
}

export interface PlanResult extends PlannedCommand {
  source: "webllm" | "fallback";
  commandLine: string;
  docsUsed: FfmpegDocChunk[];
  rawModelOutput?: string;
}

type DocsDb = AnyOrama;

const defaultModelId = "gemma3-1b-it-q4f16_1-MLC";
let docsDbPromise: Promise<DocsDb> | null = null;
let enginePromise: Promise<MLCEngine> | null = null;
let loadedModelId: string | null = null;

export async function searchFfmpegDocs(
  query: string,
  limit = 4,
): Promise<FfmpegDocChunk[]> {
  const db = await getDocsDb();
  const result = await search(db, {
    term: query,
    limit,
    threshold: 0,
    properties: ["title", "section", "summary", "syntax", "tags"],
    boost: {
      title: 2,
      tags: 1.8,
      summary: 1.2,
    },
  });

  return result.hits.map((hit) => hit.document as unknown as FfmpegDocChunk);
}

export async function planCommand(request: PlanRequest): Promise<PlanResult> {
  const docsUsed = await searchFfmpegDocs(
    `${request.prompt} ${request.file?.type ?? ""} ${request.file?.name ?? ""}`,
  );

  if (request.useLocalModel) {
    try {
      const fromModel = await planWithWebLLM(request, docsUsed);
      return fromModel;
    } catch (error) {
      console.warn("[planner] falling back after WebLLM failure", error);
    }
  }

  const fallback = fallbackPlan(request.prompt, request.file, docsUsed);
  return {
    ...fallback,
    source: "fallback",
    commandLine: argsToCommand(fallback.args),
    docsUsed,
  };
}

export async function ensureLocalModel(
  modelId = defaultModelId,
  onProgress?: (report: InitProgressReport) => void,
): Promise<MLCEngine> {
  if (enginePromise && loadedModelId === modelId) {
    return enginePromise;
  }

  loadedModelId = modelId;
  enginePromise = (async () => {
    const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
    return CreateMLCEngine(modelId, {
      initProgressCallback: onProgress,
    });
  })();

  return enginePromise;
}

function getDocsDb(): Promise<DocsDb> {
  if (!docsDbPromise) {
    docsDbPromise = (async () => {
      const db = await create({
        schema: {
          id: "string",
          title: "string",
          section: "string",
          summary: "string",
          syntax: "string",
          url: "string",
          tags: "string[]",
        },
      });

      await insertMultiple(db, ffmpegDocChunks);
      return db;
    })();
  }

  return docsDbPromise;
}

async function planWithWebLLM(
  request: PlanRequest,
  docsUsed: FfmpegDocChunk[],
): Promise<PlanResult> {
  const engine = await ensureLocalModel(
    request.modelId ?? defaultModelId,
    request.onModelProgress,
  );
  const completion = await engine.chat.completions.create({
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(request.metadata, docsUsed),
      },
      {
        role: "user",
        content: request.prompt,
      },
    ],
    temperature: 0.1,
    response_format: { type: "json_object" },
  });
  const raw = completion.choices[0]?.message.content ?? "";
  const parsed = parseModelPlan(raw, request.file);

  return {
    ...parsed,
    source: "webllm",
    commandLine: argsToCommand(parsed.args),
    docsUsed,
    rawModelOutput: raw,
  };
}

function buildSystemPrompt(
  metadata: MediaMetadata | null | undefined,
  docsUsed: FfmpegDocChunk[],
): string {
  return [
    "You are a specialist CLI agent for ffmpeg.wasm inside a browser app named FFmpeg Catalyst.",
    "FFmpeg is the primary tool and must remain visible and credited.",
    "Return only JSON with keys: args (array of strings), explanation (short string), docs (array of doc URLs).",
    "Do not include the literal 'ffmpeg' executable. Use $INPUT for the input file and $OUTPUT for the output file.",
    "Prefer browser-safe codecs: libx264/aac for MP4, libmp3lame for MP3, png/jpeg/webp for images.",
    "Use the provided probe metadata and docs. Do not invent flags.",
    `Probe metadata: ${JSON.stringify(metadata ?? {}, null, 2)}`,
    `Relevant docs: ${JSON.stringify(
      docsUsed.map(({ title, summary, syntax, url }) => ({
        title,
        summary,
        syntax,
        url,
      })),
      null,
      2,
    )}`,
  ].join("\n\n");
}

function parseModelPlan(raw: string, file?: File): PlannedCommand {
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
  const value = JSON.parse(jsonText) as Partial<PlannedCommand> | string[];
  const args = Array.isArray(value) ? value : value.args;

  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("Model did not return an args array.");
  }

  const ensured = ensureOutput(args, file);
  return {
    args: ensured,
    explanation:
      Array.isArray(value) || !value.explanation
        ? "Generated from local Gemma planning with FFmpeg documentation context."
        : value.explanation,
    docs: Array.isArray(value) ? [] : (value.docs ?? []),
  };
}

function fallbackPlan(
  prompt: string,
  file: File | undefined,
  docsUsed: FfmpegDocChunk[],
): PlannedCommand {
  const text = prompt.toLowerCase();
  const name = file?.name ?? "input";
  const docs = docsUsed.map((doc) => doc.url);

  if (
    text.includes("mp3") ||
    text.includes("extract audio") ||
    text.includes("audio only")
  ) {
    return {
      args: [
        "-i",
        "$INPUT",
        "-vn",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "192k",
        outputFor(name, "mp3"),
      ],
      explanation: "Extracts or converts the audio stream to an MP3 file.",
      docs,
    };
  }

  if (text.includes("gif")) {
    return {
      args: [
        "-i",
        "$INPUT",
        "-vf",
        "fps=12,scale=640:-1:flags=lanczos",
        outputFor(name, "gif"),
      ],
      explanation: "Creates a compact GIF using a frame-rate and scale filter.",
      docs,
    };
  }

  if (
    text.includes("thumbnail") ||
    text.includes("poster") ||
    text.includes("frame")
  ) {
    return {
      args: [
        "-ss",
        "00:00:03",
        "-i",
        "$INPUT",
        "-frames:v",
        "1",
        outputFor(name, "jpg"),
      ],
      explanation: "Extracts a single JPEG frame near the start of the file.",
      docs,
    };
  }

  if (
    text.includes("webp") ||
    text.includes("image") ||
    text.includes("resize")
  ) {
    return {
      args: [
        "-i",
        "$INPUT",
        "-vf",
        "scale=1600:-1",
        outputFor(name, text.includes("avif") ? "avif" : "webp"),
      ],
      explanation:
        "Converts or resizes an image using FFmpeg's regular filter pipeline.",
      docs,
    };
  }

  if (text.includes("trim") || text.includes("cut")) {
    return {
      args: [
        "-ss",
        "00:00:10",
        "-i",
        "$INPUT",
        "-t",
        "00:00:20",
        "-c",
        "copy",
        outputFor(name, "mp4"),
      ],
      explanation:
        "Starts with a fast trim template. Adjust the start and duration chips before running.",
      docs,
    };
  }

  return {
    args: [
      "-i",
      "$INPUT",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "24",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outputFor(name, "mp4"),
    ],
    explanation:
      "Compresses to a broadly compatible MP4 using H.264 video and AAC audio.",
    docs,
  };
}

function ensureOutput(args: string[], file?: File): string[] {
  if (args.some((arg) => arg.includes("$OUTPUT") || arg.includes("{output}"))) {
    return args;
  }

  const hasOutput = args.some(
    (arg, index) =>
      index > 0 && !arg.startsWith("-") && args[index - 1] !== "-i",
  );
  if (hasOutput) {
    return args;
  }

  return [...args, outputFor(file?.name ?? "output", "mp4")];
}

function outputFor(fileName: string, extension: string): string {
  return suggestedOutputName(fileName, extension);
}

export { defaultModelId };
