import { suggestedOutputName } from "./command";

/**
 * Static, deterministic conversion recipes — the primary interface. No model, no
 * retrieval: just the handful of common conversions this app is actually for.
 * Each recipe builds an args array with the $INPUT placeholder and a suggested
 * output name; fine-tuning (trim times, sizes, quality) happens afterward in the
 * existing chip editor.
 */

export type FileKind = "audio" | "video" | "image";

export interface Recipe {
  id: string;
  label: string;
  description: string;
  kinds: FileKind[];
  build: (file: File) => string[];
}

/** The media kind of a file, or null if it isn't audio/video/image. */
export function fileKind(file: File): FileKind | null {
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  return null;
}

/** Lowercase source extension, falling back to a sensible default per kind. */
function sourceExt(file: File): string {
  const match = file.name.match(/\.([^.]+)$/);
  if (match) return match[1].toLowerCase();
  const kind = fileKind(file);
  return kind === "audio" ? "mp3" : kind === "image" ? "png" : "mp4";
}

function out(file: File, extension: string): string {
  return suggestedOutputName(file.name, extension);
}

export const recipes: Recipe[] = [
  // Video
  {
    id: "video-compress",
    label: "Compress",
    description: "Smaller MP4, broadly compatible (H.264).",
    kinds: ["video"],
    build: (file) => [
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
      out(file, "mp4"),
    ],
  },
  {
    id: "video-720p",
    label: "Resize to 720p",
    description: "Scale down to 720p height, keep aspect ratio.",
    kinds: ["video"],
    build: (file) => [
      "-i",
      "$INPUT",
      "-vf",
      "scale=-2:720",
      "-c:v",
      "libx264",
      "-crf",
      "23",
      "-c:a",
      "copy",
      out(file, "mp4"),
    ],
  },
  {
    id: "video-gif",
    label: "Convert to GIF",
    description: "Compact animated GIF.",
    kinds: ["video"],
    build: (file) => [
      "-i",
      "$INPUT",
      "-vf",
      "fps=12,scale=640:-1:flags=lanczos",
      out(file, "gif"),
    ],
  },
  {
    id: "video-extract-audio",
    label: "Extract audio (MP3)",
    description: "Pull the audio track out as an MP3.",
    kinds: ["video"],
    build: (file) => [
      "-i",
      "$INPUT",
      "-vn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      out(file, "mp3"),
    ],
  },
  {
    id: "video-mute",
    label: "Mute",
    description: "Remove the audio track, keep the video as-is.",
    kinds: ["video"],
    build: (file) => [
      "-i",
      "$INPUT",
      "-c",
      "copy",
      "-an",
      out(file, sourceExt(file)),
    ],
  },
  {
    id: "video-thumbnail",
    label: "Grab thumbnail",
    description: "Save a single frame near the start as a JPG.",
    kinds: ["video"],
    build: (file) => [
      "-ss",
      "00:00:03",
      "-i",
      "$INPUT",
      "-frames:v",
      "1",
      out(file, "jpg"),
    ],
  },
  {
    id: "video-trim",
    label: "Trim",
    description: "Keep a clip — edit the start and duration chips after.",
    kinds: ["video"],
    build: (file) => [
      "-ss",
      "00:00:00",
      "-i",
      "$INPUT",
      "-t",
      "00:00:10",
      "-c",
      "copy",
      out(file, sourceExt(file)),
    ],
  },
  // Audio
  {
    id: "audio-mp3",
    label: "Convert to MP3",
    description: "Turn any audio (e.g. a WhatsApp .ogg) into an MP3.",
    kinds: ["audio"],
    build: (file) => [
      "-i",
      "$INPUT",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      out(file, "mp3"),
    ],
  },
  {
    id: "audio-wav",
    label: "Convert to WAV",
    description: "Uncompressed WAV (16-bit PCM).",
    kinds: ["audio"],
    build: (file) => ["-i", "$INPUT", "-c:a", "pcm_s16le", out(file, "wav")],
  },
  {
    id: "audio-trim",
    label: "Trim",
    description: "Keep a section — edit the start and duration chips after.",
    kinds: ["audio"],
    build: (file) => [
      "-ss",
      "00:00:00",
      "-i",
      "$INPUT",
      "-t",
      "00:00:30",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      out(file, "mp3"),
    ],
  },
  // Image
  {
    id: "image-webp",
    label: "Convert to WebP",
    description: "Small, modern image format.",
    kinds: ["image"],
    build: (file) => ["-i", "$INPUT", out(file, "webp")],
  },
  {
    id: "image-jpg",
    label: "Convert to JPG",
    description: "Widely compatible photo format.",
    kinds: ["image"],
    build: (file) => ["-i", "$INPUT", out(file, "jpg")],
  },
  {
    id: "image-png",
    label: "Convert to PNG",
    description: "Lossless image format.",
    kinds: ["image"],
    build: (file) => ["-i", "$INPUT", out(file, "png")],
  },
  {
    id: "image-resize",
    label: "Resize",
    description: "Scale to 1600px wide — edit the size chip after.",
    kinds: ["image"],
    build: (file) => [
      "-i",
      "$INPUT",
      "-vf",
      "scale=1600:-1",
      out(file, sourceExt(file)),
    ],
  },
];

/** Recipes applicable to the given file, or [] for unsupported types. */
export function recipesForFile(file: File): Recipe[] {
  const kind = fileKind(file);
  if (!kind) return [];
  return recipes.filter((recipe) => recipe.kinds.includes(kind));
}
