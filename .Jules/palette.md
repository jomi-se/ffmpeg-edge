## 2026-05-24 - Accessibility: ARIA labels on Icon-only buttons and Textareas
**Learning:** In the FFmpeg Catalyst UI, some interactive elements like the prompt `<textarea>` and the output control `<button>`s (download, delete) lacked accessible names. The buttons relied on `title` attributes, which are insufficient for screen readers when the content is purely icon-based.
**Action:** Add explicit `aria-label`s to form inputs and icon-only buttons. Furthermore, mark decorative or redundant inner icons with `aria-hidden="true"` to prevent double-announcing.
