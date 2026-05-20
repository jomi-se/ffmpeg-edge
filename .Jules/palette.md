## 2024-05-20 - Adding micro-UX improvements to async buttons and generated lists

**Learning:** Found a common pattern in the app where async buttons lacked visual feedback during their loading states (e.g. "Probe with ffprobe", "Plan command"). Also noticed that buttons inside dynamically generated lists (like saved outputs) were missing ARIA labels, making them inaccessible to screen readers since they only contained icons.
**Action:** When adding new async actions or buttons within mapped arrays, ensure that visual feedback is provided during busy states, and always add dynamic `aria-label`s (e.g. `aria-label={\`Download \${output.name}\`}`) to icon-only buttons for accessibility.
