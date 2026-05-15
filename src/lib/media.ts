import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import {
  inferOutputName,
  normalizeArgs,
  parseCommandLine,
  suggestedOutputName,
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

const coreVersion = "0.12.10";
const singleThreadBase = `https://unpkg.com/@ffmpeg/core@${coreVersion}/dist/umd`;
const multiThreadBase = `https://unpkg.com/@ffmpeg/core-mt@${coreVersion}/dist/umd`;

let ffmpegInstance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

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
  onLog?: FfmpegLogHandler,
  onProgress?: FfmpegProgressHandler,
): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) {
    return ffmpegInstance;
  }

  if (loading) {
    return loading;
  }

  loading = (async () => {
    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => onLog?.(message));
    ffmpeg.on("progress", ({ progress, time }) => onProgress?.(progress, time));

    const useThreads =
      typeof SharedArrayBuffer !== "undefined" && crossOriginIsolated;
    const base = useThreads ? multiThreadBase : singleThreadBase;

    await ffmpeg.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
      ...(useThreads
        ? {
            workerURL: await toBlobURL(
              `${base}/ffmpeg-core.worker.js`,
              "text/javascript",
            ),
          }
        : {}),
    });

    ffmpegInstance = ffmpeg;
    loading = null;
    return ffmpeg;
  })();

  return loading;
}

export async function probeWithFfmpeg(
  file: File,
  onLog?: FfmpegLogHandler,
): Promise<MediaMetadata> {
  const ffmpeg = await ensureFfmpeg(onLog);
  const inputName = safeInputName(file.name);
  const outputName = "probe.json";

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
  await cleanupFiles(ffmpeg, [inputName, outputName]);

  return {
    ...(await getMediaElementMetadata(file).catch(() => ({
      name: file.name,
      size: file.size,
      type: file.type,
    }))),
    streams: parsed.streams,
    format: parsed.format,
  };
}

export async function runFfmpegCommand(
  request: FfmpegRunRequest,
  onLog?: FfmpegLogHandler,
  onProgress?: FfmpegProgressHandler,
): Promise<FfmpegRunResult> {
  const logs: string[] = [];
  const started = performance.now();
  const inputName = safeInputName(request.file.name);
  const desiredOutput = inferOutputName(request.file.name, request.args);
  const outputName =
    desiredOutput === inputName
      ? suggestedOutputName(inputName)
      : desiredOutput;
  const ffmpeg = await ensureFfmpeg((message) => {
    logs.push(message);
    onLog?.(message);
  }, onProgress);

  await ffmpeg.writeFile(inputName, await fetchFile(request.file));
  const args = normalizeArgs(request.args, inputName, outputName);
  const exitCode = await ffmpeg.exec(args, request.timeoutMs ?? 120_000);
  let outputBlob: Blob | undefined;

  if (exitCode === 0) {
    const outputData = await ffmpeg.readFile(outputName);
    const blobPart =
      typeof outputData === "string" ? outputData : new Uint8Array(outputData);
    outputBlob = new Blob([blobPart], { type: mimeTypeForOutput(outputName) });
  }

  await cleanupFiles(ffmpeg, [inputName, outputName]);

  return {
    exitCode,
    outputName,
    outputBlob,
    logs,
    elapsedMs: performance.now() - started,
  };
}

export function commandLineToArgs(
  commandLine: string,
  fileName: string,
): string[] {
  const args = parseCommandLine(commandLine);
  if (args.includes("$INPUT") || args.includes("{input}")) {
    return args;
  }

  if (!args.includes(fileName) && !args.includes(safeInputName(fileName))) {
    return ["-i", "$INPUT", ...args];
  }

  return args;
}

export function safeInputName(fileName: string): string {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned || "input.bin";
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
