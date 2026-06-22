import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    allowedHosts: ["artifex-box.tail246db1.ts.net"],
  },
  // Vite's dep pre-bundling rewrites @ffmpeg/ffmpeg into .vite/deps, which breaks
  // the package's internal `new Worker(new URL("./worker.js", import.meta.url))`:
  // the worker path no longer resolves, so the worker never loads and
  // ffmpeg.load() hangs silently. Excluding it keeps the worker resolvable.
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
  build: {
    target: "es2022",
  },
  worker: {
    format: "es",
  },
});
