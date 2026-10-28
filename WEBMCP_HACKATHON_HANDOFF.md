# WebMCP Hackathon Handoff: Agent-Controlled Local Media Converter

## Mission

Extend **Local Media Converter / FFmpeg Edge** with WebMCP so a browser-hosted
agent can inspect the media file the user selected, configure a safe FFmpeg
conversion, run it locally, and observe the result.

The product promise stays simple:

> Tell your agent what you need. It configures and runs FFmpeg in the browser.
> The source media never leaves your device.

This is deliberately a small second submission for the 2026 WebMCP Challenge.
It is not the place to build a general agent framework, an in-app model, a
retrieval system, or a new UI architecture.

## Hackathon boundary

- Event: [The WebMCP Challenge](https://webmcp.devpost.com/)
- Submission deadline: **2026-09-03 20:00 UTC** (1:00 PM Pacific)
- This repository existed before the submission period. Mark the project as
  **Existing** and document only the work added after 2026-08-25.
- The submission needs its own live URL, public repository, visible open-source
  license, project description, and public YouTube demo under three minutes
  with audio.
- Recheck the live [official rules](https://webmcp.devpost.com/rules) before
  submission. Do not rely on this handoff as legal or deadline authority.
- The repository currently has **no root `LICENSE` file**. The hackathon
  requires one. Do not silently choose a license: ask the owner, then add the
  selected license before submission.

The repository currently has an unrelated untracked `PIVOT.md`. Preserve it
and do not include it in WebMCP commits unless the owner explicitly asks.

## Why WebMCP belongs here

The existing app already exposes the awkward boundary WebMCP can remove:

1. The user selects a media file.
2. The app reads local metadata.
3. For a non-preset conversion, the user describes the goal.
4. The app builds a prompt for an external AI.
5. The user copies the prompt into ChatGPT or Claude.
6. The user pastes the resulting FFmpeg command back into the app.
7. The app validates the command and runs it locally.

WebMCP closes steps 4–6. The agent sees structured metadata and safe conversion
tools directly in the live authenticated page. It can configure the same
editable FFmpeg chips the user sees, then invoke the existing local runner.

WebMCP does not make browser automation theoretically possible; Playwright
could click through the interface. It makes this integration structured,
stable, agent-neutral, and intentionally authorized by the application. The
agent need not infer controls or handle copied command text.

## Product constraints

These are hard requirements from `AGENTS.md` and the existing product:

- Media processing remains entirely local in the browser.
- Never send source bytes, output bytes, logs, object URLs, OPFS handles, or
  file contents to the agent.
- Only bounded metadata may cross the tool boundary: name, MIME type, byte
  size, duration, dimensions, streams/format when already available, current
  FFmpeg arguments, validation state, progress, and bounded status text.
- The user must select the local file through the existing file picker. A tool
  must not attempt to choose arbitrary local files.
- FFmpeg remains visible. Tool-driven configuration must update the existing
  editable command-chip UI before execution.
- Every agent-supplied command goes through the existing
  `validateCommandArgs()` path.
- Preserve the exactly-one-input and exactly-one-output model.
- Preserve relative asset paths, the COOP/COEP service worker, GitHub Pages
  compatibility, multithreaded FFmpeg intent, and single-thread fallback.
- The app must continue to work normally in browsers without WebMCP.
- No Agent Connect, MCP server, remote model API, generated UI runtime, or new
  backend belongs in this slice.

## Existing code map

- `src/App.tsx`
  - Owns selected file, metadata, FFmpeg arguments, recipe selection, busy
    state, progress, output, logs, and run handlers.
  - `handleFile()` selects and probes a file.
  - `applyRecipe()` updates the authoritative command arguments.
  - The existing AI paste-back flow calls `parseFfmpegReply()` and then
    `validateCommandArgs()` before updating `args`.
  - The conversion run handler already controls FFmpeg loading, execution,
    progress, output URL, output name, and OPFS saving. Reuse it; do not create
    a second runner.
- `src/lib/command.ts`
  - Pure command parsing, normalization, chip conversion, output inference and
    `validateCommandArgs()`.
  - Validation already rejects additional inputs, multiple outputs, URLs,
    absolute paths, parent-directory paths, and unavailable browser files.
- `src/lib/media.ts`
  - Media metadata, FFmpeg core loading, execution, logs, progress and runtime
    status.
- `src/lib/recipes.ts`
  - Safe deterministic recipes filtered by media kind.
- `src/lib/prompt.ts`
  - Current copy-to-AI/paste-back escape hatch. Keep it as a fallback; WebMCP
    should not delete working behavior during the hackathon.
- `src/lib/storage.ts`
  - OPFS output storage.

Read `AGENTS.md` and `README.md` before editing. Inspect the current run handler
in `App.tsx` rather than guessing its name or duplicating it.

## Intended user journey

1. User opens the deployed converter in ChatGPT's in-app browser or WebMCP-
   enabled Chrome.
2. User manually selects a local audio, video, or image file.
3. User tells the browser agent, for example:

   > Compress this video for WhatsApp. Keep it reasonably sharp and avoid a
   > huge file.

4. Agent reads the selected file's metadata and available recipes.
5. Agent either applies a recipe or proposes a validated FFmpeg argument list.
6. The app visibly updates the command chips. The user can inspect or edit it.
7. Agent runs the conversion after the browser's normal tool approval flow.
8. Agent checks status/result metadata. The user downloads the output through
   the existing UI.

The demo must show that the source file stays local. Do not claim that metadata
stays local: the selected metadata and requested conversion are necessarily
visible to the browser agent when it calls the tools.

## WebMCP surface

Use the imperative API, guarded so unsupported browsers continue normally:

```ts
document.modelContext.registerTool({
  name,
  title,
  description,
  inputSchema,
  annotations,
  execute,
});
```

Use an `AbortController` passed to registration and abort it on React cleanup so
Strict Mode remounts, hot reloads, and component unmounts do not duplicate
tools. Prefer official typings if they can be added without dependency churn;
otherwise add a narrow local declaration for only the API used.

Keep WebMCP registration separate from pure application operations. A sensible
shape is:

```text
src/lib/webmcp.ts       registration and schemas
src/lib/webmcp-api.ts   app-owned operation types/helpers, if useful
src/App.tsx             supplies live state and existing actions
```

Do not put the FFmpeg engine into `webmcp.ts`.

### React state rule

Registered tool callbacks are long-lived. They must not close over stale React
state. Use one of these approaches:

- a ref containing the latest state/actions, refreshed every render; or
- stable callbacks plus refs for every value read during execution.

Register the tools only when the browser capability becomes available, not on
every state change. Re-registering with every progress update is incorrect.

### Tool 1: `media.get_context`

Read-only. Returns the current safe, bounded application state.

Input schema: empty object.

Suggested result:

```json
{
  "fileSelected": true,
  "file": {
    "name": "clip.mov",
    "mimeType": "video/quicktime",
    "sizeBytes": 48123904,
    "durationSeconds": 37.4,
    "width": 1920,
    "height": 1080
  },
  "command": {
    "args": ["-i", "$INPUT", "-c:v", "libx264", "output.mp4"],
    "valid": true,
    "errors": [],
    "outputName": "output.mp4"
  },
  "job": {
    "busy": false,
    "progress": 0,
    "status": "ready"
  }
}
```

Requirements:

- Return a clear `fileSelected: false` result rather than throwing when no file
  is loaded.
- Do not expose the `File`, `Blob`, object URL, OPFS location, full FFmpeg logs,
  or any byte content.
- Bound or omit large `streams` and `format` structures. Include only useful
  scalar codec/channel/rate fields if the app has them.
- Annotation: `readOnlyHint: true`.

### Tool 2: `media.list_recipes`

Read-only. Returns recipes applicable to the selected file. This should use
`recipesForFile()` rather than duplicating filtering rules.

Input schema: empty object.

Result entries should contain only stable `id`, `label`, and `description`.
Return a helpful state when no file is selected.

Annotation: `readOnlyHint: true`.

### Tool 3: `media.apply_recipe`

Mutating but non-executing. Updates the existing chips using a known recipe.

Input:

```json
{
  "recipeId": "video-compress"
}
```

Requirements:

- Reject missing files and recipes not applicable to the current media kind.
- Call the same operation used by the existing recipe UI.
- Clear stale output exactly as `applyRecipe()` already does.
- Return the resulting normalized args and validation summary.
- Annotation: `readOnlyHint: false`.

### Tool 4: `media.configure_conversion`

Mutating but non-executing. This is the important escape hatch for conversions
outside the built-in recipe catalog.

Input:

```json
{
  "args": [
    "-i",
    "$INPUT",
    "-c:v",
    "libx264",
    "-crf",
    "25",
    "-c:a",
    "aac",
    "converted.mp4"
  ]
}
```

Requirements:

- Accept an argument array, never a shell command string.
- Set a conservative maximum argument count and per-token length.
- Normalize the input placeholder only through existing command helpers.
- Call `validateCommandArgs(args, selectedFile.name)` before changing UI.
- On failure, return a structured tool error containing validation errors and
  leave the current UI untouched.
- On success, update the authoritative `args`, clear active recipe and stale
  output, and visibly update the chips.
- Do not support shell operators, multiple inputs, multiple outputs, URLs or
  arbitrary browser paths.
- Annotation: `readOnlyHint: false`.

### Tool 5: `media.run_conversion`

Mutating and potentially expensive. Runs exactly the currently visible,
validated command.

Input should include an optimistic concurrency value so an old agent decision
cannot run a newly edited command. A cheap implementation can return a stable
`commandRevision` from `media.get_context` and require it here:

```json
{
  "commandRevision": 4
}
```

Requirements:

- Reject when no file is selected, the app is busy, no command exists,
  validation fails, or the revision differs.
- Reuse the existing run handler. There must remain exactly one execution path.
- Do not automatically download the result.
- Respect WebMCP's execution `AbortSignal` where practical. If the existing
  FFmpeg wrapper cannot safely cancel a running conversion within this slice,
  report that limitation honestly rather than pretending cancellation worked.
- Return final exit code, output name, output byte size when available, elapsed
  time and a small bounded status summary. Do not return the output bytes or
  full logs.
- Annotation: `readOnlyHint: false`.

### Optional Tool 6: `media.get_job_status`

Add this only if `run_conversion` cannot remain open until completion or if it
materially improves the real agent flow. It can return busy/progress/status and
the latest output metadata. Do not add polling infrastructure merely because it
looks protocol-like.

## Error behavior

Tool failures should be useful to an agent and readable to a human:

- `no_file_selected`
- `recipe_not_applicable`
- `invalid_command`
- `command_changed`
- `conversion_busy`
- `conversion_failed`
- `webmcp_unavailable` only for internal diagnostics, not normal browsers

Use short machine-readable codes plus a plain-language message. Preserve the
existing compact UI error and detailed local logs. Never place full logs in a
tool result.

## Scope control

### Required

- Real WebMCP registration in the deployed page.
- Context, recipes, safe configuration, execution and status/result.
- Existing UI visibly reflects every agent change.
- Browser without WebMCP still works.
- README explains WebMCP, supported browsers, privacy boundary and test prompts.
- Post-August-25 work is documented for Devpost.

### Explicit non-goals

- Selecting arbitrary files through the agent.
- Uploading media to any server or model.
- Giving the model raw media bytes or frames.
- Direct arbitrary shell command execution.
- Multiple inputs, filter-complex workflows requiring temporary assets, or
  multi-output commands.
- A model API inside the application.
- Agent Connect integration.
- An extension.
- General MCP support.
- Generated UI/sitelets.
- Redesigning the existing app.
- Removing the copy/paste AI fallback.
- Solving every FFmpeg command or codec availability issue.

## Implementation sequence

1. Read `AGENTS.md`, `README.md`, `src/App.tsx`, and the four `src/lib` modules
   named above.
2. Confirm the existing production build is green with
   `npm --silent run verify` before changing behavior.
3. Add the smallest WebMCP type boundary and registration module.
4. Refactor only enough of `App.tsx` to expose stable app-owned actions to the
   WebMCP bridge. Avoid broad state-management work.
5. Implement the read-only context and recipe tools first.
6. Implement safe recipe application and argument configuration.
7. Add command revisioning and reuse the existing conversion handler.
8. Test the complete flow in a real WebMCP browser.
9. Update README and add a clear hackathon-work section or separate
   `HACKATHON_WORK.md`.
10. Ask the owner for the repository license choice and add it before
    submission.
11. Run the full verification gate once code has stabilized.
12. Commit WebMCP implementation and documentation in clear, dated commits. Do
    not push without explicit permission.

## Validation

### Local gates

From the repository root:

```sh
npm --silent run build
npm --silent run lint
npm --silent run format:check
npm --silent run verify
```

Follow `AGENTS.md`: use the narrowest gate during development and format once
near the end.

### Real-browser evidence

Use ChatGPT's desktop in-app browser or Chrome 149+ with
`chrome://flags/#enable-webmcp-testing` enabled.

Prove at least:

1. Browser discovers all registered tools.
2. No file selected returns a safe state.
3. User selects a local sample file manually.
4. Agent reads metadata without receiving source bytes.
5. Agent applies a known recipe and the visible chips change.
6. Agent proposes a custom valid argument list and the visible chips change.
7. Invalid extra input/path/URL/multiple-output arguments are rejected by the
   existing validator and do not change the UI.
8. Agent runs the visible command and sees a successful bounded result.
9. User can download the output through the normal UI.
10. Normal manual conversion still works when WebMCP is unavailable.

Use small, redistributable sample media. Do not add copyrighted personal media
to the repository.

## Demo story

Keep the video well under three minutes and show working software immediately.

Suggested flow:

1. **0–10s:** Open the live app in a WebMCP browser and select a short video.
2. **10–25s:** State the problem: trustworthy online converters are commonly
   ad-heavy, misleading or upload private files. This converter runs FFmpeg
   locally.
3. **25–70s:** Ask the agent to compress the selected video for WhatsApp. Show
   it inspect metadata and configure the visible FFmpeg command.
4. **70–110s:** Run the conversion. Show progress and the smaller output.
5. **110–140s:** Ask for a less common transformation that is not a one-click
   recipe. Show a custom validated command appear without copy/paste.
6. **140–165s:** Show source media remains local and explain the WebMCP tools.
7. **165–175s:** Close with the concrete value: the user's agent supplies
   FFmpeg expertise; the browser supplies private local execution.

Do not claim that WebMCP made browser conversion possible. The honest claim is
that it replaced a brittle manual AI handoff with a structured, inspectable,
agent-neutral contract.

## Submission positioning

One-line concept:

> A private, browser-based media converter that lets your WebMCP agent inspect,
> configure and run visible FFmpeg conversions without uploading the file.

Why WebMCP is a strong fit:

- The browser agent gets structured metadata and constrained operations instead
  of interpreting UI controls.
- The app deliberately grants only media-conversion capabilities, not broad DOM
  control or filesystem access.
- Tool execution reuses the user's live page, selected file, editable command
  and local FFmpeg runtime.
- The integration works with WebMCP-aware agents without embedding or paying
  for a model.
- The command remains visible and user-editable, so agent activity is
  inspectable rather than opaque.

## Definition of done

The implementation is done when a judge can open the live site in a supported
browser, manually select a small media file, ask their agent for a conversion,
see a validated FFmpeg command appear in the existing UI, run it through a
WebMCP tool, and download the local result—with no model API, gateway,
extension, account, backend or media upload required.
