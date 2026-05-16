# AI Agent Instructions: FFmpeg Catalyst

## Project Context

FFmpeg Catalyst is a browser-native media workstation that keeps FFmpeg visible, credited, and
inspectable while local AI helps turn user intent into editable FFmpeg command arguments.

This is a static Vite/React application intended to run locally during development and deploy as a
GitHub Pages-compatible static site. Privacy is a core product rule: source media should be processed
locally in the browser and should not be uploaded to an application server.

## Technical Stack

- **Application**: Vite + React + TypeScript.
- **Media engine**: `@ffmpeg/ffmpeg`, `@ffmpeg/util`, `ffmpeg.wasm`, and `ffprobe`.
- **AI planning**: WebLLM with Gemma 4 E2B by default, plus deterministic fallback templates.
- **Docs retrieval**: Orama over local FFmpeg documentation chunks.
- **Storage**: Origin Private File System (OPFS) for saved outputs where supported; browser Cache API
  via the COOP/COEP service worker for runtime artifacts.
- **Styling**: Plain CSS in `src/styles.css`.
- **Validation**: TypeScript build, ESLint, and Prettier checks.

## Doc-First Navigation

- Start with [README.md](/home/dev/ffmpeg-edge/README.md) for current product behavior, deployment
  notes, attribution, and model details.
- Use this file as the source of truth for agent workflow, validation gates, and architectural
  boundaries.
- If future `docs/` plans or reference docs are added, read the narrowest relevant doc before
  changing code in that area. Do not bulk-read unrelated docs once the governing source of truth is
  clear.
- If code and docs disagree, reconcile them before implementing. Update the narrowest relevant doc
  in the same change when shipped behavior, deployment expectations, privacy guarantees, or model
  defaults change.

## Environment Quickstart

- Install dependencies with `npm install` when needed.
- Start development with `npm run dev`.
- Build production assets with `npm run build`.
- Preview production output with `npm run preview`.
- The dev or preview server must be opened from `http://localhost`, a Vite-allowed host, or HTTPS for
  service workers, OPFS, WebGPU/WebLLM, and cross-origin isolation behavior.
- If a local preview needs to be accessed through Tailscale, keep
  `artifex-box.tail246db1.ts.net` allowed in `vite.config.ts`.
- Dependency installs, browser binary installs, or any command that needs network or access outside
  the sandbox must be approval-gated. Ask before running them.

## Recommended Validation Gates

Run the smallest useful gate during iteration, then run the full local gate before handoff:

1. `npm run build`
2. `npm run lint`
3. `npm run format:check`

Treat the Vite large-chunk warning from WebLLM as expected unless the task specifically concerns
bundle splitting or model-loading performance.

## Git & Workflow

- Never push to any remote branch without explicit, separate confirmation from the user for that
  push action.
- Commit agent-authored changes after completing the relevant verification unless the user asks not
  to commit or there is a clear blocker. State any uncommitted work in the handoff.
- Use short, descriptive commit messages.
- Keep changes surgical. Avoid unrelated refactors, dependency churn, or generated artifact churn.
- Do not commit `dist/`, `node_modules/`, local env files, or temporary preview artifacts.

## Architectural Mandates

1. **FFmpeg stays visible**
   - Do not hide FFmpeg behind opaque labels. Users should be able to inspect and edit the command.
   - Keep FFmpeg and ffmpeg.wasm attribution prominent in UI/docs when relevant behavior changes.

2. **Local-first media handling**
   - Do not upload media to remote services.
   - Treat source files, logs, and generated outputs as local browser data unless the user explicitly
     asks for an export/download flow.

3. **Cross-origin isolation is product-critical**
   - Preserve `public/coi-serviceworker.js` behavior that applies COOP/COEP headers.
   - Preserve relative asset/service-worker paths for GitHub Pages project-path hosting.
   - When changing FFmpeg core loading, verify both single-thread fallback and multithreaded
     `SharedArrayBuffer` intent are still represented.

4. **Planner is advisory**
   - The AI planner proposes FFmpeg args; the editable chip UI and raw command remain the authority
     for what runs.
   - Invalid or unavailable WebLLM planning must fall back gracefully to deterministic templates.
   - Keep model defaults aligned with README. The current default is
     `gemma-4-E2B-it-q4f16_1-MLC` loaded through a custom WebLLM app config.

5. **Separate pure command logic from browser side effects**
   - Keep command parsing, chip generation, and output-name inference in `src/lib/command.ts`.
   - Keep FFmpeg runtime, file writes, and probe/run behavior in `src/lib/media.ts`.
   - Keep OPFS behavior in `src/lib/storage.ts`.
   - Keep retrieval/model planning in `src/lib/planner.ts` and local doc chunks in
     `src/lib/ffmpegDocs.ts`.

## AI Feedback Loops & Observability

- Preserve FFmpeg log capture and progress display for every run.
- Preserve the self-correction loop that feeds recent stderr/log output back into planning.
- User-facing failures should be compact in the main UI but expose actionable detail through logs or
  session messages.
- For planner changes, verify the fallback path still works without loading WebLLM.
- For model changes, verify the model id, app config, and README agree.

## Frontend Standards

- Build the actual tool surface first, not a marketing page.
- Keep controls dense, readable, and work-focused: upload/probe, planner, command chips, raw command,
  run progress, outputs, docs, and logs should remain easy to scan.
- Use lucide icons for icon buttons where available.
- Do not introduce decorative UI that competes with command inspection or logs.
- Maintain responsive layouts for desktop and mobile-width previews. Text should not overflow its
  controls.
- Prefer existing CSS variables and patterns in `src/styles.css` before adding new visual systems.

## Coding Standards

- TypeScript should stay strict and explicit. Avoid `any` unless a browser API boundary truly
  requires it.
- Prefer small pure helpers for command and planner decisions.
- Use structured APIs for browser storage, service workers, and FFmpeg/WebLLM configuration rather
  than ad hoc string manipulation when reasonable.
- Add comments only when they explain non-obvious browser/runtime constraints.
- When changing service-worker behavior, keep cache failures non-fatal unless the fetch itself truly
  cannot be satisfied.
- Keep dependency additions rare and justified.

## Testing & Bug Fixes

- For command parsing/planning bugs, prefer adding focused tests if a test harness exists. If no
  harness exists yet, document the manual reproduction and run the full local validation gate.
- For FFmpeg runtime bugs, capture the command args, input type, relevant logs, and whether the
  browser was cross-origin isolated.
- For UI bugs, reproduce in the local Vite preview when possible and verify the changed viewport or
  interaction directly before handoff.

## Deployment Notes

- The production build must remain static-host compatible.
- `vite.config.ts` uses `base: "./"` for GitHub Pages project paths; do not change this unless the
  deployment target changes.
- The service worker must be registered with a relative base path from `index.html`.
- If deployment or hosting instructions change, update [README.md](/home/dev/ffmpeg-edge/README.md).

Last reviewed: 2026-05-16
