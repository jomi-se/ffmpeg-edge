import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import {
  commandLineToArgs as parseCommandLineToArgs,
  inferOutputName,
  normalizeArgs,
  safeVirtualFileName,
  suggestedOutputName,
  validateCommandArgs,
} from "./command";

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
export type FfmpegCoreMode = "multithread" | "single-thread" | "not-loaded";

const coreVersion = "0.12.10";
const singleThreadBase = `https://unpkg.com/@ffmpeg/core@${coreVersion}/dist/umd`;
const multiThreadBase = `https://unpkg.com/@ffmpeg/core-mt@${coreVersion}/dist/umd`;

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

export async function ensureFfmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) {
    return ffmpegInstance;
  }

  if (loading) {
    return loading;
  }

  loading = (async () => {
    try {
      const ffmpeg = new FFmpeg();
      const useThreads =
        typeof SharedArrayBuffer !== "undefined" && crossOriginIsolated;
      const base = useThreads ? multiThreadBase : singleThreadBase;

      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(
          `${base}/ffmpeg-core.wasm`,
          "application/wasm",
        ),
        ...(useThreads
          ? {
              workerURL: await toBlobURL(
                `${base}/ffmpeg-core.worker.js`,
                "text/javascript",
              ),
            }
          : {}),
      });

      coreMode = useThreads ? "multithread" : "single-thread";
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    } catch (error) {
      coreMode = "not-loaded";
      ffmpegInstance = null;
      throw error;
    } finally {
      loading = null;
    }
  })();

  return loading;
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

export async function probeWithFfmpeg(
  file: File,
  onLog?: FfmpegLogHandler,
): Promise<MediaMetadata> {
  const ffmpeg = await ensureFfmpeg();
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
  const ffmpeg = await ensureFfmpeg();
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

    return {
      exitCode,
      outputName,
      outputBlob,
      logs,
      elapsedMs: performance.now() - started,
    };
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

function attachFfmpegEvents(
  ffmpeg: FFmpeg,
  onLog?: FfmpegLogHandler,
  onProgress?: FfmpegProgressHandler,
): () => void {
  const logCallback = ({ message }: { message: string }) => onLog?.(message);
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
