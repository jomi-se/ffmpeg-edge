export type CommandChipKind =
  | "input"
  | "output"
  | "codec"
  | "filter"
  | "quality"
  | "seek"
  | "duration"
  | "format"
  | "flag"
  | "value";

export interface CommandChip {
  id: string;
  token: string;
  label: string;
  kind: CommandChipKind;
  editable: boolean;
}

export interface PlannedCommand {
  args: string[];
  explanation: string;
  docs: string[];
}

export interface CommandValidationResult {
  ok: boolean;
  errors: string[];
  outputName?: string;
}

const VALUE_FLAGS = new Set([
  "-i",
  "-c:v",
  "-c:a",
  "-codec:v",
  "-codec:a",
  "-vf",
  "-af",
  "-filter:v",
  "-filter:a",
  "-crf",
  "-b:v",
  "-b:a",
  "-preset",
  "-ss",
  "-t",
  "-to",
  "-f",
  "-r",
  "-ar",
  "-ac",
  "-s",
  "-map",
  "-pix_fmt",
  "-frames:v",
  "-frames:a",
  "-q:v",
  "-q:a",
]);

export function parseCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens[0] === "ffmpeg" ? tokens.slice(1) : tokens;
}

export function normalizeArgs(
  args: string[],
  inputName: string,
  outputName: string,
): string[] {
  return args.map((arg) =>
    arg
      .replaceAll("$INPUT", inputName)
      .replaceAll("{input}", inputName)
      .replaceAll("$OUTPUT", outputName)
      .replaceAll("{output}", outputName),
  );
}

export function inferOutputName(fileName: string, args: string[]): string {
  const explicit = args.find(
    (arg) => arg.includes("$OUTPUT") || arg.includes("{output}"),
  );
  if (explicit) {
    return explicit
      .replace("$OUTPUT", suggestedOutputName(fileName))
      .replace("{output}", suggestedOutputName(fileName));
  }

  const output = findOutputTokens(args).at(-1);
  if (output) return output.token;

  return suggestedOutputName(fileName);
}

export function suggestedOutputName(
  fileName: string,
  extension = "mp4",
): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  return `${base || "output"}-converted.${extension}`;
}

export function argsToCommand(args: string[]): string {
  return ["ffmpeg", ...args.map(quoteToken)].join(" ");
}

