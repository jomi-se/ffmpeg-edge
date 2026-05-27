## 2024-05-18 - Icon Button Accessibility
**Learning:** Found that "Download" and "Delete" icon buttons in the Saved Outputs list were missing accessible names, which is critical for screen reader users trying to manage their generated FFmpeg files.
**Action:** Always ensure that dynamically generated list items with icon-only actions have `aria-label` attributes that include the context (e.g., the file name) to distinguish them.
