## 2024-03-22 - [Dynamic ARIA labels for file lists]
**Learning:** When dealing with dynamic lists of files/outputs, statically defined `title` attributes aren't sufficient.
**Action:** Use dynamic ARIA labels (e.g., ``aria-label={`Download ${output.name}`}``) to provide specific context for each item to screen readers, instead of a generic "Download output".