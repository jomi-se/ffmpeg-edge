import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initServiceWorkerLogging } from "./lib/serviceWorkerLog";
import { log } from "./lib/log";
import "./styles.css";

initServiceWorkerLogging();

// Route uncaught errors and promise rejections into the app log so failures are
// visible in-app (no DevTools on mobile). The FFmpeg multithreaded core can fail
// inside a worker, where the error otherwise only reaches the console.
window.addEventListener("error", (event) => {
  log.error("app", "Uncaught error", {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    col: event.colno,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  log.error("app", "Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

log.info("app", "Runtime capabilities", {
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory,
  crossOriginIsolated: globalThis.crossOriginIsolated,
});

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
