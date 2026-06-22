import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import {
  commandLineToArgs as parseCommandLineToArgs,
  inferOutputName,
  normalizeArgs,
  safeVirtualFileName,
  suggestedOutputName,
  validateCommandArgs,
} from "./command";
import { log, type LogLevel } from "./log";

export interface MediaMetadata {
  name: string;
  size: number;
  type: string;
  duration?: number;
  width?: number;
  height?: number;
  streams?: Array<Record<string, unknown>>;
  format?: Record<string, unknown>;
}

export interface FfmpegRunRequest {
  file: File;
  args: string[];
  timeoutMs?: number;
}

export interface FfmpegRunResult {
  exitCode: number;
  outputName: string;
  outputBlob?: Blob;
  logs: string[];
  elapsedMs: number;
}

export type FfmpegProgressHandler = (progress: number, time: number) => void;
export type FfmpegLogHandler = (message: string) => void;
export type FfmpegLoadHandler = (message: string) => void;
export type FfmpegCoreMode = "multithread" | "single-thread" | "not-loaded";

const coreVersion = "0.12.10";
const singleThreadBase = `https://unpkg.com/@ffmpeg/core@${coreVersion}/dist/esm`;
const multiThreadBase = `https://unpkg.com/@ffmpeg/core-mt@${coreVersion}/dist/esm`;
const coreStartupTimeoutMs = 90_000;

let ffmpegInstance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
let coreMode: FfmpegCoreMode = "not-loaded";

