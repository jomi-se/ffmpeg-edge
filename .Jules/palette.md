## 2024-06-11 - Dynamic ARIA Labels in Lists
**Learning:** Using static ARIA labels for repetitive list items (like "Download" for every output) creates poor screen reader UX, making it hard to distinguish which item is being acted upon.
**Action:** Always template ARIA labels with the item's unique identifier (e.g. `aria-label="Download ${output.name}"`) when mapping over dynamic content.
