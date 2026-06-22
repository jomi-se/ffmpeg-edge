import { ensureCommandOutput, parseCommandLine } from "./command";
import type { MediaMetadata } from "./media";

/**
 * The "not sure what to do?" hand-off. We don't run a model in-app; instead we
 * build a copyable prompt for the user's own AI (ChatGPT/Claude/etc.), then parse
 * the command they paste back into args the chip editor and FFmpeg runner accept.
 */

export interface AiPromptRequest {
  request: string;
  file?: File | null;
  metadata?: MediaMetadata | null;
}

/** One-line description of the loaded file for the AI's context, if available. */
function fileContext(
  file: File | null | undefined,
  metadata: MediaMetadata | null | undefined,
): string | null {
  if (!file) return null;
  const parts = [file.name, file.type || "unknown type"];
  if (metadata?.duration) {
    parts.push(`${Math.round(metadata.duration)}s`);
  }
  if (metadata?.width && metadata?.height) {
    parts.push(`${metadata.width}x${metadata.height}`);
  }
  return parts.join(", ");
}

/** Builds the copyable prompt the user pastes into their own AI. */
export function buildAiPrompt(req: AiPromptRequest): string {
  const lines = [
    "I'm using a browser tool that runs FFmpeg (ffmpeg.wasm) locally on a single file.",
    "Give me one FFmpeg command that does what I describe below.",
    "",
    "Rules:",
    "- Reply with ONLY the command, in a single fenced code block, nothing else.",
    "- Use $INPUT for the input file and a simple output filename (e.g. output.mp4).",
    "- Exactly one command (no two-pass palettegen); keep it broadly compatible.",
    "",
  ];
  const ctx = fileContext(req.file, req.metadata);
  if (ctx) {
    lines.push(`My file: ${ctx}`);
  }
  lines.push(`What I want: ${req.request.trim()}`);
  return lines.join("\n");
}

/** Pulls the first usable command line out of a pasted AI reply. */
function extractCommandLine(text: string): string | null {
  const fences = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(
    (m) => m[1],
  );
  const blocks = fences.length > 0 ? fences : [text];

  for (const block of blocks) {
    // Join shell line-continuations so a wrapped command stays one line.
    const collapsed = block.replace(/\\\r?\n/g, " ");
    for (const rawLine of collapsed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const idx = line.toLowerCase().indexOf("ffmpeg");
      if (idx !== -1) return line.slice(idx);
      if (line.includes("-i ")) return line;
    }
  }
  return null;
}

/**
 * Parses a pasted AI reply into FFmpeg args. Throws if no command is found.
 * The caller validates the result with validateCommandArgs (same path recipes use).
 */
export function parseFfmpegReply(text: string): { args: string[] } {
  const command = extractCommandLine(text);
  if (!command) {
    throw new Error(
      "Couldn't find an FFmpeg command in that reply. Paste the command the AI gave you.",
    );
  }

  // parseCommandLine drops a leading "ffmpeg" token for us.
  const args = parseCommandLine(command);

  // Normalize the input to the $INPUT placeholder the runner substitutes.
  const inputIndex = args.indexOf("-i");
  if (inputIndex !== -1 && args[inputIndex + 1] !== undefined) {
    const value = args[inputIndex + 1];
    if (value !== "$INPUT" && value !== "{input}") {
      args[inputIndex + 1] = "$INPUT";
    }
  }

  return { args: ensureCommandOutput(args) };
}
