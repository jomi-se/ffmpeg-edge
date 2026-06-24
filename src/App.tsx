import {
  Check,
  CheckCircle2,
  ChevronLeft,
  Copy,
  Download,
  FileAudio,
  FileImage,
  FileVideo,
  Github,
  LoaderCircle,
  Play,
  Settings2,
  Sparkles,
  TerminalSquare,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { commandToChips, validateCommandArgs } from "./lib/command";
import { CommandChips } from "./components/CommandChips";
import {
  ensureFfmpeg,
  getFfmpegRuntimeStatus,
  getMediaElementMetadata,
  logFfmpegState,
  runFfmpegCommand,
  type MediaMetadata,
} from "./lib/media";
import { recipesForFile, type Recipe } from "./lib/recipes";
import { buildAiPrompt, parseFfmpegReply } from "./lib/prompt";
import {
  formatEvent,
  formatEvents,
  getLog,
  getLogVersion,
  log,
  logCategories,
  subscribe,
  type LogCategory,
} from "./lib/log";
import { hasOPFSSupport, saveOutput } from "./lib/storage";

const categoryLabels: Record<LogCategory, string> = {
  app: "App flow",
  ffmpeg: "FFmpeg",
  sw: "Service worker",
};

export function App() {
  const [isFlipped, setIsFlipped] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null);

  const [args, setArgs] = useState<string[]>([]);
  const [activeRecipeId, setActiveRecipeId] = useState<string | null>(null);

  const [aiOpen, setAiOpen] = useState(false);
  const [aiRequest, setAiRequest] = useState("");
  const [aiReply, setAiReply] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputName, setOutputName] = useState<string | null>(null);
  const [ffmpegStatus, setFfmpegStatus] = useState(
    "FFmpeg loads automatically when you run a command.",
  );
  const [runtimeStatus, setRuntimeStatus] = useState(getFfmpegRuntimeStatus());
  const [logCategory, setLogCategory] = useState<LogCategory>("app");
  const [logsCopied, setLogsCopied] = useState(false);
  const activeFileRef = useRef<File | null>(null);
  const aiRequestRef = useRef<HTMLTextAreaElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Live view of the unified event log.
  const logVersion = useSyncExternalStore(subscribe, getLogVersion);
  const events = useMemo(() => getLog(logCategory), [logCategory, logVersion]);

  const chips = useMemo(() => commandToChips(args), [args]);
  const fileKind = getFileKind(file);
  const recipes = useMemo(() => (file ? recipesForFile(file) : []), [file]);
  const hasCommand = args.length > 0;
  const validation = useMemo(
    () => (file && hasCommand ? validateCommandArgs(args, file.name) : null),
    [args, file, hasCommand],
  );
  const canRun = !!file && hasCommand && !busy && validation?.ok !== false;

  useEffect(() => {
    const interval = window.setInterval(() => {
      const newRuntime = getFfmpegRuntimeStatus();
      setRuntimeStatus((prev) =>
        JSON.stringify(prev) === JSON.stringify(newRuntime) ? prev : newRuntime,
      );
    }, 2000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    log.info("app", "App started", { userAgent: navigator.userAgent });
  }, []);

  useLayoutEffect(() => {
    const input = aiRequestRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [aiRequest, aiOpen]);

  // Keep the log view pinned to the newest entries.
  useEffect(() => {
    const el = logRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logVersion, logCategory, isFlipped]);

  function addFfmpegEvent(message: string) {
    setFfmpegStatus(message);
  }

  async function handleFile(nextFile: File | null) {
    activeFileRef.current = nextFile;
    setFile(nextFile);
    setMetadata(null);
    setOutputUrl(null);
    setOutputName(null);
    setArgs([]);
    setActiveRecipeId(null);
    setAiOpen(false);
    setAiReply("");
    setAiError(null);

    if (!nextFile) {
      return;
    }

    log.info("app", "File selected", {
      name: nextFile.name,
      size: nextFile.size,
      type: nextFile.type,
    });
    setBusy("Reading metadata");
    try {
      const data = await getMediaElementMetadata(nextFile);
      if (activeFileRef.current === nextFile) {
        setMetadata(data);
        log.info("app", "Metadata read", {
          duration: data.duration,
          height: data.height,
          width: data.width,
        });
      }
    } catch (e) {
      if (activeFileRef.current === nextFile) {
        log.error("app", "Metadata read failed", { error: errorMessage(e) });
      }
    } finally {
      if (activeFileRef.current === nextFile) {
        setBusy(null);
      }
    }
  }

  function applyRecipe(recipe: Recipe) {
    if (!file) return;
    setArgs(recipe.build(file));
    setActiveRecipeId(recipe.id);
    setOutputUrl(null);
    setOutputName(null);
    log.info("app", "Recipe applied", { recipe: recipe.id });
  }

  async function handleCopyPrompt() {
    const text = buildAiPrompt({ request: aiRequest, file, metadata });
    await copyToClipboard(text);
    setPromptCopied(true);
    window.setTimeout(() => setPromptCopied(false), 1500);
    log.info("app", "AI prompt copied", { requestLength: aiRequest.length });
  }

  function handleUseReply() {
    setAiError(null);
    try {
      const { args: parsed } = parseFfmpegReply(aiReply);
      const check = file ? validateCommandArgs(parsed, file.name) : null;
      if (check && !check.ok) {
        setAiError(check.errors[0]);
        log.warn("app", "Pasted command failed validation", {
          errors: check.errors,
        });
        return;
      }
      setArgs(parsed);
      setActiveRecipeId(null);
      setOutputUrl(null);
      setOutputName(null);
      log.info("app", "Command parsed from AI reply", { args: parsed });
    } catch (error) {
      setAiError(errorMessage(error));
      log.warn("app", "Could not parse AI reply", {
        error: errorMessage(error),
      });
    }
  }

  async function handleLoadFfmpeg() {
    log.info("app", "Load FFmpeg requested");
    setBusy("Loading FFmpeg core");
    try {
      await ensureFfmpeg(addFfmpegEvent);
      setRuntimeStatus(getFfmpegRuntimeStatus());
    } catch (error) {
      setRuntimeStatus(getFfmpegRuntimeStatus());
      log.error("app", "FFmpeg load failed", { error: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleSnapshotState() {
    logFfmpegState();
    const serviceWorkerStatus = await getServiceWorkerDebugStatus();
    log.info("app", "Environment snapshot", {
      browser: getBrowserRuntimeStatus(),
      serviceWorker: serviceWorkerStatus,
      ui: { ffmpegStatus },
      userAgent: navigator.userAgent,
    });
  }

  async function handleCopyLogs() {
    const text = formatEvents(getLog(logCategory));
    if (!text) return;
    await copyToClipboard(text);
    setLogsCopied(true);
    window.setTimeout(() => setLogsCopied(false), 1500);
  }

  async function handleRun() {
    if (!file) return;
    log.info("app", "Run requested", { args });
    setBusy("Running FFmpeg");
    setProgress(0);
    setOutputUrl(null);
    setOutputName(null);
    setLogCategory("ffmpeg");

    try {
      const result = await runFfmpegCommand(
        { file, args },
        undefined,
        (nextProgress) => setProgress(Math.max(0, Math.min(1, nextProgress))),
        addFfmpegEvent,
      );

      if (result.outputBlob) {
        const url = URL.createObjectURL(result.outputBlob);
        setOutputUrl(url);
        setOutputName(result.outputName);
      }

      setRuntimeStatus(getFfmpegRuntimeStatus());
      addFfmpegEvent(
        result.exitCode === 0
          ? "FFmpeg run finished."
          : `FFmpeg exited with code ${result.exitCode}.`,
      );

      if (result.outputBlob && hasOPFSSupport()) {
        try {
          await saveOutput(result.outputName, result.outputBlob);
          log.info("app", "Output saved to OPFS", {
            outputName: result.outputName,
          });
        } catch (error) {
          log.warn("app", "OPFS save failed (download still available)", {
            error: errorMessage(error),
          });
        }
      }
    } catch (error) {
      setRuntimeStatus(getFfmpegRuntimeStatus());
      addFfmpegEvent(`FFmpeg run failed: ${errorMessage(error)}`);
      log.error("app", "FFmpeg run failed", {
        error: errorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      setIsFlipped(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="app-main">
      <header className="desk-header">
        <h1>Local Media Converter</h1>
        <p>
          Convert audio, video, and images in your browser with FFmpeg. Your
          files aren't uploaded anywhere.
        </p>
      </header>

      <div className="workstation-container">
        <div className={`flip-container ${isFlipped ? "flipped" : ""}`}>
          {/* FRONT FACE */}
          <div
            className="card-face front-face"
            inert={isFlipped ? true : undefined}
          >
            <div className="card-header card-header-actions">
              <button
                onClick={() => setIsFlipped(true)}
                className="icon-btn"
                title="Runtime and logs"
                aria-label="Runtime and logs"
              >
                <Settings2 size={18} />
              </button>
            </div>

            {/* File Loader / File State */}
            {!file ? (
              <label className="drop-zone">
                <input
                  type="file"
                  accept="audio/*,video/*,image/*"
                  onChange={(event) =>
                    handleFile(event.target.files?.[0] ?? null)
                  }
                />
                <Upload size={32} className="file-icon" />
                <div>
                  <strong>Choose a media file</strong>
                  <div className="text-muted text-sm mt-1">
                    Runs in this browser. Nothing is uploaded.
                  </div>
                </div>
              </label>
            ) : (
              <div className="loaded-file">
                <div className="file-icon">
                  {fileKind === "audio" ? (
                    <FileAudio />
                  ) : fileKind === "image" ? (
                    <FileImage />
                  ) : (
                    <FileVideo />
                  )}
                </div>
                <div className="loaded-file-info">
                  <strong>{file.name}</strong>
                  <div className="text-muted text-sm">
                    {formatBytes(file.size)}{" "}
                    {metadata?.duration &&
                      `• ${formatDuration(metadata.duration)}`}
                  </div>
                </div>
                <button
                  onClick={() => handleFile(null)}
                  className="icon-btn"
                  title="Remove file"
                  aria-label="Remove file"
                  disabled={!!busy}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            )}

            {/* Recipes */}
            {file && recipes.length > 0 && (
              <div className="recipes-section">
                <h2 className="text-muted">Pick a conversion</h2>
                <div className="recipe-grid">
                  {recipes.map((recipe) => (
                    <button
                      key={recipe.id}
                      className={`recipe-card ${
                        recipe.id === activeRecipeId ? "active" : ""
                      }`}
                      onClick={() => applyRecipe(recipe)}
                      disabled={!!busy}
                    >
                      <span className="recipe-label">{recipe.label}</span>
                      <span className="recipe-desc text-muted text-sm">
                        {recipe.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {file && recipes.length === 0 && (
              <p className="text-muted text-sm">
                No built-in recipes for this file type — read the docs or ask
                your AI of choice below.
              </p>
            )}

            {/* Command & Run */}
            {file && hasCommand && (
              <div className="command-section">
                <div className="command-header">
                  <h2 className="text-muted">Review FFmpeg args</h2>
                  <p className="command-hint text-sm text-muted">
                    Tap any value to fine-tune it.
                  </p>
                </div>
                <CommandChips
                  chips={chips}
                  args={args}
                  fileName={file.name}
                  disabled={!!busy}
                  onChange={setArgs}
                />

                <div className="action-row mt-4">
                  <button
                    className="btn-primary"
                    disabled={!canRun}
                    onClick={handleRun}
                  >
                    {busy === "Running FFmpeg" ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <Play size={18} />
                    )}
                    Run FFmpeg
                  </button>
                </div>
                {validation && !validation.ok && (
                  <div className="text-sm validation-error">
                    {validation.errors[0]}
                  </div>
                )}
                {busy === "Running FFmpeg" && (
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{ width: `${Math.round(progress * 100)}%` }}
                    />
                  </div>
                )}
                {outputUrl && outputName && (
                  <div className="output-ready mt-2">
                    <p className="output-ready-badge">
                      <CheckCircle2 size={16} className="output-ready-check" />
                      Done, all on your device.
                    </p>
                    <a
                      href={outputUrl}
                      download={outputName}
                      className="btn-primary btn-success"
                    >
                      <Download size={18} /> Download output
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* Stuck? two escape hatches: the docs, or your own AI */}
            {file && (
              <div className="ai-assist">
                <p className="text-muted text-sm">
                  Stuck?{" "}
                  <a
                    className="docs-link"
                    href="https://ffmpeg.org/ffmpeg.html"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Try your luck reading the docs
                  </a>
                  .
                </p>
                <button
                  className="ai-toggle"
                  aria-expanded={aiOpen}
                  onClick={() => setAiOpen((open) => !open)}
                >
                  <Sparkles size={14} />
                  Or ask your AI of choice
                </button>
                {aiOpen && (
                  <div className="ai-body">
                    <p className="text-muted text-sm">
                      Even small, cheap models are pretty good at FFmpeg option
                      wrangling. Describe what you want, copy the prompt, then
                      paste the reply back.
                    </p>
                    <textarea
                      ref={aiRequestRef}
                      className="ai-input"
                      aria-label="Describe what you want"
                      placeholder="Describe what you want, e.g. make this smaller for WhatsApp"
                      value={aiRequest}
                      onChange={(e) => setAiRequest(e.target.value)}
                    />
                    <div className="action-row">
                      <button
                        className="btn-primary"
                        onClick={handleCopyPrompt}
                        disabled={!aiRequest.trim()}
                      >
                        {promptCopied ? (
                          <Check size={16} />
                        ) : (
                          <Copy size={16} />
                        )}
                        {promptCopied ? "Copied" : "Copy prompt for AI"}
                      </button>
                    </div>
                    <p className="text-muted text-sm">
                      Paste that into Mistral, ChatGPT, Claude, a local
                      open-source model (Llama, Qwen, …), or any AI and then
                      paste its reply back here.
                    </p>
                    <textarea
                      className="ai-input"
                      aria-label="Paste the AI's reply"
                      placeholder="Paste the AI's reply (the FFmpeg command) here"
                      value={aiReply}
                      onChange={(e) => setAiReply(e.target.value)}
                    />
                    <div className="action-row">
                      <button
                        className="btn-primary"
                        onClick={handleUseReply}
                        disabled={!aiReply.trim()}
                      >
                        Use this command
                      </button>
                    </div>
                    {aiError && (
                      <div className="text-sm validation-error">{aiError}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* BACK FACE */}
          <div
            className="card-face back-face"
            inert={!isFlipped ? true : undefined}
          >
            <div className="card-header">
              <button
                onClick={() => setIsFlipped(false)}
                className="icon-btn"
                title="Back to local workspace"
                aria-label="Back to local workspace"
              >
                <ChevronLeft size={20} />
              </button>
              <h2 className="text-muted">Runtime and logs</h2>
              <div className="header-spacer"></div>
            </div>

            <div className="settings-grid">
              <div className="setting-group">
                <label>FFmpeg runtime</label>
                <div className="status-grid">
                  <div className="status-item">
                    <dt>Isolation</dt>
                    <dd>
                      {runtimeStatus.crossOriginIsolated
                        ? "Ready"
                        : "Needs reload"}
                    </dd>
                  </div>
                  <div className="status-item">
                    <dt>SharedArrayBuffer</dt>
                    <dd>
                      {runtimeStatus.sharedArrayBuffer
                        ? "Available"
                        : "Unavailable"}
                    </dd>
                  </div>
                  <div className="status-item">
                    <dt>Mode</dt>
                    <dd>{formatCoreMode(runtimeStatus.coreMode)}</dd>
                  </div>
                </div>
                <button
                  className="btn-primary btn-setting"
                  disabled={!!busy}
                  onClick={handleLoadFfmpeg}
                >
                  <TerminalSquare size={16} /> Load FFmpeg
                </button>
                <div className="text-muted text-sm mt-1">
                  Status: {ffmpegStatus}
                </div>
              </div>

              <div className="setting-group">
                <div className="logs-header">
                  <label>Logs</label>
                  <button
                    className="btn-ghost btn-copy"
                    onClick={handleCopyLogs}
                    disabled={events.length === 0}
                    title={`Copy ${categoryLabels[logCategory]} logs to clipboard`}
                  >
                    {logsCopied ? <Check size={14} /> : <Copy size={14} />}
                    {logsCopied ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="log-tabs">
                  {logCategories.map((category) => (
                    <button
                      key={category}
                      className={`log-tab ${category === logCategory ? "active" : ""}`}
                      onClick={() => setLogCategory(category)}
                    >
                      {categoryLabels[category]}
                    </button>
                  ))}
                </div>
                <div className="logs-container" ref={logRef}>
                  {events.length > 0 ? (
                    events.map((event) => (
                      <div
                        key={event.id}
                        className={`log-line log-${event.level}`}
                      >
                        {formatEvent(event)}
                      </div>
                    ))
                  ) : (
                    <div className="empty-logs">
                      No {categoryLabels[logCategory]} logs yet.
                    </div>
                  )}
                </div>
                <div className="log-actions">
                  <button
                    className="btn-primary btn-setting"
                    onClick={handleSnapshotState}
                  >
                    <TerminalSquare size={16} /> Snapshot state
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer className="desk-footer">
        <a
          className="repo-link"
          href="https://github.com/jomi-se/ffmpeg-edge"
          target="_blank"
          rel="noreferrer"
        >
          <Github size={14} /> View source on GitHub
        </a>
      </footer>
    </main>
  );
}

function getFileKind(
  file: File | null,
): "audio" | "video" | "image" | "unknown" {
  if (!file) return "unknown";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  return "unknown";
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API can be unavailable (e.g. non-secure context); fall back.
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

function getBrowserRuntimeStatus() {
  return {
    secureContext: window.isSecureContext,
    cacheApi: "caches" in window,
    indexedDb: "indexedDB" in window,
  };
}

async function getServiceWorkerDebugStatus(): Promise<string> {
  if (!("serviceWorker" in navigator)) {
    return "unsupported";
  }

  const controller = navigator.serviceWorker.controller;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const scope = registration?.scope ?? "none";
    const activeState = registration?.active?.state ?? "none";
    return `controller=${controller ? "yes" : "no"}, scope=${scope}, active=${activeState}`;
  } catch (error) {
    return `controller=${controller ? "yes" : "no"}, registrationError=${errorMessage(error)}`;
  }
}

function formatCoreMode(
  coreMode: ReturnType<typeof getFfmpegRuntimeStatus>["coreMode"],
) {
  if (coreMode === "not-loaded") return "Ready to load";
  if (coreMode === "single-thread") return "Single-thread";
  return "Multithread";
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
