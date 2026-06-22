# AI Agent Instructions: Local Media Converter

## Project Context

Local Media Converter is a browser-native media workstation that keeps FFmpeg visible, credited, and
inspectable. One-click recipes cover the common conversions; an optional "ask an AI" flow builds a
copyable prompt for the user's own AI and parses the reply back into editable FFmpeg arguments. No
model runs in-app.

This is a static Vite/React application intended to run locally during development and deploy as a
GitHub Pages-compatible static site. Privacy is a core product rule: source media should be processed
locally in the browser and should not be uploaded to an application server.

## Technical Stack

- **Application**: Vite + React + TypeScript.
- **Media engine**: `@ffmpeg/ffmpeg`, `@ffmpeg/util`, `ffmpeg.wasm`, and `ffprobe`.
- **Conversions**: static recipes in `src/lib/recipes.ts`; optional bring-your-own-AI prompt build/parse in `src/lib/prompt.ts`. No in-browser model or doc retrieval.
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
  service workers, OPFS, and cross-origin isolation behavior.
- If a local preview needs to be accessed through Tailscale, keep
  `artifex-box.tail246db1.ts.net` allowed in `vite.config.ts`.
- Dependency installs, browser binary installs, or any command that needs network or access outside
  the sandbox must be approval-gated. Ask before running them.
- Package scripts are intentionally quiet. Prefer `npm --silent run <script>` when invoking them from
  an agent so successful commands emit no output and failures remain visible.

## Recommended Validation Gates

Run the smallest useful gate during iteration, then run the full local gate before handoff:

1. `npm --silent run build`
2. `npm --silent run lint`
3. `npm --silent run format:check`

Use `npm --silent run verify` for the full local gate.

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

4. **Recipes and pasted commands are advisory**
   - Recipes and any AI-pasted command produce FFmpeg args; the editable chip UI and derived command
     args remain the authority for what runs. Do not add an always-visible raw command editor unless
     explicitly requested.
   - A pasted AI reply must be validated with `validateCommandArgs` before it can run; surface a
     friendly error rather than running an invalid command.
   - Do not reintroduce an in-browser model or doc retrieval. The product deliberately runs no model
     in-app; a benchmark established that models already know the common conversions, so retrieval
     added cost without accuracy.

5. **Separate pure command logic from browser side effects**
   - Keep command parsing, chip generation, and output-name inference in `src/lib/command.ts`.
   - Keep FFmpeg runtime, file writes, and probe/run behavior in `src/lib/media.ts`.
   - Keep OPFS behavior in `src/lib/storage.ts`.
   - Keep the recipe catalog in `src/lib/recipes.ts` and the AI prompt build/parse in
     `src/lib/prompt.ts`.

## Observability

- Preserve FFmpeg log capture and progress display for every run.
- User-facing failures should be compact in the main UI but expose actionable detail through logs or
  session messages.

## Frontend Standards

- Build the actual tool surface first, not a marketing page.
- Keep controls dense, readable, and work-focused: upload/probe, recipes, command chips, run
  progress, outputs, and logs should remain easy to scan.
- Use lucide icons for icon buttons where available.
- Do not introduce decorative UI that competes with command inspection or logs.
- Maintain responsive layouts for desktop and mobile-width previews. Text should not overflow its
  controls.
- Prefer existing CSS variables and patterns in `src/styles.css` before adding new visual systems.

## Coding Standards

- TypeScript should stay strict and explicit. Avoid `any` unless a browser API boundary truly
  requires it.
- Prefer small pure helpers for command and recipe decisions.
- Use structured APIs for browser storage, service workers, and FFmpeg configuration rather
  than ad hoc string manipulation when reasonable.
- Add comments only when they explain non-obvious browser/runtime constraints.
- When changing service-worker behavior, keep cache failures non-fatal unless the fetch itself truly
  cannot be satisfied.
- Keep dependency additions rare and justified.

## Testing & Bug Fixes

- For command parsing/recipe/prompt-parsing bugs, prefer adding focused tests if a test harness exists. If no
  harness exists yet, document the manual reproduction and run the full local validation gate.
- For FFmpeg runtime bugs, capture the command args, input type, relevant logs, and whether the
  browser was cross-origin isolated.
- For UI bugs, reproduce in the local Vite preview when possible and verify the changed viewport or
  interaction directly before handoff. Include a Playwright mobile pass that approximates Chrome on a
  Pixel 7 (412px-wide viewport with mobile/touch behavior where the harness supports it).

## Deployment Notes

- The production build must remain static-host compatible.
- `vite.config.ts` uses `base: "./"` for GitHub Pages project paths; do not change this unless the
  deployment target changes.
- The service worker must be registered with a relative base path from `index.html`.
- If deployment or hosting instructions change, update [README.md](/home/dev/ffmpeg-edge/README.md).

Last reviewed: 2026-06-22
