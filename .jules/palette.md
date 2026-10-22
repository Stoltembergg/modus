## 2026-10-18 - [Add missing focus-visible styles to UI icon buttons]
**Learning:** Several shared UI icon buttons (`CopyButton`, `ToolbarButton`, and `MorphingDialog` close button) were missing explicit `focus-visible` styles, creating keyboard accessibility traps where focus state was invisible to users.
**Action:** When adding new icon buttons, always verify tab focus states visually or ensure standard `outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/35` utility classes are included alongside hover state tokens.

## 2026-10-21 - [Palette: Add missing focus-visible styles to UI icon buttons]
**Learning:** Shared UI components and layout components (`AutomationsPage`, `CheckpointRestoreButton`, `AppSidebar`, `NavRail`) had missing explicit `focus-visible` styles, creating keyboard accessibility traps where focus state was invisible to users.
**Action:** When adding new interactive components, always ensure standard `outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/35` utility classes are included alongside hover state tokens.
