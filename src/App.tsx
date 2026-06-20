import {
  ArrowUp,
  Check,
  ChevronLeft,
  Copy,
  Cpu,
  Database,
  Download,
  FileAudio,
  FileImage,
  FileVideo,
  LoaderCircle,
  Play,
  Settings2,
  TerminalSquare,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  argsToCommand,
  commandToChips,
  parseCommandLine,
  suggestedOutputName,
  validateCommandArgs,
} from "./lib/command";
import {
  ensureFfmpeg,
  getFfmpegRuntimeStatus,
  getMediaElementMetadata,
  logFfmpegState,
  runFfmpegCommand,
  type MediaMetadata,
} from "./lib/media";
import {
  defaultModelId,
  ensureLocalModel,
  isModelCached,
  logModelState,
  modelPresets,
  planCommand,
  probeWebGpu,
  type WebGpuStatus,
} from "./lib/planner";
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

const starterPrompt =
  "Compress for sharing, keep broad compatibility, and preserve reasonable quality.";

const categoryLabels: Record<LogCategory, string> = {
  app: "App flow",
  model: "Model",
  ffmpeg: "FFmpeg",
  sw: "Service worker",
};

export function App() {
  const [isFlipped, setIsFlipped] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null);
  const [prompt, setPrompt] = useState(starterPrompt);

  const [args, setArgs] = useState<string[]>([
    "-i",
    "$INPUT",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "24",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "$OUTPUT",
  ]);
  const [lastPlannedPrompt, setLastPlannedPrompt] = useState<string | null>(
    null,
  );
  const [useModel, setUseModel] = useState(false);
  const [modelId, setModelId] = useState(defaultModelId);
  const [modelStatus, setModelStatus] = useState("Not loaded");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputName, setOutputName] = useState<string | null>(null);
  const [ffmpegStatus, setFfmpegStatus] = useState(
    "FFmpeg loads automatically when you run a command.",
  );
  const [runtimeStatus, setRuntimeStatus] = useState(getFfmpegRuntimeStatus());
  const [webGpu, setWebGpu] = useState<WebGpuStatus | null>(null);
  const [logCategory, setLogCategory] = useState<LogCategory>("app");
  const [logsCopied, setLogsCopied] = useState(false);
  const activeFileRef = useRef<File | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Live view of the unified event log.
  const logVersion = useSyncExternalStore(subscribe, getLogVersion);
  const events = useMemo(() => getLog(logCategory), [logCategory, logVersion]);
  const ffmpegLogCount = useMemo(() => getLog("ffmpeg").length, [logVersion]);

  const chips = useMemo(() => commandToChips(args), [args]);
  const fileKind = getFileKind(file);
  const selectedModelPreset =
    modelPresets.find((preset) => preset.id === modelId) ?? modelPresets[0];
  const webGpuLabel = describeWebGpu(webGpu);
  const planning = !!busy && busy.includes("Planning");
  const validation = useMemo(
    () => (file ? validateCommandArgs(args, file.name) : null),
    [args, file],
  );
  const canRun = !!file && args.length > 0 && !busy && validation?.ok !== false;

  useEffect(() => {
    const interval = window.setInterval(() => {
      const newRuntime = getFfmpegRuntimeStatus();
      setRuntimeStatus((prev) =>
        JSON.stringify(prev) === JSON.stringify(newRuntime) ? prev : newRuntime,
      );
    }, 2000);
    return () => window.clearInterval(interval);
  }, []);

  // On startup: probe WebGPU and, if the model is already cached AND a GPU
  // adapter is available, auto-load + enable it (never triggers a download).
  useEffect(() => {
    let active = true;
    (async () => {
      log.info("app", "App started", { userAgent: navigator.userAgent });
      const gpu = await probeWebGpu();
      if (!active) return;
      setWebGpu(gpu);
      if (!gpu.adapterAvailable) return;

      const cached = await isModelCached(defaultModelId).catch(() => false);
      if (!active || !cached) {
        if (active && !cached) {
          log.info("app", "Model not cached; skipping auto-load", {
            modelId: defaultModelId,
          });
        }
        return;
      }

      log.info("app", "Cached model detected; auto-loading", {
        modelId: defaultModelId,
      });
      setModelStatus("Auto-loading cached model…");
      try {
        await ensureLocalModel(defaultModelId, (report) => {
          if (active) {
            setModelStatus(
              `${Math.round(report.progress * 100)}% ${report.text}`,
            );
          }
        });
        if (!active) return;
        setUseModel(true);
        setModelStatus("Local model ready (auto-loaded from cache)");
        log.info("app", "Cached model auto-loaded", {
          modelId: defaultModelId,
        });
      } catch (error) {
        if (!active) return;
        setModelStatus(`Auto-load failed: ${errorMessage(error)}`);
        log.error("app", "Cached model auto-load failed", {
          error: errorMessage(error),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useLayoutEffect(() => {
    const promptInput = promptRef.current;
    if (!promptInput) return;

    promptInput.style.height = "auto";
    promptInput.style.height = `${promptInput.scrollHeight}px`;
  }, [prompt]);

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

  function handleModelPresetChange(nextModelId: string) {
    const preset =
      modelPresets.find((candidate) => candidate.id === nextModelId) ??
      modelPresets[0];
    setModelId(preset.id);
    setUseModel(false);
    setModelStatus(
      `${preset.name} selected. Load it to plan with the local model.`,
    );
    log.info("app", "Model preset changed", { modelId: preset.id });
  }

  async function handleFile(nextFile: File | null) {
    activeFileRef.current = nextFile;
    setFile(nextFile);
    setMetadata(null);
    setOutputUrl(null);
    setOutputName(null);
    setLastPlannedPrompt(null);

    if (!nextFile) {
      return;
    }

    log.info("app", "File selected", {
      name: nextFile.name,
      size: nextFile.size,
      type: nextFile.type,
    });
    setArgs(defaultArgsForFile(nextFile));
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

  async function handlePlan(promptOverride?: string) {
    const activePrompt = promptOverride ?? prompt;
    if (!activePrompt.trim()) return;

    log.info("app", "Plan requested", {
      modelId,
      promptLength: activePrompt.length,
      useModel,
    });
    setBusy(
      useModel ? "Planning with local model" : "Planning with local docs",
    );

    try {
      const result = await planCommand({
        prompt: activePrompt,
        file: file ?? undefined,
        metadata,
        useLocalModel: useModel,
        modelId,
        onModelProgress: (report) =>
          setModelStatus(
            `${Math.round(report.progress * 100)}% ${report.text}`,
          ),
        onPlanStatus: (status) => setModelStatus(status),
      });
      setArgs(result.args);
      setLastPlannedPrompt(activePrompt.trim());
      setPrompt("");
      log.info("app", "Plan ready", {
        args: result.args,
        commandLine: result.commandLine,
        source: result.source,
      });
      if (result.warning) {
        log.warn("app", result.warning);
      }
    } catch (error) {
      log.error("app", "Planning failed", {
        error: errorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      setLogCategory("model");
      setIsFlipped(true);
    } finally {
      setBusy(null);
    }
  }

  async function handleLoadModel() {
    log.info("app", "Load local model requested", { modelId });
    setBusy("Checking WebGPU");
    setModelStatus("Checking WebGPU support…");
    const gpu = await probeWebGpu();
    setWebGpu(gpu);

    if (!gpu.apiPresent || !gpu.adapterAvailable) {
      setBusy(null);
      const detail = gpu.error ?? "WebGPU is not usable in this browser.";
      setModelStatus(`Cannot load model: ${detail}`);
      log.error("app", "Cannot load model: WebGPU unusable", { detail });
      return;
    }
    if (!gpu.shaderF16) {
      log.warn("app", "GPU adapter missing shader-f16; load may fail", {
        detail: gpu.error,
      });
    }

    setBusy("Loading local model");
    setModelStatus(`Starting ${selectedModelPreset.name} load`);
    try {
      await ensureLocalModel(modelId, (report) => {
        setModelStatus(`${Math.round(report.progress * 100)}% ${report.text}`);
      });
      setUseModel(true);
      setModelStatus("Local model ready");
      log.info("app", "Local model loaded", { modelId });
    } catch (error) {
      setModelStatus(`Model load failed: ${errorMessage(error)}`);
      log.error("app", "Local model load failed", {
        error: errorMessage(error),
      });
    } finally {
      setBusy(null);
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
    const gpu = await probeWebGpu();
    setWebGpu(gpu);
    logModelState();
    logFfmpegState();
    const serviceWorkerStatus = await getServiceWorkerDebugStatus();
    log.info("app", "Environment snapshot", {
      browser: getBrowserRuntimeStatus(),
      serviceWorker: serviceWorkerStatus,
      ui: {
        ffmpegStatus,
        modelStatus,
        preset: selectedModelPreset.name,
        selectedModel: modelId,
        useModel,
      },
      userAgent: navigator.userAgent,
    });
  }

  async function handleCopyLogs() {
    const text = formatEvents(getLog(logCategory));
    if (!text) return;
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

  async function handleSelfCorrect() {
    const failure = formatEvents(getLog("ffmpeg").slice(-20));
    const correctionPrompt = `The FFmpeg command failed. Current command: ${argsToCommand(args)}\nError log:\n${failure}\nReturn a corrected command.`;
    setPrompt(correctionPrompt);
    setIsFlipped(false);
    await handlePlan(correctionPrompt);
  }

  function editChip(indexToken: string, token: string) {
    const index = Number(indexToken.split("-")[0]);
    if (!Number.isFinite(index)) return;

    const replacement = window.prompt("Edit FFmpeg argument(s)", token);
    if (replacement === null) return;

    const parsed = parseCommandLine(replacement);
    setArgs((current) => {
      const next = [...current];
      const replacesPair =
        token.includes(" ") && current[index + 1] !== undefined;
      next.splice(index, replacesPair ? 2 : 1, ...parsed);
      return next;
    });
  }

  return (
    <main className="app-main">
      <header className="desk-header">
        <h1>Local Media Converter</h1>
        <p>
          Convert audio, video, and images in your browser with FFmpeg. Your
          files stay on your device.
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
                  disabled={!!busy}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            )}

            {/* Command & Run */}
            {file && (
              <div className="command-section">
                <div className="command-header">
                  <h2 className="text-muted">Review FFmpeg args</h2>
                </div>
                {lastPlannedPrompt && (
                  <p className="command-prompt-echo">
                    <Wand2 size={13} />
                    <span>{lastPlannedPrompt}</span>
                  </p>
                )}
                <div className="chip-grid">
                  {chips.map((chip) => (
                    <button
                      key={chip.id}
                      className="chip"
                      disabled={!chip.editable || !!busy}
                      data-editable={chip.editable}
                      onClick={() => editChip(chip.id, chip.token)}
                      title={chip.editable ? "Edit argument" : "Managed"}
                    >
                      <span className="chip-label">{chip.label}</span>
                      <span>{chip.token}</span>
                    </button>
                  ))}
                </div>

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
                  <div className="action-row mt-2">
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

            {/* Chat Bubble / Planner */}
            <div className="planner">
              <div className="planner-meta">
                <span
                  className={`mode-badge ${useModel ? "mode-model" : "mode-builtin"}`}
                  title={
                    useModel
                      ? `Planning with the local model (${modelStatus})`
                      : "Planning with the built-in deterministic planner"
                  }
                >
                  {planning ? (
                    <LoaderCircle className="spin" size={12} />
                  ) : (
                    <Cpu size={12} />
                  )}
                  {planning
                    ? "Planning…"
                    : useModel
                      ? `Local model · ${selectedModelPreset.name}`
                      : "Built-in planner"}
                </span>
              </div>
              <div className="planner-bubble">
                <textarea
                  ref={promptRef}
                  placeholder="Describe the output you want, for example: compress to 720p"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onFocus={() => {
                    if (prompt === starterPrompt) {
                      setPrompt("");
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handlePlan();
                    }
                  }}
                  disabled={!!busy}
                />
                <button
                  className="btn-send"
                  onClick={() => handlePlan()}
                  disabled={!!busy || !prompt.trim()}
                  title="Plan FFmpeg args"
                >
                  {planning ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <ArrowUp size={16} strokeWidth={3} />
                  )}
                </button>
              </div>
            </div>
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
              >
                <ChevronLeft size={20} />
              </button>
              <h2 className="text-muted">Runtime and logs</h2>
              <div className="header-spacer"></div>
            </div>

            <div className="settings-grid">
              <div className="setting-group">
                <label>Local planner model</label>
                <select
                  className="input-select"
                  value={modelId}
                  onChange={(event) =>
                    handleModelPresetChange(event.target.value)
                  }
                  disabled={!!busy}
                >
                  {modelPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} - {preset.recommendation}
                    </option>
                  ))}
                </select>
                <div className="setting-checkbox">
                  <input
                    type="checkbox"
                    id="use-model"
                    checked={useModel}
                    onChange={(event) => setUseModel(event.target.checked)}
                    disabled={!!busy}
                  />
                  <label htmlFor="use-model">
                    Use local model for planning
                  </label>
                </div>
                <button
                  className="btn-primary btn-setting"
                  disabled={!!busy}
                  onClick={handleLoadModel}
                >
                  <Database size={16} /> Load local model
                </button>
                <div className="text-muted text-sm mt-1">
                  Status: {modelStatus}
                </div>
              </div>

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
                  <div className="status-item">
                    <dt>WebGPU</dt>
                    <dd title={webGpu?.error ?? undefined}>{webGpuLabel}</dd>
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
                  {ffmpegLogCount > 0 && (
                    <button
                      className="btn-primary btn-setting"
                      disabled={!!busy}
                      onClick={handleSelfCorrect}
                    >
                      <Wand2 size={16} /> Replan from logs
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
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

function describeWebGpu(status: WebGpuStatus | null): string {
  if (!status) return "Checking…";
  if (!status.apiPresent) return "Unavailable";
  if (!status.adapterAvailable) return "No GPU adapter";
  if (!status.shaderF16) return "No shader-f16";
  return "Available";
}

function getBrowserRuntimeStatus() {
  return {
    secureContext: window.isSecureContext,
    webGpu: "gpu" in navigator,
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

function defaultArgsForFile(file: File): string[] {
  if (file.type.startsWith("image/")) {
    return [
      "-i",
      "$INPUT",
      "-vf",
      "scale=1600:-1",
      suggestedOutputName(file.name, "webp"),
    ];
  }
  if (file.type.startsWith("audio/")) {
    return [
      "-i",
      "$INPUT",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      suggestedOutputName(file.name, "mp3"),
    ];
  }
  return [
    "-i",
    "$INPUT",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "24",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    suggestedOutputName(file.name, "mp4"),
  ];
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
