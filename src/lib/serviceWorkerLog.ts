import { log } from "./log";

interface CoiLogMessage {
  __coiLog: true;
  level?: "info" | "warn" | "error";
  message?: string;
  data?: unknown;
}

function isCoiLogMessage(value: unknown): value is CoiLogMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __coiLog?: unknown }).__coiLog === true
  );
}

/**
 * Routes service-worker (coi-serviceworker) lifecycle/error messages and
 * page-side SW state into the unified log's "sw" category, so runtime/isolation
 * failures are visible in the debug viewer instead of only the devtools console.
 */
export function initServiceWorkerLogging(): void {
  if (!("serviceWorker" in navigator)) {
    log.warn("sw", "Service workers are not supported in this browser.");
    return;
  }

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (isCoiLogMessage(event.data)) {
      const level =
        event.data.level === "error" || event.data.level === "warn"
          ? event.data.level
          : "info";
      log[level](
        "sw",
        event.data.message ?? "Service worker event",
        event.data.data,
      );
    }
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    log.info("sw", "Service worker controller changed", {
      controller: Boolean(navigator.serviceWorker.controller),
    });
  });

  void logServiceWorkerState();
}

async function logServiceWorkerState(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    log.info("sw", "Service worker state", {
      controller: Boolean(navigator.serviceWorker.controller),
      scope: registration?.scope ?? "none",
      active: registration?.active?.state ?? "none",
      crossOriginIsolated:
        typeof globalThis.crossOriginIsolated === "boolean"
          ? globalThis.crossOriginIsolated
          : "unknown",
    });
  } catch (error) {
    log.error("sw", "Failed to read service worker registration", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
