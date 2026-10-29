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
## 2026-10-26 - [Add missing focus-visible styles to Plan tool buttons]
**Learning:** Interactive UI elements such as `PlanToolCard`, `ReviewPlanCard`, and `PlanTimelineCard` control buttons were missing explicit `focus-visible` styles, creating keyboard accessibility traps. When attempting to use explicit CSS for things like `.copy-button:focus-visible`, `var(--color-accent)` full opacity contrast vs 35% opacity ring tokens caused issues and using custom tokens like `ring-offset-3` that are not confirmed should be avoided.
**Action:** When adding or verifying interactive components, ensure `focus-visible:ring-2 focus-visible:ring-focus-ring/35` utility classes are included natively inside `.tsx` files alongside hover state tokens or make sure the correct native tailwind-compliant CSS token classes are used instead of custom classes that may break builds or fail contrast tests. Also, remember to not touch forbidden components.
