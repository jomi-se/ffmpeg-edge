import {
  Bot,
  CircleStop,
  Database,
  Download,
  FileAudio,
  FileImage,
  FileVideo,
  Info,
  LoaderCircle,
  Mic,
  Play,
  Save,
  Search,
  Settings2,
  Sparkles,
  TerminalSquare,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  argsToCommand,
  commandLineToArgs,
  commandToChips,
  parseCommandLine,
  suggestedOutputName,
  validateCommandArgs,
} from "./lib/command";
import {
  ensureFfmpeg,
  getFfmpegRuntimeStatus,
  getMediaElementMetadata,
  probeWithFfmpeg,
  runFfmpegCommand,
  type MediaMetadata,
} from "./lib/media";
import {
  defaultModelId,
  ensureLocalModel,
  modelPresets,
  planCommand,
  searchFfmpegDocs,
  type PlanResult,
} from "./lib/planner";
import {
  hasOPFSSupport,
  listOutputs,
  readOutput,
  removeOutput,
  saveOutput,
  type StoredOutput,
} from "./lib/storage";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const starterPrompt =
  "Compress this for sharing, keep it broadly compatible, and preserve reasonable quality.";

export function App() {
  const [file, setFile] = useState<File | null>(null);
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null);
  const [prompt, setPrompt] = useState(starterPrompt);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Drop in audio, video, or an image. I will use local FFmpeg docs plus file metadata to propose a command you can inspect and edit.",
    },
  ]);
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
  const [rawCommand, setRawCommand] = useState(argsToCommand(args));
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [useModel, setUseModel] = useState(false);
  const [modelId, setModelId] = useState(defaultModelId);
  const [modelStatus, setModelStatus] = useState("Not loaded");
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputName, setOutputName] = useState<string | null>(null);
  const [savedOutputs, setSavedOutputs] = useState<StoredOutput[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [modelEvents, setModelEvents] = useState<string[]>([]);
  const [ffmpegStatus, setFfmpegStatus] = useState(
    "FFmpeg core loads automatically on probe or run.",
  );
  const [ffmpegEvents, setFfmpegEvents] = useState<string[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState(getFfmpegRuntimeStatus());
  const [browserStatus, setBrowserStatus] = useState(getBrowserRuntimeStatus());
  const [speechDisclosureAccepted, setSpeechDisclosureAccepted] =
    useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

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
    refreshSavedOutputs();
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setRuntimeStatus(getFfmpegRuntimeStatus());
      setBrowserStatus(getBrowserRuntimeStatus());
    }, 2000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setRawCommand(argsToCommand(args));
  }, [args]);

  async function refreshSavedOutputs() {
    setSavedOutputs(await listOutputs().catch(() => []));
  }

  function addModelEvent(message: string) {
    setModelEvents((existing) => [
      ...existing.slice(-9),
      `${new Date().toLocaleTimeString()} ${message}`,
    ]);
  }

  function addFfmpegEvent(message: string) {
    setFfmpegStatus(message);
    setFfmpegEvents((existing) => [
      ...existing.slice(-9),
      `${new Date().toLocaleTimeString()} ${message}`,
    ]);
  }

  function handleModelPresetChange(nextModelId: string) {
    const preset =
      modelPresets.find((candidate) => candidate.id === nextModelId) ??
      modelPresets[0];
    setModelId(preset.id);
    setUseModel(false);
    setModelStatus(`${preset.name} selected. Load it before local planning.`);
    addModelEvent(`${preset.name} selected. Local planning is paused.`);
  }

  async function handleFile(nextFile: File | null) {
    setFile(nextFile);
    setPlan(null);
    setLogs([]);
    setOutputUrl(null);
    setOutputName(null);

    if (!nextFile) {
      setMetadata(null);
      return;
    }

    setArgs(defaultArgsForFile(nextFile));
    setBusy("Reading metadata");
    try {
      setMetadata(await getMediaElementMetadata(nextFile));
      setMessages((existing) => [
        ...existing,
        {
          role: "system",
          content: `Loaded ${nextFile.name} (${formatBytes(nextFile.size)}). Run ffprobe for stream-level details before complex commands.`,
        },
      ]);
    } finally {
      setBusy(null);
    }
  }

  async function handleProbe() {
    if (!file) return;
    setBusy("Running ffprobe");
    setLogs([]);

    try {
      const probed = await probeWithFfmpeg(
        file,
        (message) => setLogs((existing) => [...existing.slice(-80), message]),
        addFfmpegEvent,
      );
      setRuntimeStatus(getFfmpegRuntimeStatus());
      addFfmpegEvent("ffprobe finished.");
      setMetadata(probed);
      setMessages((existing) => [
        ...existing,
        {
          role: "system",
          content: `ffprobe found ${probed.streams?.length ?? 0} stream(s). Future plans will include stream metadata.`,
        },
      ]);
    } catch (error) {
      setRuntimeStatus(getFfmpegRuntimeStatus());
      addFfmpegEvent(`ffprobe failed: ${errorMessage(error)}`);
      setMessages((existing) => [
        ...existing,
        { role: "assistant", content: errorMessage(error) },
      ]);
    } finally {
      setBusy(null);
    }
  }

  async function handlePlan(promptOverride?: string) {
    const activePrompt = promptOverride ?? prompt;
    setBusy(
      useModel ? "Planning with local model" : "Planning with local docs",
    );
    setMessages((existing) => [
      ...existing,
      { role: "user", content: activePrompt },
    ]);

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
      setPlan(result);
      setArgs(result.args);
      if (result.warning) addModelEvent(result.warning);
      setMessages((existing) => [
        ...existing,
        {
          role: "assistant",
          content: `${result.explanation} Source: ${result.source}.${result.warning ? ` ${result.warning}` : ""}`,
        },
      ]);
    } catch (error) {
      setMessages((existing) => [
        ...existing,
        { role: "assistant", content: errorMessage(error) },
      ]);
    } finally {
      setBusy(null);
    }
  }

  async function handleLoadModel() {
    const nextBrowserStatus = getBrowserRuntimeStatus();
    setBrowserStatus(nextBrowserStatus);
    if (!nextBrowserStatus.webGpu) {
      const message =
        "WebGPU is unavailable. Open this app on HTTPS or localhost in a WebGPU-capable browser before loading a local planner model.";
      setModelStatus(`Load blocked: ${message}`);
      addModelEvent(message);
      return;
    }

    setBusy("Loading local model");
    setModelStatus(`Starting ${selectedModelPreset.name} load`);
    addModelEvent(
      nextBrowserStatus.cacheApi
        ? `Starting ${selectedModelPreset.name} load with browser Cache API available.`
        : `Starting ${selectedModelPreset.name} load with IndexedDB artifact cache because Cache API is unavailable.`,
    );
    try {
      await ensureLocalModel(modelId, (report) => {
        const status = `${Math.round(report.progress * 100)}% ${report.text}`;
        setModelStatus(status);
        addModelEvent(status);
      });
      setUseModel(true);
      setModelStatus("Ready");
      addModelEvent(`${selectedModelPreset.name} is ready for local planning.`);
    } catch (error) {
      const message = errorMessage(error);
      setModelStatus(`Load failed: ${message}`);
      addModelEvent(`Load failed. You can retry without reloading: ${message}`);
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
      setMessages((existing) => [
        ...existing,
        { role: "assistant", content: errorMessage(error) },
      ]);
    } finally {
      setBusy(null);
    }
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
      setMessages((existing) => [
        ...existing,
        {
          role: "assistant",
          content:
            result.exitCode === 0
              ? `FFmpeg finished in ${(result.elapsedMs / 1000).toFixed(1)}s.`
              : `FFmpeg exited with code ${result.exitCode}. The log is ready for self-correction.`,
        },
      ]);

      if (result.outputBlob && hasOPFSSupport()) {
        try {
          await saveOutput(result.outputName, result.outputBlob);
          await refreshSavedOutputs();
        } catch (error) {
          setMessages((existing) => [
            ...existing,
            {
              role: "assistant",
              content: `FFmpeg output is ready to download, but OPFS save failed: ${errorMessage(error)}`,
            },
          ]);
        }
      }
    } catch (error) {
      setRuntimeStatus(getFfmpegRuntimeStatus());
      addFfmpegEvent(`FFmpeg run failed: ${errorMessage(error)}`);
      setMessages((existing) => [
        ...existing,
        { role: "assistant", content: errorMessage(error) },
      ]);
    } finally {
      setBusy(null);
    }
  }

  async function handleSelfCorrect() {
    const failure = logs.slice(-20).join("\n");
    const correctionPrompt = `The FFmpeg command failed. Current command: ${argsToCommand(args)}\nError log:\n${failure}\nReturn a corrected command.`;
    setPrompt(correctionPrompt);
    await handlePlan(correctionPrompt);
  }

  function syncRawCommand() {
    setArgs(commandLineToArgs(rawCommand, file?.name));
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

  function startListening() {
    if (!speechDisclosureAccepted) {
      const accepted = window.confirm(
        "Speech recognition is provided by your browser and may use that browser vendor's remote service. Source media still stays local. Continue?",
      );
      if (!accepted) return;
      setSpeechDisclosureAccepted(true);
    }

    const SpeechRecognitionClass =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      setMessages((existing) => [
        ...existing,
        {
          role: "assistant",
          content: "This browser does not expose the Web Speech API.",
        },
      ]);
      return;
    }

    const recognition = new SpeechRecognitionClass();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) setPrompt(transcript);
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);
    recognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setIsListening(false);
  }

  async function downloadSaved(name: string) {
    const saved = await readOutput(name);
    const url = URL.createObjectURL(saved);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function deleteSaved(name: string) {
    if (!window.confirm(`Are you sure you want to delete "${name}"?`)) return;
    await removeOutput(name);
    await refreshSavedOutputs();
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Gemma assists. FFmpeg leads.</p>
          <h1>FFmpeg Catalyst</h1>
        </div>
        <a
          className="text-link"
          href="https://ffmpeg.org/"
          target="_blank"
          rel="noreferrer"
        >
          Official FFmpeg
        </a>
      </header>

      <section className="workspace" aria-label="FFmpeg Catalyst workspace">
        <aside className="left-rail">
          <section className="panel upload-panel">
            <div className="panel-title">
              <Upload size={18} />
              <h2>Source</h2>
            </div>
            <label className="drop-zone">
              <input
                type="file"
                accept="audio/*,video/*,image/*"
                onChange={(event) =>
                  handleFile(event.target.files?.[0] ?? null)
                }
              />
              <span className={`file-kind ${fileKind}`}>
                {fileKind === "audio" ? (
                  <FileAudio />
                ) : fileKind === "image" ? (
                  <FileImage />
                ) : (
                  <FileVideo />
                )}
              </span>
              <strong>
                {file ? file.name : "Choose audio, video, or image"}
              </strong>
              <small>
                {file
                  ? formatBytes(file.size)
                  : "Everything stays on this device"}
              </small>
            </label>
            <button
              className="secondary-button"
              disabled={!file || !!busy}
              onClick={handleProbe}
            >
              <Search size={16} />
              Probe with ffprobe
            </button>
            <MetadataView metadata={metadata} />
          </section>

          <section className="panel">
            <div className="panel-title">
              <Bot size={18} />
              <h2>Local Model</h2>
            </div>
            <label className="field-label" htmlFor="model-preset">
              WebLLM model preset
            </label>
            <select
              id="model-preset"
              className="select-input"
              value={modelId}
              onChange={(event) => handleModelPresetChange(event.target.value)}
            >
              {modelPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} - {preset.recommendation}
                </option>
              ))}
            </select>
            <p className="preset-summary">
              <strong>{selectedModelPreset.recommendation}</strong>
              <span>{selectedModelPreset.summary}</span>
            </p>
            <div className="toggle-row">
              <label>
                <input
                  type="checkbox"
                  checked={useModel}
                  onChange={(event) => setUseModel(event.target.checked)}
                />
                Use loaded WebLLM model for planning
              </label>
            </div>
            <button
              className="secondary-button"
              disabled={!!busy}
              onClick={handleLoadModel}
            >
              {busy === "Loading local model" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Database size={16} />
              )}
              Load model
            </button>
            <p className="status-text">{modelStatus}</p>
            <p className="disclosure-text">
              Model files are fetched from Hugging Face and then cached by the
              browser. Media files are not uploaded.
            </p>
            <RuntimeStatus status={runtimeStatus} />
            <button
              className="secondary-button ffmpeg-load-button"
              disabled={!!busy}
              onClick={handleLoadFfmpeg}
            >
              {busy === "Loading FFmpeg core" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <TerminalSquare size={16} />
              )}
              Load FFmpeg core
            </button>
            <p className="status-text">{ffmpegStatus}</p>
            <BrowserStatus status={browserStatus} />
            <RuntimeDebug events={ffmpegEvents} />
            <ModelDebug events={modelEvents} />
          </section>
        </aside>

        <section className="center-stage">
          <section className="panel planner-panel">
            <div className="panel-title">
              <Sparkles size={18} />
              <h2>Intent</h2>
            </div>
            <textarea
              className="prompt-box"
              aria-label="Prompt for command intent"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              aria-label="Describe what you want to do with the file"
            />
            <div className="button-row">
              <button
                className="primary-button"
                disabled={!!busy}
                onClick={() => handlePlan()}
              >
                <Wand2 size={17} />
                Plan command
              </button>
              <button
                className={isListening ? "danger-button" : "secondary-button"}
                onClick={isListening ? stopListening : startListening}
              >
                {isListening ? <CircleStop size={17} /> : <Mic size={17} />}
                {isListening ? "Stop" : "Push to talk"}
              </button>
            </div>
          </section>

          <section className="panel command-panel">
            <div className="panel-title">
              <Settings2 size={18} />
              <h2>Option Builder</h2>
            </div>
            <div className="chip-grid">
              {chips.map((chip) => (
                <button
                  key={chip.id}
                  className={`chip ${chip.kind}`}
                  disabled={!chip.editable}
                  onClick={() => editChip(chip.id, chip.token)}
                  title={
                    chip.editable ? "Edit argument" : "Managed by Catalyst"
                  }
                >
                  <span>{chip.label}</span>
                  <code>{chip.token}</code>
                </button>
              ))}
            </div>
            <label className="field-label" htmlFor="raw-command">
              Raw command
            </label>
            <textarea
              id="raw-command"
              className="raw-command"
              value={rawCommand}
              onChange={(event) => setRawCommand(event.target.value)}
            />
            <div className="button-row">
              <button className="secondary-button" onClick={syncRawCommand}>
                <TerminalSquare size={16} />
                Sync to chips
              </button>
              <button
                className="primary-button"
                disabled={!canRun}
                onClick={handleRun}
              >
                {busy === "Running FFmpeg" ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Play size={17} />
                )}
                Run FFmpeg
              </button>
            </div>
            {validation && !validation.ok && (
              <ul className="validation-list">
                {validation.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            )}
            {busy === "Running FFmpeg" && (
              <div className="progress-track">
                <span style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
            {outputUrl && outputName && (
              <a
                className="download-callout"
                href={outputUrl}
                download={outputName}
              >
                <Download size={18} />
                Download {outputName}
              </a>
            )}
          </section>
        </section>

        <aside className="right-rail">
          <section className="panel chat-panel">
            <div className="panel-title">
              <Info size={18} />
              <h2>Session</h2>
            </div>
            <div className="messages">
              {messages.map((message, index) => (
                <p
                  key={`${message.role}-${index}`}
                  className={`message ${message.role}`}
                >
                  {message.content}
                </p>
              ))}
            </div>
          </section>

          <section className="panel docs-panel">
            <div className="panel-title">
              <Search size={18} />
              <h2>Retrieved Docs</h2>
            </div>
            {plan ? (
              <ul className="doc-list">
                {plan.docsUsed.map((doc) => (
                  <li key={doc.id}>
                    <a href={doc.url} target="_blank" rel="noreferrer">
                      {doc.title}
                    </a>
                    <span>{doc.syntax}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <DocsPreview prompt={prompt} />
            )}
          </section>

          <section className="panel outputs-panel">
            <div className="panel-title">
              <Save size={18} />
              <h2>Saved Outputs</h2>
            </div>
            <p className="status-text">
              {hasOPFSSupport()
                ? "OPFS available"
                : "OPFS unavailable in this browser"}
            </p>
            <ul className="output-list">
              {savedOutputs.map((output) => (
                <li key={output.name}>
                  <span>
                    <strong>{output.name}</strong>
                    <small>{formatBytes(output.size)}</small>
                  </span>
                  <button
                    onClick={() => downloadSaved(output.name)}
                    title="Download saved output"
                    aria-label={`Download ${output.name}`}
                  >
                    <Download size={15} />
                  </button>
                  <button
                    onClick={() => deleteSaved(output.name)}
                    title="Delete saved output"
                    aria-label={`Delete ${output.name}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel logs-panel">
            <div className="panel-title">
              <TerminalSquare size={18} />
              <h2>Logs</h2>
            </div>
            <pre>
              {logs.length ? logs.join("\n") : "FFmpeg logs will appear here."}
            </pre>
            <button
              className="secondary-button"
              disabled={!logs.length || !!busy}
              onClick={handleSelfCorrect}
            >
              <Wand2 size={16} />
              Ask planner to fix
            </button>
          </section>
        </aside>
      </section>
    </main>
  );
}

function MetadataView({ metadata }: { metadata: MediaMetadata | null }) {
  if (!metadata) {
    return <p className="status-text">No file loaded.</p>;
  }

  return (
    <dl className="metadata-grid">
      <div>
        <dt>Type</dt>
        <dd>{metadata.type || "unknown"}</dd>
      </div>
      <div>
        <dt>Size</dt>
        <dd>{formatBytes(metadata.size)}</dd>
      </div>
      {metadata.duration !== undefined && (
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(metadata.duration)}</dd>
        </div>
      )}
      {metadata.width && metadata.height && (
        <div>
          <dt>Frame</dt>
          <dd>
            {metadata.width}x{metadata.height}
          </dd>
        </div>
      )}
      {metadata.streams && (
        <div>
          <dt>Streams</dt>
          <dd>{metadata.streams.length}</dd>
        </div>
      )}
    </dl>
  );
}

function DocsPreview({ prompt }: { prompt: string }) {
  const [docs, setDocs] = useState<
    Array<{ id: string; title: string; syntax: string; url: string }>
  >([]);

  useEffect(() => {
    let cancelled = false;
    searchFfmpegDocs(prompt).then((results) => {
      if (!cancelled) setDocs(results);
    });
    return () => {
      cancelled = true;
    };
  }, [prompt]);

  return (
    <ul className="doc-list">
      {docs.map((doc) => (
        <li key={doc.id}>
          <a href={doc.url} target="_blank" rel="noreferrer">
            {doc.title}
          </a>
          <span>{doc.syntax}</span>
        </li>
      ))}
    </ul>
  );
}

function RuntimeStatus({
  status,
}: {
  status: ReturnType<typeof getFfmpegRuntimeStatus>;
}) {
  const canReloadForIsolation =
    window.isSecureContext && !status.crossOriginIsolated;

  return (
    <>
      <dl className="runtime-grid">
        <div>
          <dt>Isolation</dt>
          <dd>{status.crossOriginIsolated ? "Ready" : "Needs reload"}</dd>
        </div>
        <div>
          <dt>SharedArrayBuffer</dt>
          <dd>{status.sharedArrayBuffer ? "Available" : "Unavailable"}</dd>
        </div>
        <div>
          <dt>FFmpeg core</dt>
          <dd>{formatCoreMode(status.coreMode)}</dd>
        </div>
      </dl>
      {canReloadForIsolation && (
        <button
          className="secondary-button isolation-button"
          onClick={() => window.location.reload()}
        >
          Reload for isolation
        </button>
      )}
    </>
  );
}

function RuntimeDebug({ events }: { events: string[] }) {
  return (
    <details className="debug-details">
      <summary>FFmpeg debug</summary>
      <ol>
        {events.length ? (
          events.map((event, index) => (
            <li key={`${event}-${index}`}>{event}</li>
          ))
        ) : (
          <li>No FFmpeg core events yet.</li>
        )}
      </ol>
    </details>
  );
}

function BrowserStatus({
  status,
}: {
  status: ReturnType<typeof getBrowserRuntimeStatus>;
}) {
  return (
    <dl className="runtime-grid browser-grid">
      <div>
        <dt>Secure</dt>
        <dd>{status.secureContext ? "Yes" : "No"}</dd>
      </div>
      <div>
        <dt>WebGPU</dt>
        <dd>{status.webGpu ? "Available" : "Unavailable"}</dd>
      </div>
      <div>
        <dt>Model cache</dt>
        <dd>
          {status.cacheApi
            ? "Cache API"
            : status.indexedDb
              ? "IndexedDB"
              : "Unavailable"}
        </dd>
      </div>
    </dl>
  );
}

function formatCoreMode(
  coreMode: ReturnType<typeof getFfmpegRuntimeStatus>["coreMode"],
) {
  if (coreMode === "not-loaded") return "Ready to load";
  if (coreMode === "single-thread") return "Single-thread";
  return "Multithread";
}

function ModelDebug({ events }: { events: string[] }) {
  return (
    <details className="debug-details">
      <summary>Model debug</summary>
      <ol>
        {events.length ? (
          events.map((event, index) => (
            <li key={`${event}-${index}`}>{event}</li>
          ))
        ) : (
          <li>No model load events yet.</li>
        )}
      </ol>
    </details>
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
