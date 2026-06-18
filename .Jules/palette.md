## 2026-06-18 - Adding accessibility markup to dynamic loading statuses
**Learning:** This application includes asynchronous background processes—such as local FFmpeg core and WebLLM loading, as well as AI chat generation—which lacked ARIA properties to communicate state changes to screen reader users.
**Action:** Applied `aria-live="polite"` to status texts and chat containers, and gave the conversion progress bar proper `role="progressbar"` and `aria-value` properties. Added these specifically where background progress happens frequently to maintain parity with sighted users.
