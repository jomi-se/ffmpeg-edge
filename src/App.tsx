import {
  ArrowUp,
  ChevronLeft,
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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  argsToCommand,
  commandToChips,
  parseCommandLine,
  suggestedOutputName,
  validateCommandArgs,
} from "./lib/command";
import {
  ensureFfmpeg,
  getFfmpegDebugSnapshot,
  getFfmpegRuntimeStatus,
  getMediaElementMetadata,
  runFfmpegCommand,
  type MediaMetadata,
} from "./lib/media";
import {
  defaultModelId,
  ensureLocalModel,
  modelPresets,
  planCommand,
} from "./lib/planner";
import { hasOPFSSupport, saveOutput } from "./lib/storage";

const starterPrompt =
  "Compress for sharing, keep broad compatibility, and preserve reasonable quality.";

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
  const [useModel, setUseModel] = useState(false);
  const [modelId, setModelId] = useState(defaultModelId);
  const [modelStatus, setModelStatus] = useState("Not loaded");
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputName, setOutputName] = useState<string | null>(null);
  const [ffmpegStatus, setFfmpegStatus] = useState(
    "FFmpeg loads automatically when you run a command.",
  );
  const [runtimeStatus, setRuntimeStatus] = useState(getFfmpegRuntimeStatus());
  const [browserStatus, setBrowserStatus] = useState(getBrowserRuntimeStatus());
  const activeFileRef = useRef<File | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const chips = useMemo(() => commandToChips(args), [args]);
  const fileKind = getFileKind(file);
  const selectedModelPreset =
    modelPresets.find((preset) => preset.id === modelId) ?? modelPresets[0];
  const validation = useMemo(
    () => (file ? validateCommandArgs(args, file.name) : null),
    [args, file],
  );
  const canRun = !!file && args.length > 0 && !busy && validation?.ok !== false;

  useEffect(() => {
    const interval = window.setInterval(() => {
      const newRuntime = getFfmpegRuntimeStatus();
      const newBrowser = getBrowserRuntimeStatus();
      setRuntimeStatus((prev) =>
        JSON.stringify(prev) === JSON.stringify(newRuntime) ? prev : newRuntime,
      );
      setBrowserStatus((prev) =>
        JSON.stringify(prev) === JSON.stringify(newBrowser) ? prev : newBrowser,
      );
    }, 2000);
    return () => window.clearInterval(interval);
  }, []);

  useLayoutEffect(() => {
    const promptInput = promptRef.current;
    if (!promptInput) return;

    promptInput.style.height = "auto";
    promptInput.style.height = `${promptInput.scrollHeight}px`;
  }, [prompt]);

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
  }

  async function handleFile(nextFile: File | null) {
    activeFileRef.current = nextFile;
    setFile(nextFile);
    setMetadata(null);
    setLogs([]);
    setOutputUrl(null);
    setOutputName(null);

    if (!nextFile) {
      return;
    }

    setArgs(defaultArgsForFile(nextFile));
    setBusy("Reading metadata");
    try {
      const data = await getMediaElementMetadata(nextFile);
      if (activeFileRef.current === nextFile) {
        setMetadata(data);
      }
    } catch (e) {
      if (activeFileRef.current === nextFile) {
        setLogs((existing) => [
          ...existing,
          `Metadata error: ${errorMessage(e)}`,
        ]);
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
      });
      setArgs(result.args);
      setPrompt("");
    } catch (error) {
      setLogs((existing) => [
        ...existing,
        `Planner Error: ${errorMessage(error)}`,
      ]);
      setIsFlipped(true); // Flip to show error log
    } finally {
      setBusy(null);
    }
  }

  async function handleLoadModel() {
    const nextBrowserStatus = getBrowserRuntimeStatus();
    setBrowserStatus(nextBrowserStatus);
    if (!nextBrowserStatus.webGpu) {
      setModelStatus("Cannot load model: this browser does not expose WebGPU.");
      return;
    }

    setBusy("Loading local model");
    setModelStatus(`Starting ${selectedModelPreset.name} load`);
    try {
      await ensureLocalModel(modelId, (report) => {
        setModelStatus(`${Math.round(report.progress * 100)}% ${report.text}`);
      });
      setUseModel(true);
      setModelStatus("Local model ready");
    } catch (error) {
      setModelStatus(`Model load failed: ${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleLoadFfmpeg() {
    setBusy("Loading FFmpeg core");
    setLogs([]);
    try {
      await ensureFfmpeg(addFfmpegEvent);
      setRuntimeStatus(getFfmpegRuntimeStatus());
    } catch (error) {
      setRuntimeStatus(getFfmpegRuntimeStatus());
      setLogs((existing) => [
        ...existing,
        `FFmpeg Error: ${errorMessage(error)}`,
      ]);
    } finally {
      setBusy(null);
    }
  }

  async function handleAddDebugSnapshot() {
    const nextRuntimeStatus = getFfmpegRuntimeStatus();
    const nextBrowserStatus = getBrowserRuntimeStatus();
    const serviceWorkerStatus = await getServiceWorkerDebugStatus();
    setRuntimeStatus(nextRuntimeStatus);
    setBrowserStatus(nextBrowserStatus);
    setLogs((existing) => [
      ...existing,
      "",
      ...getFfmpegDebugSnapshot(),
      `Browser: secureContext=${nextBrowserStatus.secureContext}, webGpu=${nextBrowserStatus.webGpu}, cacheApi=${nextBrowserStatus.cacheApi}, indexedDb=${nextBrowserStatus.indexedDb}`,
      `Service worker: ${serviceWorkerStatus}`,
      `User agent: ${navigator.userAgent}`,
    ]);
  }

  async function handleRun() {
    if (!file) return;
    setBusy("Running FFmpeg");
    setLogs([]);
    setProgress(0);
    setOutputUrl(null);
    setOutputName(null);

    try {
      const result = await runFfmpegCommand(
        { file, args },
        (message) => setLogs((existing) => [...existing.slice(-120), message]),
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
        } catch (error) {
          setLogs((existing) => [
            ...existing,
            `Storage Warning: Output download is ready, but OPFS save failed: ${errorMessage(error)}`,
          ]);
        }
      }
    } catch (error) {
      setRuntimeStatus(getFfmpegRuntimeStatus());
      addFfmpegEvent(`FFmpeg run failed: ${errorMessage(error)}`);
      setIsFlipped(true);
    } finally {
      setBusy(null);
    }
  }

  async function handleSelfCorrect() {
    const failure = logs.slice(-20).join("\n");
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
                {busy && busy.includes("Planning") ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <ArrowUp size={16} strokeWidth={3} />
                )}
              </button>
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
                    <dd>
                      {browserStatus.webGpu ? "Available" : "Unavailable"}
                    </dd>
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
                <label>Run logs</label>
                <div className="logs-container">
                  {logs.length > 0 ? (
                    logs.join("\n")
                  ) : (
                    <div className="empty-logs">
                      No logs yet. Run a command to see FFmpeg output here.
                    </div>
                  )}
                </div>
                <div className="log-actions">
                  <button
                    className="btn-primary btn-setting"
                    disabled={!!busy}
                    onClick={handleAddDebugSnapshot}
                  >
                    <TerminalSquare size={16} /> Add debug snapshot
                  </button>
                  {logs.length > 0 && (
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
