// Auto-grader for model-produced ffmpeg commands. Rough but transparent: per
// intent we encode the flags/filters a correct command must contain (`pass`)
// and the high-quality approach (`good`). no_answer intents pass iff the model
// abstains (produces no ffmpeg command). Raw transcripts are always saved too,
// so a human can overrule any verdict.

const has = (re) => (s) => re.test(s);
const all = (...fns) => (s) => fns.every((f) => f(s));
const any = (...fns) => (s) => fns.some((f) => f(s));

// Predicates run against the lowercased extracted command.
export const RUBRIC = {
  gif: {
    pass: all(has(/\.gif\b/), any(has(/\bfps\b/), has(/scale[=\s]/))),
    good: all(has(/palettegen/), has(/paletteuse/)),
    note: "video→gif; quality path uses palettegen+paletteuse",
  },
  mp3: {
    pass: any(has(/libmp3lame/), all(has(/\.mp3\b/), any(has(/-vn\b/), has(/-q:a/), has(/-b:a/), has(/-c:a/), has(/-acodec/)))),
    good: has(/libmp3lame/),
    note: "→mp3; quality path names the libmp3lame encoder",
  },
  crop_img: {
    pass: has(/crop\s*=/),
    good: has(/crop\s*=/),
    note: "crop video filter on a still",
  },
  trim_audio: {
    pass: all(has(/-ss\b/), any(has(/-t\b/), has(/-to\b/))),
    good: all(has(/-ss\b/), any(has(/-t\b/), has(/-to\b/))),
    note: "-ss start + -t/-to duration",
  },
  compress_video: {
    pass: any(has(/-crf\b/), has(/-b:v\b/)),
    good: all(has(/-crf\b/), any(has(/libx264/), has(/libx265/), has(/-c:v/))),
    note: "CRF or target bitrate (libx264/265)",
  },
  thumb_video: {
    pass: any(has(/thumbnail/), has(/fps\s*=/), has(/-vframes\b/), has(/-frames:v\b/)),
    good: any(has(/thumbnail/), has(/fps\s*=/)),
    note: "thumbnail filter / fps= / -frames:v",
  },
  mute_video: {
    pass: has(/-an\b/),
    good: has(/-an\b/),
    note: "-an drops the audio stream",
  },
  to_mp4: {
    pass: has(/\.mp4\b/),
    good: all(any(has(/libx264/), has(/h264/), has(/-c:v copy/), has(/-c copy/)), any(has(/aac/), has(/-c:a copy/), has(/-c copy/))),
    note: "→.mp4; quality path = h264+aac (or stream copy)",
  },
  speed_video: {
    pass: any(has(/setpts/), has(/atempo/)),
    good: any(has(/setpts/), has(/atempo/)),
    note: "setpts (video) / atempo (audio)",
  },
  thumb_image: {
    pass: has(/scale\s*=/),
    good: has(/scale\s*=/),
    note: "resize via scale filter",
  },
};

// All command-like lines from a response (handles two-pass forms, e.g. gif:
// palettegen then paletteuse). Used for grading so multi-command answers count.
function commandLines(text) {
  if (!text) return [];
  const fences = [...text.matchAll(/```(?:bash|sh|shell)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const blob = fences.length ? fences.join("\n") : text;
  return blob.split("\n").map((l) => l.trim().replace(/^\$\s*/, "")).filter((l) => /ffmpeg\b/i.test(l));
}

// A single representative command for display (first ffmpeg line).
export function extractCommand(text) {
  const lines = commandLines(text);
  if (lines.length) return lines[0];
  const fence = text.match(/```(?:bash|sh|shell)?\s*([\s\S]*?)```/i);
  return (fence ? fence[1] : text || "").trim();
}

// The text the rubric predicates run against: all command lines joined.
function gradableCommand(text) {
  const lines = commandLines(text);
  return (lines.length ? lines.join(" ") : extractCommand(text)).toLowerCase();
}

const producedCommand = (text) => /ffmpeg\s+-/i.test(text) || /```[\s\S]*ffmpeg/i.test(text);

// Grade one response. Returns { verdict: good|pass|fail|abstain_ok|abstain_miss, command }.
export function grade({ text, intent, no_answer }) {
  const command = extractCommand(text);
  if (no_answer) {
    return { verdict: producedCommand(text) ? "abstain_miss" : "abstain_ok", command: producedCommand(text) ? command : "" };
  }
  const r = RUBRIC[intent];
  if (!r) return { verdict: "fail", command, reason: `no rubric for ${intent}` };
  const c = gradableCommand(text);
  if (!r.pass(c)) return { verdict: "fail", command };
  return { verdict: r.good(c) ? "good" : "pass", command };
}

// good and pass both count as a correct command; abstain_ok counts for no_answer.
export const isCorrect = (v) => v === "good" || v === "pass" || v === "abstain_ok";