export async function getMediaElementMetadata(
  file: File,
): Promise<MediaMetadata> {
  const metadata: MediaMetadata = {
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
  };

  if (!file.type.startsWith("audio/") && !file.type.startsWith("video/")) {
    return metadata;
  }

  const element = file.type.startsWith("audio/")
    ? document.createElement("audio")
    : document.createElement("video");
  const objectUrl = URL.createObjectURL(file);

  try {
    await new Promise<void>((resolve, reject) => {
      element.preload = "metadata";
      element.src = objectUrl;
      element.onloadedmetadata = () => resolve();
      element.onerror = () =>
        reject(new Error("Could not read media metadata"));
    });

    if (Number.isFinite(element.duration)) {
      metadata.duration = element.duration;
    }

    if (element instanceof HTMLVideoElement) {
      metadata.width = element.videoWidth || undefined;
      metadata.height = element.videoHeight || undefined;
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  return metadata;
}

export async function ensureFfmpeg(
  onLoadStatus?: FfmpegLoadHandler,
): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) {
    onLoadStatus?.(`FFmpeg core is already loaded in ${coreMode} mode.`);
    return ffmpegInstance;
  }

  if (loading) {
    onLoadStatus?.("FFmpeg core is already loading.");
    return loading;
  }

  loading = (async () => {
    try {
      const useThreads =
        typeof SharedArrayBuffer !== "undefined" && crossOriginIsolated;
      recordLoadDebug("Starting FFmpeg load", {
        crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
        useThreads,
      });

      if (useThreads) {
        try {
          const ffmpeg = await loadCore("multithread", onLoadStatus);
          coreMode = "multithread";
          ffmpegInstance = ffmpeg;
          return ffmpeg;
        } catch (error) {
          recordLoadDebug(
            "Multithreaded core failed; falling back to single-thread",
            { error: errorMessage(error) },
            "warn",
          );
          onLoadStatus?.(
            `Multithreaded FFmpeg did not start cleanly: ${errorMessage(error)} Trying single-thread core.`,
          );
        }
      }

      const ffmpeg = await loadCore("single-thread", onLoadStatus);
      coreMode = "single-thread";
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    } catch (error) {
      coreMode = "not-loaded";
      ffmpegInstance = null;
      recordLoadDebug(
        "FFmpeg core load failed",
        { error: errorMessage(error) },
        "error",
      );
      onLoadStatus?.(`FFmpeg core load failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

async function loadCore(
  mode: Exclude<FfmpegCoreMode, "not-loaded">,
  onLoadStatus?: FfmpegLoadHandler,
): Promise<FFmpeg> {
  const ffmpeg = new FFmpeg();
  const useThreads = mode === "multithread";
  const base = useThreads ? multiThreadBase : singleThreadBase;
  const label = useThreads ? "multithreaded" : "single-threaded";

  onLoadStatus?.(`Fetching ${label} FFmpeg core JavaScript from unpkg.`);
  const coreURL = await fetchBlobURLWithDebug(
    `${base}/ffmpeg-core.js`,
    "text/javascript",
    `${label} core JavaScript`,
  );
  onLoadStatus?.(`Fetching ${label} FFmpeg core WebAssembly from unpkg.`);
  const wasmURL = await fetchBlobURLWithDebug(
    `${base}/ffmpeg-core.wasm`,
    "application/wasm",
    `${label} core WebAssembly`,
  );
  let workerURL: string | undefined;

  if (useThreads) {
    onLoadStatus?.("Fetching multithreaded FFmpeg worker from unpkg.");
    workerURL = await fetchBlobURLWithDebug(
      `${base}/ffmpeg-core.worker.js`,
      "text/javascript",
      "multithreaded core worker",
    );
  }

  // Capture the core's own init output (emscripten printErr, pthread spawn
  // failures, abort messages) into the app log. Without this, a load that hangs
  // or aborts only reports to the DevTools console — unreachable on mobile.
  const onCoreLog = ({ type, message }: { type: string; message: string }) =>
    recordLoadDebug(`core init [${type}]`, { message });
  ffmpeg.on("log", onCoreLog);

  onLoadStatus?.(`Starting ${label} FFmpeg core.`);
  const startupStarted = performance.now();
  try {
    await withTimeout(
      ffmpeg.load({
        coreURL,
        wasmURL,
        ...(workerURL ? { workerURL } : {}),
      }),
      coreStartupTimeoutMs,
      `${label} FFmpeg core startup timed out`,
    );
  } catch (error) {
    recordLoadDebug(
      `${label} FFmpeg startup failed`,
      {
        elapsedMs: Math.round(performance.now() - startupStarted),
        error: errorMessage(error),
      },
      "error",
    );
    ffmpeg.off("log", onCoreLog);
    ffmpeg.terminate();
    throw error;
  }
  ffmpeg.off("log", onCoreLog);
  recordLoadDebug(`${label} FFmpeg startup finished`, {
    elapsedMs: Math.round(performance.now() - startupStarted),
  });
  onLoadStatus?.(`FFmpeg core loaded in ${mode} mode.`);
  return ffmpeg;
}

export function getFfmpegRuntimeStatus(): {
  coreMode: FfmpegCoreMode;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
} {
  return {
    coreMode,
    crossOriginIsolated:
      typeof globalThis.crossOriginIsolated === "boolean" &&
      globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  };
}

/** Emits a point-in-time FFmpeg runtime state summary into the ffmpeg log. */
export function logFfmpegState(): void {
  const runtime = getFfmpegRuntimeStatus();
  log.info("ffmpeg", "FFmpeg state snapshot", {
    coreVersion,
    mode: runtime.coreMode,
    crossOriginIsolated: runtime.crossOriginIsolated,
    sharedArrayBuffer: runtime.sharedArrayBuffer,
    loaded: Boolean(ffmpegInstance?.loaded),
    loading: Boolean(loading),
    startupTimeoutMs: coreStartupTimeoutMs,
    singleThreadBase,
    multiThreadBase,
  });
}

export async function probeWithFfmpeg(
  file: File,
  onLog?: FfmpegLogHandler,
  onLoadStatus?: FfmpegLoadHandler,
): Promise<MediaMetadata> {
  const ffmpeg = await ensureFfmpeg(onLoadStatus);
  const inputName = safeInputName(file.name);
  const outputName = "probe.json";
  const cleanupEvents = attachFfmpegEvents(ffmpeg, onLog);

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file));
    const exitCode = await ffmpeg.ffprobe([
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      inputName,
      "-o",
      outputName,
    ]);

    if (exitCode !== 0) {
      throw new Error(`ffprobe exited with code ${exitCode}`);
    }

    const raw = await ffmpeg.readFile(outputName, "utf8");
    const parsed = JSON.parse(String(raw)) as Pick<
      MediaMetadata,
      "streams" | "format"
    >;

    return {
      ...(await getMediaElementMetadata(file).catch(() => ({
        name: file.name,
        size: file.size,
        type: file.type,
      }))),
      streams: parsed.streams,
      format: parsed.format,
    };
  } finally {
    cleanupEvents();
    await cleanupFiles(ffmpeg, [inputName, outputName]);
  }
}

export async function runFfmpegCommand(
  request: FfmpegRunRequest,
  onLog?: FfmpegLogHandler,
  onProgress?: FfmpegProgressHandler,
  onLoadStatus?: FfmpegLoadHandler,
): Promise<FfmpegRunResult> {
  const logs: string[] = [];
  const started = performance.now();
  const validation = validateCommandArgs(request.args, request.file.name);
  if (!validation.ok) {
    throw new Error(validation.errors.join(" "));
  }

  const inputName = safeInputName(request.file.name);
  const desiredOutput = inferOutputName(request.file.name, request.args);
  const outputName =
    desiredOutput === inputName
      ? suggestedOutputName(inputName)
      : desiredOutput;
  const ffmpeg = await ensureFfmpeg(onLoadStatus);
  const cleanupEvents = attachFfmpegEvents(
    ffmpeg,
    (message) => {
      logs.push(message);
      onLog?.(message);
    },
    onProgress,
  );
  let exitCode = 1;
  let outputBlob: Blob | undefined;

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(request.file));
    const args = normalizeArgs(request.args, inputName, outputName);
    log.info("ffmpeg", "Run started", {
      args,
      coreMode,
      inputName,
      inputSize: request.file.size,
      outputName,
    });
    exitCode = await ffmpeg.exec(args, request.timeoutMs ?? 120_000);

    if (exitCode === 0) {
      const outputData = await ffmpeg.readFile(outputName);
      const blobPart =
        typeof outputData === "string"
          ? outputData
          : new Uint8Array(outputData);
      outputBlob = new Blob([blobPart], {
        type: mimeTypeForOutput(outputName),
      });
    }
    log[exitCode === 0 ? "info" : "warn"](
      "ffmpeg",
      `Run finished with exit code ${exitCode}`,
      {
        exitCode,
        elapsedMs: Math.round(performance.now() - started),
        outputBytes: outputBlob?.size ?? 0,
        outputName,
      },
    );

    return {
      exitCode,
      outputName,
      outputBlob,
      logs,
      elapsedMs: performance.now() - started,
    };
  } catch (error) {
    log.error("ffmpeg", "Run threw before completing", {
      error: errorMessage(error),
      inputName,
      outputName,
    });
    throw error;
  } finally {
    cleanupEvents();
    await cleanupFiles(ffmpeg, [inputName, outputName]);
  }
}

export function commandLineToArgs(
  commandLine: string,
  fileName: string,
): string[] {
  return parseCommandLineToArgs(commandLine, fileName);
}

export function safeInputName(fileName: string): string {
  return safeVirtualFileName(fileName);
}

function mimeTypeForOutput(outputName: string): string {
  const ext = outputName.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    gif: "image/gif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
  };

  return types[ext ?? ""] ?? "application/octet-stream";
}

async function cleanupFiles(ffmpeg: FFmpeg, paths: string[]): Promise<void> {
  await Promise.all(
    paths.map((path) =>
      ffmpeg.deleteFile(path).catch(() => {
        return false;
      }),
    ),
  );
}

async function fetchBlobURLWithDebug(
  url: string,
  mimeType: string,
  label: string,
): Promise<string> {
  const started = performance.now();
  recordLoadDebug(`Fetching ${label}`, { mimeType, url });

  try {
    const response = await fetch(url);
    const responseElapsedMs = Math.round(performance.now() - started);
    recordLoadDebug(`Fetch response for ${label}`, {
      contentLength: response.headers.get("content-length"),
      contentType: response.headers.get("content-type"),
      elapsedMs: responseElapsedMs,
      ok: response.ok,
      status: response.status,
      type: response.type,
      url: response.url,
    });

    if (!response.ok) {
      throw new Error(`${label} fetch failed with status ${response.status}`);
    }

    const blob = await response.blob();
    const typedBlob =
      blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
    recordLoadDebug(`Blob URL ready for ${label}`, {
      elapsedMs: Math.round(performance.now() - started),
      size: typedBlob.size,
      type: typedBlob.type,
    });
    return URL.createObjectURL(typedBlob);
  } catch (error) {
    recordLoadDebug(`Fetch failed for ${label}`, {
      elapsedMs: Math.round(performance.now() - started),
      error: errorMessage(error),
      url,
    });
    throw error;
  }
}

function attachFfmpegEvents(
  ffmpeg: FFmpeg,
  onLog?: FfmpegLogHandler,
  onProgress?: FfmpegProgressHandler,
): () => void {
  const logCallback = ({ message }: { message: string }) => {
    log.info("ffmpeg", message);
    onLog?.(message);
  };
  const progressCallback = ({
    progress,
    time,
  }: {
    progress: number;
    time: number;
  }) => onProgress?.(progress, time);

  ffmpeg.on("log", logCallback);
  ffmpeg.on("progress", progressCallback);

  return () => {
    ffmpeg.off("log", logCallback);
    ffmpeg.off("progress", progressCallback);
  };
}

function recordLoadDebug(
  message: string,
  details?: Record<string, unknown>,
  level: LogLevel = "info",
): void {
  log[level]("ffmpeg", message, details);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
