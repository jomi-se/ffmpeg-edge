## 2026-05-21 - App Accessibility Improvements

**Learning:** Found several areas lacking adequate screen-reader and visual context. Added `aria-label` and `placeholder` to the Intent textarea, implemented ARIA progress attributes for FFmpeg processing, updated status fields with `aria-live="polite"`, and added `aria-label` for dynamic variables to output management buttons.
**Action:** Always ensure dynamic progress updates and status elements use ARIA to give context to assistive tech, and attach context to generic action buttons.
