import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    allowedHosts: ["artifex-box.tail246db1.ts.net"],
  },
  build: {
    target: "es2022",
  },
  worker: {
    format: "es",
  },
});
