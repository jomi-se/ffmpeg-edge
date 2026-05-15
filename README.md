# FFmpeg Catalyst

FFmpeg Catalyst is a browser-native media workstation that keeps FFmpeg visible and inspectable while local AI helps turn intent into editable command arguments.

## What It Does

- Runs `ffmpeg.wasm` and `ffprobe` in the browser for audio, video, and image files.
- Uses a COOP/COEP service worker so browsers that support `SharedArrayBuffer` can load the multithreaded FFmpeg core.
- Retrieves local FFmpeg documentation chunks with Orama before planning a command.
- Optionally loads a local Gemma-family WebLLM model for command planning. If the model is unavailable, deterministic FFmpeg templates keep the app usable.
- Shows the planned FFmpeg arguments as editable chips and as a raw command.
- Captures FFmpeg logs, progress, and exit codes, then feeds failures back into the planner for correction.
- Saves successful outputs to the Origin Private File System when the browser supports OPFS.
- Processes files locally. The app does not upload source media to a server.

## Development

```sh
npm install
npm run dev
```

The dev server must be opened over `http://localhost` or HTTPS for the browser APIs used by FFmpeg, WebLLM, service workers, and OPFS.

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
