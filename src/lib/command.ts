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

export function normalizeArgs(args: string[], inputName: string, outputName: string): string[] {
  return args.map((arg) =>
    arg
      .replaceAll("$INPUT", inputName)
      .replaceAll("{input}", inputName)
      .replaceAll("$OUTPUT", outputName)
      .replaceAll("{output}", outputName),
  );
}

export function inferOutputName(fileName: string, args: string[]): string {
  const explicit = args.find((arg) => arg.includes("$OUTPUT") || arg.includes("{output}"));
  if (explicit) {
    return explicit.replace("$OUTPUT", suggestedOutputName(fileName)).replace("{output}", suggestedOutputName(fileName));
  }

  for (let index = args.length - 1; index >= 0; index -= 1) {
    const token = args[index];
    if (!token.startsWith("-") && args[index - 1] !== "-i") {
      return token;
    }
  }

  return suggestedOutputName(fileName);
}

export function suggestedOutputName(fileName: string, extension = "mp4"): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  return `${base || "output"}-catalyst.${extension}`;
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
      chips.push(makeChip(index, `${token} ${next}`, labelForFlag(token, next), kindForFlag(token), true));
      index += 1;
      continue;
    }

    if (!token.startsWith("-") && index === args.length - 1) {
      chips.push(makeChip(index, token, "Output", "output", true));
      continue;
    }

    chips.push(makeChip(index, token, token, token.startsWith("-") ? "flag" : "value", true));
  }

  return chips;
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
  if (flag.includes("filter") || flag === "-vf" || flag === "-af") return "filter";
  if (flag === "-crf" || flag.startsWith("-b:") || flag === "-preset") return "quality";
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
