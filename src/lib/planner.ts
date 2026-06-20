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
import { log, type LogLevel } from "./log";

export interface PlanRequest {
  prompt: string;
  file?: File;
  metadata?: MediaMetadata | null;
  modelId?: string;
  useLocalModel?: boolean;
  onModelProgress?: (report: InitProgressReport) => void;
  /** Live status during generation (token counts), distinct from load progress. */
  onPlanStatus?: (status: string) => void;
}

export interface PlanResult extends PlannedCommand {
  source: "webllm" | "fallback";
  commandLine: string;
  docsUsed: FfmpegDocChunk[];
  rawModelOutput?: string;
  warning?: string;
}

type DocsDb = AnyOrama;

// Generation is streamed and watched two ways: abort if no new token arrives
// for the stall window (covers a truly stuck generation, including slow
// first-token/prefill on mobile GPUs), or if the whole generation exceeds the
// hard cap. A slow-but-steady mobile decode is no longer killed mid-flight.
const modelPlanStallTimeoutMs = 60_000;
const modelPlanHardCapMs = 180_000;
const maxPlanTokens = 700;
const gemma4E2BRepo =
  "https://huggingface.co/welcoma/gemma-4-E2B-it-q4f16_1-MLC";
const gemma4E2BModelId = "gemma-4-E2B-it-q4f16_1-MLC";
const qwen35MobileModelId = "Qwen3.5-0.8B-q4f16_1-MLC";
const defaultModelId = qwen35MobileModelId;
const modelPresets = [
  {
    id: qwen35MobileModelId,
    name: "Qwen 3.5 0.8B",
    recommendation: "Recommended for mobile",
    summary: "447 MB download, about 1.6 GB WebGPU memory.",
  },
  {
    id: gemma4E2BModelId,
    name: "Gemma 4 E2B",
    recommendation: "Recommended for desktop",
    summary: "Larger high-memory planner for desktop-class devices.",
  },
];
const gemma4E2BModelRecord = {
  model: gemma4E2BRepo,
  model_id: gemma4E2BModelId,
  model_lib: `${gemma4E2BRepo}/resolve/main/libs/gemma-4-E2B-it-q4f16_1-MLC-webgpu.wasm`,
  required_features: ["shader-f16"],
};
let docsDbPromise: Promise<DocsDb> | null = null;
let enginePromise: Promise<MLCEngine> | null = null;
let loadedModelId: string | null = null;
let loadingModelId: string | null = null;
let lastModelError: string | null = null;
let lastModelProgress: InitProgressReport | null = null;
let lastWebGpuStatus: WebGpuStatus | null = null;

export interface WebGpuStatus {
  /** navigator.gpu exists. True does NOT mean a GPU is usable. */
  apiPresent: boolean;
  /** navigator.gpu.requestAdapter() returned a usable adapter. */
  adapterAvailable: boolean;
  /** Adapter exposes the shader-f16 feature these quantized models require. */
  shaderF16: boolean;
  adapterInfo?: string;
  /** Human-readable reason the model would fail to load, if any. */
  error?: string;
  checkedAt: string;
}

// Minimal structural typing for WebGPU so we avoid adding @webgpu/types.
type MinimalGpuAdapter = {
  features: { has(name: string): boolean } & Iterable<string>;
  info?: { vendor?: string; architecture?: string };
};
type MinimalGpu = {
  requestAdapter(): Promise<MinimalGpuAdapter | null>;
};