function quoteToken(token: string): string {
  if (!token || /[\s"'$]/.test(token)) {
    return `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }

  return token;
}

export function commandToChips(args: string[]): CommandChip[] {
  const chips: CommandChip[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];

    if (token === "-i" && next) {
      chips.push(makeChip(index, next, "Input", "input", false));
      index += 1;
      continue;
    }

    if (VALUE_FLAGS.has(token) && next) {
      chips.push(
        makeChip(
          index,
          `${token} ${next}`,
          labelForFlag(token, next),
          kindForFlag(token),
          true,
        ),
      );
      index += 1;
      continue;
    }

    if (!token.startsWith("-") && index === args.length - 1) {
      chips.push(makeChip(index, token, "Output", "output", true));
      continue;
    }

    chips.push(
      makeChip(
        index,
        token,
        token,
        token.startsWith("-") ? "flag" : "value",
        true,
      ),
    );
  }

  return chips;
}

export function commandLineToArgs(
  commandLine: string,
  fileName?: string,
): string[] {
  const args = parseCommandLine(commandLine);
  if (!fileName) return args;

  const safeName = safeVirtualFileName(fileName);
  let hasInput = false;
  const normalized = args.map((arg, index) => {
    if (args[index - 1] !== "-i") return arg;
    hasInput = true;
    if (
      arg === "$INPUT" ||
      arg === "{input}" ||
      arg === fileName ||
      arg === safeName
    ) {
      return "$INPUT";
    }
    return arg;
  });

  return hasInput ? normalized : ["-i", "$INPUT", ...normalized];
}

export function validateCommandArgs(
  args: string[],
  fileName: string,
): CommandValidationResult {
  const errors: string[] = [];
  const safeName = safeVirtualFileName(fileName);
  let inputCount = 0;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "ffmpeg") {
      errors.push("Do not include the ffmpeg executable in the argument list.");
      continue;
    }

    if (token === "-i") {
      const input = args[index + 1];
      if (!input) {
        errors.push("Missing an input after -i.");
        continue;
      }
      inputCount += 1;
      if (
        input !== "$INPUT" &&
        input !== "{input}" &&
        input !== fileName &&
        input !== safeName
      ) {
        errors.push(
          `Input "${input}" is not available in the browser workspace. Use $INPUT for the selected file.`,
        );
      }
      index += 1;
      continue;
    }

    if (VALUE_FLAGS.has(token)) {
      if (!args[index + 1]) {
        errors.push(`Missing a value after ${token}.`);
      } else {
        index += 1;
      }
    }
  }

  if (inputCount === 0) {
    errors.push("Command must include exactly one selected input: -i $INPUT.");
  } else if (inputCount > 1) {
    errors.push("This workspace currently supports exactly one input file.");
  }

  const outputs = findOutputTokens(args);
  if (outputs.length === 0) {
    errors.push("Command must end with a writable output file.");
  } else if (outputs.length > 1) {
    errors.push("This workspace currently supports exactly one output file.");
  }

  const output = outputs.at(-1);
  if (output) {
    if (output.index !== args.length - 1) {
      errors.push("The output file must be the final argument.");
    }
    if (!isSafeOutputToken(output.token)) {
      errors.push(
        "Output must be a simple file name, not a URL, absolute path, or parent-directory path.",
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    outputName: output?.token,
  };
}

export function ensureCommandOutput(args: string[], file?: File): string[] {
  if (args.some((arg) => arg.includes("$OUTPUT") || arg.includes("{output}"))) {
    return args;
  }

  if (findOutputTokens(args).length > 0) {
    return args;
  }

  return [
    ...args,
    suggestedOutputName(file?.name ?? "output", extensionFor(file)),
  ];
}

export function safeVirtualFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned || "input.bin";
}

function findOutputTokens(
  args: string[],
): Array<{ token: string; index: number }> {
  const outputs: Array<{ token: string; index: number }> = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "-i" || VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }

    if (!token.startsWith("-")) {
      outputs.push({ token, index });
    }
  }

  return outputs;
}

function isSafeOutputToken(token: string): boolean {
  if (token.includes("$OUTPUT") || token.includes("{output}")) return true;
  if (!token || token.includes("\0")) return false;
  if (token.includes("/") || token.includes("\\") || token.includes("..")) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(token)) return false;
  return true;
}

function extensionFor(file?: File): string {
  if (file?.type.startsWith("image/")) return "webp";
  if (file?.type.startsWith("audio/")) return "mp3";
  return "mp4";
}

function makeChip(
  index: number,
  token: string,
  label: string,
  kind: CommandChipKind,
  editable: boolean,
): CommandChip {
  return {
    id: `${index}-${token}`,
    token,
    label,
    kind,
    editable,
  };
}

function kindForFlag(flag: string): CommandChipKind {
  if (flag.includes("c:") || flag.includes("codec")) return "codec";
  if (flag.includes("filter") || flag === "-vf" || flag === "-af")
    return "filter";
  if (flag === "-crf" || flag.startsWith("-b:") || flag === "-preset")
    return "quality";
  if (flag === "-ss") return "seek";
  if (flag === "-t" || flag === "-to") return "duration";
  if (flag === "-f") return "format";
  return "flag";
}

function labelForFlag(flag: string, value: string): string {
  const labels: Record<string, string> = {
    "-c:v": "Video codec",
    "-codec:v": "Video codec",
    "-c:a": "Audio codec",
    "-codec:a": "Audio codec",
    "-vf": "Video filter",
    "-filter:v": "Video filter",
    "-af": "Audio filter",
    "-filter:a": "Audio filter",
    "-crf": "Quality",
    "-b:v": "Video bitrate",
    "-b:a": "Audio bitrate",
    "-preset": "Preset",
    "-ss": "Start",
    "-t": "Duration",
    "-to": "End",
    "-f": "Format",
    "-r": "Frame rate",
    "-ar": "Sample rate",
    "-ac": "Channels",
    "-s": "Size",
    "-map": "Stream map",
    "-pix_fmt": "Pixel format",
  };

  return `${labels[flag] ?? flag}: ${value}`;
}
