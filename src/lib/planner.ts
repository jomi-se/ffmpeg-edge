import { create, insertMultiple, search, type AnyOrama } from "@orama/orama";
import type { AppConfig, InitProgressReport, MLCEngine } from "@mlc-ai/web-llm";
import {
  argsToCommand,
  ensureCommandOutput,
  parseCommandLine,
  type PlannedCommand,
  suggestedOutputName,
  validateCommandArgs,
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
  warning?: string;
}

type DocsDb = AnyOrama;

const gemma4E2BRepo =
  "https://huggingface.co/welcoma/gemma-4-E2B-it-q4f16_1-MLC";
const defaultModelId = "gemma-4-E2B-it-q4f16_1-MLC";
const gemma4E2BModelRecord = {
  model: gemma4E2BRepo,
  model_id: defaultModelId,
  model_lib: `${gemma4E2BRepo}/resolve/main/libs/gemma-4-E2B-it-q4f16_1-MLC-webgpu.wasm`,
  required_features: ["shader-f16"],
};
let docsDbPromise: Promise<DocsDb> | null = null;
let enginePromise: Promise<MLCEngine> | null = null;
let loadedModelId: string | null = null;
let loadingModelId: string | null = null;

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
      const fallback = fallbackPlan(request.prompt, request.file, docsUsed);
      return {
        ...fallback,
        source: "fallback",
        commandLine: argsToCommand(fallback.args),
        docsUsed,
        warning: `Local model failed, so Catalyst used deterministic fallback planning: ${errorMessage(error)}`,
      };
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
  if (
    enginePromise &&
    (loadedModelId === modelId || loadingModelId === modelId)
  ) {
    return enginePromise;
  }

  loadingModelId = modelId;
  enginePromise = (async () => {
    try {
      const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
      const engine = await CreateMLCEngine(modelId, {
        initProgressCallback: onProgress,
        ...(modelId === defaultModelId
          ? { appConfig: getGemma4E2BAppConfig() }
          : {}),
      });
      loadedModelId = modelId;
      return engine;
    } catch (error) {
      loadedModelId = null;
      enginePromise = null;
      throw error;
    } finally {
      loadingModelId = null;
    }
  })();

  return enginePromise;
}

function getGemma4E2BAppConfig(): AppConfig {
  return {
    cacheBackend: hasCacheApi() ? "cache" : "indexeddb",
    model_list: [gemma4E2BModelRecord],
  };
}

function hasCacheApi(): boolean {
  return typeof globalThis.caches !== "undefined";
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
  const validation = request.file
    ? validateCommandArgs(parsed.args, request.file.name)
    : { ok: true, errors: [] };

  if (!validation.ok) {
    throw new Error(
      `Model returned an invalid FFmpeg command: ${validation.errors.join(" ")}`,
    );
  }

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

  const ensured = ensureCommandOutput(args, file);
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
  const fileType = file?.type ?? "";
  const correction = correctionPlan(prompt, name, docs);

  if (correction) {
    return correction;
  }

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
    text.includes("resize") ||
    fileType.startsWith("image/")
  ) {
    return {
      args: [
        "-i",
        "$INPUT",
        "-vf",
        "scale=1600:-1",
        outputFor(name, imageExtensionFor(text, fileType)),
      ],
      explanation:
        "Converts or resizes the image using FFmpeg's regular filter pipeline.",
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

function outputFor(fileName: string, extension: string): string {
  return suggestedOutputName(fileName, extension);
}

function correctionPlan(
  prompt: string,
  fileName: string,
  docs: string[],
): PlannedCommand | null {
  const text = prompt.toLowerCase();
  if (!text.includes("ffmpeg command failed") && !text.includes("error log:")) {
    return null;
  }

  const current = prompt.match(/current command:\s*(.+?)\nerror log:/is)?.[1];
  const currentArgs = current
    ? ensureCommandOutput(parseCommandLine(current), undefined)
    : null;

  if (text.includes("at least one output file")) {
    const args = currentArgs ?? ["-i", "$INPUT"];
    return {
      args: ensureCommandOutput(args, undefined),
      explanation:
        "Adds a writable output file because FFmpeg reported that no output was specified.",
      docs,
    };
  }

  if (text.includes("stream map") && text.includes("matches no streams")) {
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
        "-an",
        outputFor(fileName, "mp4"),
      ],
      explanation:
        "Removes audio mapping because FFmpeg reported that the requested stream was missing.",
      docs,
    };
  }

  if (text.includes("unknown encoder") && text.includes("libx264")) {
    return {
      args: [
        "-i",
        "$INPUT",
        "-c:v",
        "mpeg4",
        "-q:v",
        "5",
        "-c:a",
        "aac",
        outputFor(fileName, "mp4"),
      ],
      explanation:
        "Switches to a more broadly available video encoder after FFmpeg rejected libx264.",
      docs,
    };
  }

  if (text.includes("no such filter") || text.includes("invalid argument")) {
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
        outputFor(fileName, "mp4"),
      ],
      explanation:
        "Falls back to a conservative transcode after FFmpeg rejected the previous filter or argument.",
      docs,
    };
  }

  if (currentArgs) {
    return {
      args: currentArgs,
      explanation:
        "Preserves the current command shape and ensures it has an output; no known stderr-specific fallback matched.",
      docs,
    };
  }

  return null;
}

function imageExtensionFor(prompt: string, fileType: string): string {
  if (prompt.includes("avif")) return "avif";
  if (prompt.includes("jpg") || prompt.includes("jpeg")) return "jpg";
  if (prompt.includes("png")) return "png";
  if (fileType === "image/png" && prompt.includes("lossless")) return "png";
  return "webp";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { defaultModelId };
