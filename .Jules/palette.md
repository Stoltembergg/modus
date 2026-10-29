## 2026-10-18 - [Add missing focus-visible styles to UI icon buttons]
**Learning:** Several shared UI icon buttons (`CopyButton`, `ToolbarButton`, and `MorphingDialog` close button) were missing explicit `focus-visible` styles, creating keyboard accessibility traps where focus state was invisible to users.
**Action:** When adding new icon buttons, always verify tab focus states visually or ensure standard `outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/35` utility classes are included alongside hover state tokens.

## 2026-10-21 - [Palette: Add missing focus-visible styles to UI icon buttons]
**Learning:** Shared UI components and layout components (`AutomationsPage`, `CheckpointRestoreButton`, `AppSidebar`, `NavRail`) had missing explicit `focus-visible` styles, creating keyboard accessibility traps where focus state was invisible to users.
**Action:** When adding new interactive components, always ensure standard `outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/35` utility classes are included alongside hover state tokens.

## 2026-10-23 - [Palette: Add focus-visible styles to ImageViewer components]
**Learning:** Interactive ImageViewer components (ImageThumb, ViewerAction) were missing explicit `focus-visible` styles, creating keyboard accessibility traps where focus state was invisible to users.
**Action:** When adding new interactive components, always ensure standard `outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/35` utility classes are included alongside hover state tokens.
## 2026-10-24 - Add focus visible styles to WorkStatusLine toggle
**Learning:** Some custom UI elements with `.work-status-line__toggle` (e.g. progress disclosures during reasoning) lacked `focus-visible` styles which meant keyboard tabbing did not show an active ring.
**Action:** Always ensure `button`s or elements handling click interactions have `focus-visible:ring-2 focus-visible:ring-focus-ring/35` either via classes or `@apply` in global CSS. Pre-existing test failures (e.g. `qa-evidence.test.ts`) that are un-related to my style changes should be documented instead of fixed per guidelines.
## 2026-10-24 - Add focus visible styles to WorkStatusLine toggle
**Learning:** Some custom UI elements with `.work-status-line__toggle` (e.g. progress disclosures during reasoning) lacked `focus-visible` styles which meant keyboard tabbing did not show an active ring.
**Action:** Always ensure `button`s or elements handling click interactions have `focus-visible:ring-2 focus-visible:ring-focus-ring/35` either via classes or `@apply` in global CSS. Pre-existing test failures (e.g. `qa-evidence.test.ts`) that are un-related to my style changes should be documented instead of fixed per guidelines.

## 2026-10-25 - [Palette: Add focus-visible style to "Open file" button in FilesPanel]
**Learning:** Some custom UI buttons (like the `FilesPanel`'s Open button) use `outline-none` but forget to define an explicit `focus-visible` fallback, rendering keyboard focus invisible. Additionally, utilizing standard transparent rings (`ring-focus-ring/35`) can fail contrast requirements against certain backgrounds, necessitating solid variants (e.g. `ring-focus-ring` without opacity). Also, UI components may live in non-restricted folders but be rendered inside restricted areas (e.g., chat timeline), which must be checked beforehand.
**Action:** When auditing `outline-none` buttons, always use `focus-visible:ring-2 focus-visible:ring-focus-ring` (without transparency if the 35% version lacks contrast), ensuring adequate contrast against adjacent colors. Always verify where a component is mounted in the app before modifying it to avoid touching restricted areas.
