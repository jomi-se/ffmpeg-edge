## 2026-05-25 - ARIA labels for icon-only buttons

**Learning:** In the "Saved Outputs" panel, the icon-only buttons (Download/Delete) used `title` attributes for tooltips, which aren't universally read by screen readers. This is a common accessibility trap where visual tooltips are mistaken for comprehensive screen reader support.
**Action:** Always include explicit `aria-label` attributes on icon-only buttons, even when a `title` attribute is present. The `title` is for hover context, while `aria-label` ensures screen reader accessibility.
