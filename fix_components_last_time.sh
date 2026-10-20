#!/bin/bash
git checkout 2907fd8e6eb48e63b33bb5d40d67744b0c4c7161 apps/desktop/src/renderer/src/components/ui/ToolbarButton.tsx
git checkout 2907fd8e6eb48e63b33bb5d40d67744b0c4c7161 apps/desktop/src/renderer/src/styles/app.css

# Update ToolbarButton.tsx
sed -i 's/focus-visible:ring-2 focus-visible:ring-focus-ring\/35//g' apps/desktop/src/renderer/src/components/ui/ToolbarButton.tsx
sed -i 's/outline-none //g' apps/desktop/src/renderer/src/components/ui/ToolbarButton.tsx

# Add centralized CSS
sed -i -z 's/\.toolbar-icon-button {\n    color: var(--color-icon-muted);\n    width: 26px;\n    height: 26px;\n  }/\.toolbar-icon-button {\n    color: var(--color-icon-muted);\n    width: 26px;\n    height: 26px;\n    outline: none;\n  }\n  .toolbar-icon-button:focus-visible {\n    @apply ring-2 ring-focus-ring\/35;\n  }/g' apps/desktop/src/renderer/src/styles/app.css

cat << 'MD_EOF' >> .jules/palette.md
## 2026-10-20 - [Centralize focus styles for toolbar icon buttons]
**Learning:** `focus-visible` styles should be maintained in CSS for globally shared classes like `.toolbar-icon-button` to avoid duplicating `focus-visible:ring-2 focus-visible:ring-focus-ring/35` scattered in numerous `className` attributes. Shared component styles like `CopyButton` and `MorphingDialog` are better left with inline utilities because `aria-label` based CSS overrides in `app.css` are brittle and could break with internationalization.
**Action:** When updating shared component styles, if they use a global UI class like `.toolbar-icon-button`, define states centrally in `app.css`. Use explicit inline utility classes only for isolated, self-contained components like `CopyButton`.
MD_EOF
