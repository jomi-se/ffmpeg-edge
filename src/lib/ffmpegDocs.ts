export interface FfmpegDocChunk {
  id: string;
  title: string;
  section: string;
  summary: string;
  syntax: string;
  url: string;
  tags: string[];
}

export const ffmpegDocChunks: FfmpegDocChunk[] = [
  {
    id: "input-output",
    title: "Input and output files",
    section: "ffmpeg CLI",
    summary:
      "Use -i before each input. The final non-option token is usually the output file. Catalyst uses $INPUT and $OUTPUT placeholders before execution.",
    syntax: "-i $INPUT [options] $OUTPUT",
    url: "https://ffmpeg.org/ffmpeg.html",
    tags: ["input", "output", "file", "placeholder"],
  },
  {
    id: "trim-ss-t",
    title: "Trim media with -ss and -t",
    section: "ffmpeg CLI",
    summary:
      "Seek with -ss and limit duration with -t. Put -ss before -i for fast seeking, or after -i for more precise trimming.",
    syntax: "-ss 00:00:10 -i $INPUT -t 00:00:20 -c copy $OUTPUT",
    url: "https://ffmpeg.org/ffmpeg.html#Main-options",
    tags: ["trim", "cut", "seek", "duration", "ss"],
  },
  {
    id: "extract-audio",
    title: "Extract or convert audio",
    section: "Audio",
    summary:
      "Disable video with -vn. Use libmp3lame for MP3, aac for M4A/MP4 audio, or pcm_s16le for WAV.",
    syntax: "-i $INPUT -vn -c:a libmp3lame -b:a 192k $OUTPUT",
    url: "https://ffmpeg.org/ffmpeg-codecs.html",
    tags: ["audio", "extract", "mp3", "wav", "ogg", "convert"],
  },
  {
    id: "scale-video",
    title: "Scale video",
    section: "Video filters",
    summary:
      "Use the scale filter to resize while preserving aspect ratio. A dimension of -2 keeps the result divisible by two for codec compatibility.",
    syntax:
      "-i $INPUT -vf scale=1280:-2 -c:v libx264 -crf 23 -c:a copy $OUTPUT",
    url: "https://ffmpeg.org/ffmpeg-filters.html#scale",
    tags: ["scale", "resize", "720p", "1080p", "video"],
  },
  {
    id: "compress-h264",
    title: "Compress with H.264 CRF",
    section: "Video codecs",
    summary:
      "For H.264, libx264 with CRF 18-28 balances quality and size. Lower CRF means higher quality. Presets trade encoding speed for compression.",
    syntax:
      "-i $INPUT -c:v libx264 -preset medium -crf 24 -c:a aac -b:a 128k $OUTPUT",
    url: "https://ffmpeg.org/ffmpeg-codecs.html#libx264_002c-libx264rgb",
    tags: ["compress", "h264", "x264", "crf", "bitrate", "mp4"],
  },
  {
    id: "gif-palette",
    title: "Create high quality GIFs",
    section: "Palette filters",
    summary:
      "Generate a palette and apply paletteuse for better GIF colors. Catalyst can start with a simpler one-pass command, but palettegen/paletteuse is the quality path.",
    syntax: "-i $INPUT -vf fps=12,scale=640:-1:flags=lanczos $OUTPUT",
    url: "https://ffmpeg.org/ffmpeg-filters.html#palettegen",
    tags: ["gif", "palette", "palettegen", "paletteuse", "image"],
  },
  {
    id: "image-convert",
    title: "Convert and resize images",
    section: "Images",
    summary:
      "FFmpeg can convert single images and image sequences. Static images can use video filters such as scale, crop, rotate, and overlay.",
    syntax: "-i $INPUT -vf scale=1600:-1 $OUTPUT",
    url: "https://ffmpeg.org/ffmpeg.html",
    tags: ["image", "webp", "avif", "png", "jpeg", "resize"],
  },
  {
    id: "thumbnail",
    title: "Extract a thumbnail",
    section: "Images from video",
    summary:
      "Seek to a timestamp and output one video frame with -frames:v 1. JPEG, PNG, WebP, and AVIF are common outputs.",
    syntax: "-ss 00:00:03 -i $INPUT -frames:v 1 $OUTPUT",
    url: "https://ffmpeg.org/ffmpeg.html#Video-Options",
    tags: ["thumbnail", "frame", "extract", "image", "poster"],
  },
  {
    id: "concat",
    title: "Concatenate media",
    section: "Concat demuxer",
    summary:
      "Use the concat demuxer for files with matching codecs. For mixed inputs, re-encode after combining.",
    syntax: "-f concat -safe 0 -i files.txt -c copy $OUTPUT",
    url: "https://ffmpeg.org/ffmpeg-formats.html#concat",
    tags: ["concat", "join", "merge", "multiple"],
  },
  {
    id: "watermark-overlay",
    title: "Overlay an image watermark",
    section: "Overlay filter",
    summary:
      "Use overlay in a filtergraph to place a second image or video stream over the first.",
    syntax:
      "-i $INPUT -i watermark.png -filter_complex overlay=W-w-24:H-h-24 $OUTPUT",
    url: "https://ffmpeg.org/ffmpeg-filters.html#overlay",
    tags: ["watermark", "overlay", "logo", "image", "filtergraph"],
  },
];
