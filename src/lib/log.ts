/**
 * Unified, in-memory app event log. One timestamped, categorized buffer that
 * everything routes through, so nothing is lost in per-module silos and the
 * debug viewer can show live, switchable streams. Local-only: events stay in
 * memory and are surfaced through the UI / Copy button — never sent anywhere.
 */

export type LogCategory = "app" | "model" | "ffmpeg" | "sw";
export type LogLevel = "info" | "warn" | "error";

export interface LogEvent {
  id: number;
  time: string;
  category: LogCategory;
  level: LogLevel;
  message: string;
  data?: unknown;
}

export const logCategories: LogCategory[] = ["app", "model", "ffmpeg", "sw"];

const MAX_PER_CATEGORY = 800;
const buffers: Record<LogCategory, LogEvent[]> = {
  app: [],
  model: [],
  ffmpeg: [],
  sw: [],
};
const listeners = new Set<() => void>();
// useSyncExternalStore needs a stable snapshot reference between renders; bump
// this version on every change and let callers read it as the snapshot.
let version = 0;
let nextId = 1;

function notify(): void {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function logEvent(
  category: LogCategory,
  level: LogLevel,
  message: string,
  data?: unknown,
): LogEvent {
  const event: LogEvent = {
    id: nextId++,
    time: new Date().toISOString(),
    category,
    level,
    message,
    data,
  };
  const buffer = buffers[category];
  buffer.push(event);
  if (buffer.length > MAX_PER_CATEGORY) {
    buffer.splice(0, buffer.length - MAX_PER_CATEGORY);
  }

  // Mirror to the console so a live session (or Playwright) sees it too.
  const sink =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  if (data === undefined) {
    sink(`[${category}] ${message}`);
  } else {
    sink(`[${category}] ${message}`, data);
  }

  notify();
  return event;
}

export const log = {
  info: (category: LogCategory, message: string, data?: unknown) =>
    logEvent(category, "info", message, data),
  warn: (category: LogCategory, message: string, data?: unknown) =>
    logEvent(category, "warn", message, data),
  error: (category: LogCategory, message: string, data?: unknown) =>
    logEvent(category, "error", message, data),
};

export function getLog(category: LogCategory): LogEvent[] {
  return buffers[category];
}

export function getAllEvents(): LogEvent[] {
  return logCategories
    .flatMap((category) => buffers[category])
    .sort((a, b) => a.id - b.id);
}

export function clearLog(category?: LogCategory): void {
  if (category) {
    buffers[category].length = 0;
  } else {
    for (const key of logCategories) {
      buffers[key].length = 0;
    }
  }
  notify();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic version, used as the useSyncExternalStore snapshot. */
export function getLogVersion(): number {
  return version;
}

export function formatEvent(event: LogEvent): string {
  const prefix = `${event.time} [${event.level}] ${event.message}`;
  if (event.data === undefined) {
    return prefix;
  }
  return `${prefix} ${safeStringify(event.data)}`;
}

export function formatEvents(events: LogEvent[]): string {
  return events.map(formatEvent).join("\n");
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
