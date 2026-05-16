# FFmpeg Catalyst

FFmpeg Catalyst is a browser-native media workstation that keeps FFmpeg visible and inspectable while local AI helps turn intent into editable command arguments.

## What It Does

- Runs `ffmpeg.wasm` and `ffprobe` in the browser for audio, video, and image files.
- Uses a COOP/COEP service worker so browsers that support `SharedArrayBuffer` can load the multithreaded FFmpeg core.
- Retrieves local FFmpeg documentation chunks with Orama before planning a command.
- Optionally loads a local WebLLM model for command planning. Qwen 3.5 0.8B is the mobile-friendly default, and Gemma 4 E2B remains available for desktop-class devices. If the model is unavailable, deterministic FFmpeg templates keep the app usable.
- Shows the planned FFmpeg arguments as editable chips and as a raw command.
- Captures FFmpeg logs, progress, and exit codes, then feeds failures back into the planner for correction.
- Saves successful outputs to the Origin Private File System when the browser supports OPFS.
- Processes files locally. The app does not upload source media to a server.
- Downloads runtime assets from public CDNs: FFmpeg core files from unpkg and optional WebLLM model files from Hugging Face. Those assets are cached by the browser/service worker where possible.

## Development

```sh
npm install
npm run dev
```

The dev server must be opened over `http://localhost` or HTTPS for the browser APIs used by FFmpeg, WebLLM, service workers, and OPFS. Local WebLLM model loading also needs WebGPU; plain HTTP preview hosts usually cannot load it.

The default planner model id is `Qwen3.5-0.8B-q4f16_1-MLC`, which is part of the installed WebLLM prebuilt model list and is recommended for mobile devices. The desktop preset is `gemma-4-E2B-it-q4f16_1-MLC`; it is loaded through a custom WebLLM app config pointed at the `welcoma/gemma-4-E2B-it-q4f16_1-MLC` Hugging Face artifact because this Gemma 4 E2B variant is not part of the installed WebLLM prebuilt model list. The app config prefers WebLLM's Cache API artifact cache and falls back to IndexedDB only when `globalThis.caches` is unavailable.

Push-to-talk uses the browser Web Speech API. Depending on the browser, microphone audio or transcripts may be processed by the browser vendor. The app discloses this before starting speech recognition.

## Production Build

```sh
npm run build
npm run preview
```

The Vite build uses a relative base path so the static `dist/` output can be hosted from a GitHub Pages project path such as `https://USER.github.io/REPO/`.

## GitHub Pages Notes

Deploy the contents of `dist/`. The app registers `coi-serviceworker.js` from the same base path as the page, which is required for cross-origin isolation on static hosts that cannot set COOP/COEP headers directly.

After the service worker activates, reload once if the page reports that `crossOriginIsolated` is still false. Browsers may require that first controlled reload before multithreaded `ffmpeg.wasm` is available.

## Attribution

This project is built around [FFmpeg](https://ffmpeg.org/) and [ffmpeg.wasm](https://ffmpegwasm.netlify.app/). FFmpeg is the media engine; the local planner only proposes commands for users to inspect and run.
