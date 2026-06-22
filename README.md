# Local Media Converter

Local Media Converter converts audio, video, and images in your browser with FFmpeg. Files stay on your device. A set of one-click recipes covers the common conversions; for anything else, an optional helper builds a prompt you can paste into your own AI and parse the reply back into an editable command.

## What It Does

- Runs `ffmpeg.wasm` and `ffprobe` in the browser for audio, video, and image files.
- Uses a COOP/COEP service worker so browsers that support `SharedArrayBuffer` can load the multithreaded FFmpeg core.
- Offers one-click recipes for the common conversions (compress, resize, GIF, extract audio, convert image formats, and more), filtered to the loaded file's type.
- Shows the resulting FFmpeg arguments as editable chips so anything can be fine-tuned before running.
- "Ask an AI" flow: describe what you want, copy the generated prompt into ChatGPT/Claude/etc., then paste the reply back to turn it into a runnable command. No model is downloaded or run in-app.
- Captures FFmpeg logs, progress, and exit codes.
- Saves successful outputs to the Origin Private File System when the browser supports OPFS.
- Processes files locally. The app does not upload source media to a server.
- Downloads runtime assets from public CDNs: FFmpeg core files from unpkg, cached by the browser/service worker where possible.

## Development

```sh
npm install
npm run dev
```

The dev server must be opened over `http://localhost` or HTTPS for the browser APIs used by FFmpeg, service workers, and OPFS.

## Production Build

```sh
npm run build
npm run preview
```

The Vite build uses a relative base path so the static `dist/` output can be hosted from a GitHub Pages project path such as `https://USER.github.io/REPO/`.

## GitHub Pages Notes

Deploy the contents of `dist/`. The app registers `coi-serviceworker.js` from the same base path as the page, which is required for cross-origin isolation on static hosts that cannot set COOP/COEP headers directly.

## Attribution

This project is built around [FFmpeg](https://ffmpeg.org/) and [ffmpeg.wasm](https://ffmpegwasm.netlify.app/). Consider donating or sponsoring them.