export async function searchFfmpegDocs(
  query: string,
  limit = 4,
): Promise<FfmpegDocChunk[]> {
  const db = await getDocsDb();
  // threshold:1 ranks by relevance and returns docs matching ANY token. With
  // threshold:0 (match ALL tokens) a multi-word query never intersects across
  // docs, so retrieval silently returned nothing and the model got no grounding.
  const result = await search(db, {
    term: query,
    limit,
    threshold: 1,
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
  recordModelDebug("Planner request started", {
    fileName: request.file?.name,
    fileType: request.file?.type,
    modelId: request.modelId ?? defaultModelId,
    promptLength: request.prompt.length,
    useLocalModel: Boolean(request.useLocalModel),
  });
  // Query with the user's intent only. Appending file type/name keywords pulls
  // source-format docs and pushes out docs for the requested OUTPUT (e.g. a GIF
  // request would otherwise rank MP4/scale docs above the GIF doc).
  const docsUsed = await searchFfmpegDocs(request.prompt);
  recordModelDebug("Planner docs retrieved", {
    docs: docsUsed.map((doc) => doc.id),
    count: docsUsed.length,
  });

  if (request.useLocalModel) {
    try {
      const fromModel = await planWithWebLLM(request, docsUsed);
      return fromModel;
    } catch (error) {
      lastModelError = errorMessage(error);
      recordModelDebug(
        "Local model planning failed; using fallback",
        {
          error: lastModelError,
          stack: error instanceof Error ? error.stack : undefined,
        },
        "error",
      );
      const fallback = fallbackPlan(request.prompt, request.file, docsUsed);
      return {
        ...fallback,
        source: "fallback",
        commandLine: argsToCommand(fallback.args),
        docsUsed,
        warning: `Local model failed, so the app used deterministic fallback planning: ${errorMessage(error)}`,
      };
    }
  }

  const fallback = fallbackPlan(request.prompt, request.file, docsUsed);
  recordModelDebug("Planner used deterministic fallback", {
    reason: "useLocalModel=false",
  });
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
  recordModelDebug("Ensure local model requested", {
    loadedModelId,
    loadingModelId,
    modelId,
    reusingPromise:
      Boolean(enginePromise) &&
      (loadedModelId === modelId || loadingModelId === modelId),
  });

  if (
    enginePromise &&
    (loadedModelId === modelId || loadingModelId === modelId)
  ) {
    return enginePromise;
  }

  loadingModelId = modelId;
  enginePromise = (async () => {
    try {
      recordModelDebug("Importing WebLLM runtime", { modelId });
      const { CreateMLCEngine, prebuiltAppConfig } =
        await import("@mlc-ai/web-llm");
      const appConfig = getModelAppConfig(modelId, prebuiltAppConfig);
      recordModelDebug("Starting WebLLM engine creation", {
        cacheBackend: appConfig.cacheBackend,
        modelId,
        modelRecordFound: appConfig.model_list.some(
          (record) => record.model_id === modelId,
        ),
      });
      const engine = await CreateMLCEngine(modelId, {
        initProgressCallback: (report) => {
          lastModelProgress = report;
          recordModelDebug("Model load progress", {
            progressPercent: Math.round(report.progress * 1000) / 10,
            text: report.text,
            timeElapsed: report.timeElapsed,
          });
          onProgress?.(report);
        },
        appConfig,
      });
      loadedModelId = modelId;
      lastModelError = null;
      recordModelDebug("WebLLM engine ready", { modelId });
      return engine;
    } catch (error) {
      lastModelError = errorMessage(error);
      loadedModelId = null;
      enginePromise = null;
      recordModelDebug(
        "WebLLM engine creation failed",
        {
          error: lastModelError,
          modelId,
          stack: error instanceof Error ? error.stack : undefined,
        },
        "error",
      );
      throw error;
    } finally {
      loadingModelId = null;
    }
  })();

  return enginePromise;
}

/**
 * Whether the model's weights are already in the browser cache, so it can be
 * loaded without a network download. Used to decide auto-load on startup.
 */
export async function isModelCached(
  modelId = defaultModelId,
): Promise<boolean> {
  try {
    const { hasModelInCache, prebuiltAppConfig } =
      await import("@mlc-ai/web-llm");
    const appConfig = getModelAppConfig(modelId, prebuiltAppConfig);
    return await hasModelInCache(modelId, appConfig);
  } catch (error) {
    recordModelDebug(
      "Model cache check failed",
      { error: errorMessage(error), modelId },
      "warn",
    );
    return false;
  }
}

/** Emits a point-in-time model/runtime state summary into the model log. */
export function logModelState(): void {
  const progress = lastModelProgress
    ? `${Math.round(lastModelProgress.progress * 1000) / 10}% ${lastModelProgress.text}`
    : "none";
  log.info("model", "Model state snapshot", {
    defaultModel: defaultModelId,
    loadedModel: loadedModelId ?? "none",
    loadingModel: loadingModelId ?? "none",
    enginePromiseActive: Boolean(enginePromise),
    limits: {
      stallSeconds: Math.round(modelPlanStallTimeoutMs / 1000),
      hardCapSeconds: Math.round(modelPlanHardCapMs / 1000),
      maxTokens: maxPlanTokens,
    },
    lastProgress: progress,
    lastModelError: lastModelError ?? "none",
    runtime: {
      webGpu: hasWebGpu(),
      cacheApi: hasCacheApi(),
      indexedDb: hasIndexedDb(),
      crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
    },
    webGpuProbe: webGpuProbeSummary(),
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
  });
}

function getModelAppConfig(
  modelId: string,
  prebuiltAppConfig: AppConfig,
): AppConfig {
  const cacheBackend: AppConfig["cacheBackend"] = hasCacheApi()
    ? "cache"
    : "indexeddb";
  const modelList =
    modelId === gemma4E2BModelId
      ? [...prebuiltAppConfig.model_list, gemma4E2BModelRecord]
      : prebuiltAppConfig.model_list;

  return {
    ...prebuiltAppConfig,
    cacheBackend,
    model_list: modelList,
  };
}

function hasCacheApi(): boolean {
  return typeof globalThis.caches !== "undefined";
}

function hasIndexedDb(): boolean {
  return typeof globalThis.indexedDB !== "undefined";
}

function hasWebGpu(): boolean {
  return (
    typeof globalThis.navigator !== "undefined" && "gpu" in globalThis.navigator
  );
}

/**
 * Actively probes whether WebGPU can really be used, not just whether the API
 * is exposed. `'gpu' in navigator` is true in many browsers (and headless
 * Chromium) that have no usable GPU adapter, which is the most common reason
 * local model loading fails with "Unable to find a compatible GPU".
 */
export async function probeWebGpu(): Promise<WebGpuStatus> {
  const checkedAt = new Date().toISOString();
  if (!hasWebGpu()) {
    lastWebGpuStatus = {
      apiPresent: false,
      adapterAvailable: false,
      shaderF16: false,
      error: "This browser does not expose the WebGPU API (navigator.gpu).",
      checkedAt,
    };
    recordModelDebug("WebGPU probe: API not present");
    return lastWebGpuStatus;
  }

  try {
    const gpu = (globalThis.navigator as Navigator & { gpu?: MinimalGpu }).gpu;
    const adapter = (await gpu?.requestAdapter()) ?? null;
    if (!adapter) {
      lastWebGpuStatus = {
        apiPresent: true,
        adapterAvailable: false,
        shaderF16: false,
        error:
          "WebGPU is exposed but no compatible GPU adapter is available to this browser. requestAdapter() returned nothing — check chrome://gpu, that hardware acceleration is enabled, and https://webgpureport.org/.",
        checkedAt,
      };
      recordModelDebug(
        "WebGPU probe: no adapter (requestAdapter returned null)",
        undefined,
        "warn",
      );
      return lastWebGpuStatus;
    }

    const shaderF16 = adapter.features.has("shader-f16");
    const info = adapter.info;
    lastWebGpuStatus = {
      apiPresent: true,
      adapterAvailable: true,
      shaderF16,
      adapterInfo: info
        ? `${info.vendor ?? "unknown"}/${info.architecture ?? "unknown"}`
        : undefined,
      error: shaderF16
        ? undefined
        : "The GPU adapter is missing the shader-f16 feature these quantized models require, so loading will fail.",
      checkedAt,
    };
    recordModelDebug("WebGPU probe: adapter available", {
      adapterInfo: lastWebGpuStatus.adapterInfo,
      shaderF16,
    });
    return lastWebGpuStatus;
  } catch (error) {
    lastWebGpuStatus = {
      apiPresent: true,
      adapterAvailable: false,
      shaderF16: false,
      error: `WebGPU adapter probe threw: ${errorMessage(error)}`,
      checkedAt,
    };
    recordModelDebug(
      "WebGPU probe: threw",
      { error: errorMessage(error) },
      "error",
    );
    return lastWebGpuStatus;
  }
}

export function getLastWebGpuStatus(): WebGpuStatus | null {
  return lastWebGpuStatus;
}

function webGpuProbeSummary(): string {
  if (!lastWebGpuStatus) {
    return `apiPresent=${hasWebGpu()} (adapter not probed yet)`;
  }
  const parts = [
    `apiPresent=${lastWebGpuStatus.apiPresent}`,
    `adapterAvailable=${lastWebGpuStatus.adapterAvailable}`,
    `shaderF16=${lastWebGpuStatus.shaderF16}`,
  ];
  if (lastWebGpuStatus.adapterInfo) {
    parts.push(`adapter=${lastWebGpuStatus.adapterInfo}`);
  }
  if (lastWebGpuStatus.error) {
    parts.push(`note="${lastWebGpuStatus.error}"`);
  }
  return parts.join(", ");
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

/**
 * Mobile browsers reclaim the WebGPU device when the tab is backgrounded/idle,
 * which disposes WebLLM's GPU objects while our engine promise still points at
 * the dead engine. The next request then throws "already been disposed" /
 * "device lost". Detect that, drop the cached engine, reload, and retry once.
 */
async function planWithWebLLM(
  request: PlanRequest,
  docsUsed: FfmpegDocChunk[],
): Promise<PlanResult> {
  try {
    return await runWebLLMPlan(request, docsUsed);
  } catch (error) {
    if (!isRecoverableEngineError(error)) {
      throw error;
    }
    recordModelDebug(
      "Engine was disposed/lost; reloading and retrying once",
      { error: errorMessage(error) },
      "warn",
    );
    resetEngineState();
    return runWebLLMPlan(request, docsUsed);
  }
}

function isRecoverableEngineError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("already been disposed") ||
    message.includes("disposed") ||
    message.includes("device was lost") ||
    message.includes("device lost") ||
    message.includes("context lost")
  );
}

/** Drops the cached engine so the next ensureLocalModel reloads from scratch. */
function resetEngineState(): void {
  enginePromise = null;
  loadedModelId = null;
  loadingModelId = null;
}

async function runWebLLMPlan(
  request: PlanRequest,
  docsUsed: FfmpegDocChunk[],
): Promise<PlanResult> {
  const modelId = request.modelId ?? defaultModelId;
  recordModelDebug("WebLLM plan started", {
    docsCount: docsUsed.length,
    fileName: request.file?.name,
    fileType: request.file?.type,
    modelId,
    promptLength: request.prompt.length,
  });
  const engine = await ensureLocalModel(modelId, request.onModelProgress);
  const completionStarted = performance.now();
  // No response_format/grammar: grammar-masked decoding hangs at the first
  // token on some mobile GPUs (observed: arm/valhall, 0 tokens in 100s+).
  // The system prompt asks for JSON and parseModelPlan extracts/validates it.
  const stream = await engine.chat.completions.create({
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
    max_tokens: maxPlanTokens,
    // WebLLM-native switch: skips the Qwen3 <think> reasoning block so the
    // token budget is spent on the JSON answer instead of reasoning.
    extra_body: { enable_thinking: false },
    stream: true,
  });

  recordModelDebug("Generation started (streaming)", { modelId });
  request.onPlanStatus?.("Planning locally…");
  const { raw, tokenCount, finishReason, abortReason } =
    await consumePlanStream(stream, engine, completionStarted, (count) =>
      request.onPlanStatus?.(`Planning locally… ${count} tokens`),
    );

  const elapsedMs = Math.round(performance.now() - completionStarted);
  const tokensPerSecond =
    elapsedMs > 0 ? Math.round((tokenCount / elapsedMs) * 10000) / 10 : 0;
  recordModelDebug(
    "WebLLM streaming finished",
    {
      abortReason,
      elapsedMs,
      finishReason,
      modelId,
      rawLength: raw.length,
      tokenCount,
      tokensPerSecond,
    },
    abortReason ? "warn" : "info",
  );
  // Always record what the model actually produced (truncated) so parse
  // failures are diagnosable from the log alone.
  recordModelDebug("WebLLM raw output", {
    raw: raw.length > 4000 ? `${raw.slice(0, 4000)}…[truncated]` : raw,
  });

  if (abortReason && !raw.trim()) {
    throw new Error(
      `Local planning stopped because ${abortReason} (${tokenCount} tokens, ${tokensPerSecond} tokens/sec). Using deterministic fallback planning instead.`,
    );
  }

  const parsed = parseModelPlan(raw, request.file);
  const validation = request.file
    ? validateCommandArgs(parsed.args, request.file.name)
    : { ok: true, errors: [] };

  if (!validation.ok) {
    recordModelDebug(
      "WebLLM command validation failed",
      {
        args: parsed.args,
        errors: validation.errors,
        modelId,
      },
      "warn",
    );
    throw new Error(
      `Model returned an invalid FFmpeg command: ${validation.errors.join(" ")}`,
    );
  }

  lastModelError = null;
  recordModelDebug("WebLLM plan accepted", {
    args: parsed.args,
    modelId,
  });
  return {
    ...parsed,
    source: "webllm",
    commandLine: argsToCommand(parsed.args),
    docsUsed,
    rawModelOutput: raw,
  };
}

type PlanChunk = {
  choices: {
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }[];
};

interface StreamConsumption {
  raw: string;
  tokenCount: number;
  finishReason: string | null;
  abortReason: string | null;
}

/**
 * Drains a streaming completion with a per-chunk stall timeout and an overall
 * hard cap. Each `iterator.next()` is raced against the stall timer, so a stuck
 * first token (no output ever) is caught and we break out of the loop
 * ourselves — we do not rely on interruptGenerate() ending the stream, which it
 * does not do when generation never started.
 */
async function consumePlanStream(
  stream: AsyncIterable<PlanChunk>,
  engine: MLCEngine,
  startedAt: number,
  onToken: (count: number) => void,
): Promise<StreamConsumption> {
  const iterator = stream[Symbol.asyncIterator]();
  const stall = Symbol("stall");
  let raw = "";
  let tokenCount = 0;
  let finishReason: string | null = null;
  let abortReason: string | null = null;

  try {
    while (true) {
      if (performance.now() - startedAt > modelPlanHardCapMs) {
        abortReason = `generation exceeded the ${Math.round(modelPlanHardCapMs / 1000)} second limit`;
        break;
      }

      let timer: number | undefined;
      const stallTimeout = new Promise<typeof stall>((resolve) => {
        timer = window.setTimeout(
          () => resolve(stall),
          modelPlanStallTimeoutMs,
        );
      });

      // Keep a handle on next() so that if the stall timer wins the race, a
      // late rejection from the abandoned generation doesn't surface as an
      // unhandled rejection.
      const nextPromise = iterator.next();
      nextPromise.catch(() => {});

      let result: IteratorResult<PlanChunk> | typeof stall;
      try {
        result = await Promise.race([nextPromise, stallTimeout]);
      } finally {
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
      }

      if (result === stall) {
        abortReason = `the model produced no output for ${Math.round(modelPlanStallTimeoutMs / 1000)} seconds`;
        break;
      }
      if (result.done) {
        break;
      }

      const choice = result.value.choices[0];
      const delta = choice?.delta?.content ?? "";
      if (delta) {
        if (tokenCount === 0) {
          recordModelDebug("First token received", {
            firstTokenMs: Math.round(performance.now() - startedAt),
          });
        }
        raw += delta;
        tokenCount += 1;
        onToken(tokenCount);
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  } finally {
    // Only finalize the generator when we abort early. On normal completion the
    // generator already ran its own teardown; calling return() again triggers a
    // second resetChat and can dispose KV-cache state for the next request.
    if (abortReason) {
      recordModelDebug(
        "Interrupting WebLLM generation",
        {
          abortReason,
          elapsedMs: Math.round(performance.now() - startedAt),
          tokenCount,
        },
        "warn",
      );
      try {
        engine.interruptGenerate();
      } catch {
        // best effort; generation may already be unrecoverable
      }
      // Fire-and-forget: a frozen generator's return() can hang (interrupt may
      // not unstick it), and we must not block falling back to deterministic
      // planning on that.
      void Promise.resolve(iterator.return?.()).catch(() => {});
    }
  }

  return { raw, tokenCount, finishReason, abortReason };
}

function recordModelDebug(
  message: string,
  details?: Record<string, unknown>,
  level: LogLevel = "info",
): void {
  log[level]("model", message, details);
}

function buildSystemPrompt(
  metadata: MediaMetadata | null | undefined,
  docsUsed: FfmpegDocChunk[],
): string {
  return [
    "You are a specialist FFmpeg (ffmpeg.wasm) command planner inside the browser app Local Media Converter.",
    "Plan the FFmpeg command that fulfils the USER'S request for this specific file. Choose the output format the user asks for (e.g. a GIF request must produce a GIF, not an MP4).",
    "Base the command on the user's request and the docs below; when a doc matches the request, follow its syntax. Do not invent flags.",
    "Prefer browser-safe codecs: libx264/aac for MP4, libmp3lame for MP3, png/jpeg/webp for images.",
    "Use $INPUT for the input file and $OUTPUT for the output file. Never include the literal 'ffmpeg' executable.",
    'Reply with ONLY a JSON object, no prose, using exactly this shape (placeholders, do NOT copy these values): {"args":["-i","$INPUT","…","$OUTPUT"],"explanation":"<one short sentence>","docs":["<url>"]}',
    "args must be an array of individual CLI tokens (each flag and each value is its own string).",
    `Probe metadata: ${JSON.stringify(metadata ?? {})}`,
    `Relevant docs: ${JSON.stringify(
      docsUsed.map(({ title, summary, syntax, url }) => ({
        title,
        summary,
        syntax,
        url,
      })),
    )}`,
  ].join("\n");
}

/**
 * Returns the first complete top-level `{…}` object in `text`, accounting for
 * braces inside strings and escapes. Tolerant of prose before/after and of a
 * second object trailing the first.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseModelPlan(raw: string, file?: File): PlannedCommand {
  // Reasoning is suppressed at the engine level (extra_body.enable_thinking),
  // so the answer is plain text. Extract the first complete JSON object via a
  // balanced-brace scan (tolerant of leading/trailing prose or a trailing
  // second object), rather than a greedy regex that breaks on extra content.
  const jsonText = extractFirstJsonObject(raw) ?? raw;
  let value: Partial<PlannedCommand> | string[];
  try {
    value = JSON.parse(jsonText) as Partial<PlannedCommand> | string[];
  } catch (error) {
    recordModelDebug(
      "Failed to parse model JSON",
      {
        error: errorMessage(error),
        extracted: jsonText.slice(0, 1000),
        raw: raw.slice(0, 2000),
      },
      "error",
    );
    throw new Error(
      `Could not parse model output as JSON: ${errorMessage(error)}`,
    );
  }
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

export { defaultModelId, gemma4E2BModelId, modelPresets };
