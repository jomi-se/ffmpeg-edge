## 2024-03-21 - Destructive Action Protection and Icon Button Accessibility

**Learning:** Destructive actions without confirmation (like deleting saved files) can easily frustrate users, and icon-only buttons need specific dynamic ARIA labels to provide proper context for screen readers.

**Action:**

1. Always wrap destructive actions (like `deleteSaved`) in a `window.confirm()` dialog to verify user intent before deleting data.
2. For lists with icon-only buttons (like download or delete icons in a list of files), use dynamic `aria-label` attributes (e.g., `aria-label={"Download " + filename}`) rather than generic ones, so screen reader users know exactly which item the action applies to.
3. Ensure primary input fields (like the intent `textarea`) have an explicit `aria-label` if a `<label>` tag isn't visually present.
