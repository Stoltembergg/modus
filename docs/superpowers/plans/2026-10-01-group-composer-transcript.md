# Group Composer and Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the Modus purple brand to Groups composer actions, keep focus treatment neutral, and remove opaque execution IDs from message text while preserving filtering.

**Architecture:** Reuse existing semantic color tokens and composer styles; keep the current message execution filter but present it as an accessible icon action.

**Tech Stack:** React, TypeScript, Tailwind, CSS, Vitest.

**Spec:** [Group Avatar and Composer Polish](../specs/2026-10-01-group-avatar-and-composer-polish-design.md)

**Global constraints:** Do not change send behavior, execution IDs, filtering, timestamps, message content, or keyboard access. Purple focus border/glow must remain absent.

**Review Focus:**
1. Send, selected execution-mode, and kickoff actions use the Modus purple semantic token — `GroupComposer` regression tests.
2. Focus and focus-within add no purple border or glow — `designTokens.test.ts`.
3. The visible `#...` execution chip disappears while its control still filters the matching ID — `GroupMessageRow.prompt-kit.test.tsx`.
4. Filter control has a useful accessible name/title and remains keyboard-operable — `GroupMessageRow.prompt-kit.test.tsx`.
5. Message status and timestamps remain visible and unchanged — `GroupMessageRow.prompt-kit.test.tsx`.

---

### Task 1: Retune composer actions and focus styling

**Files:** `apps/desktop/src/renderer/src/features/groups/GroupComposer.tsx`, `apps/desktop/src/renderer/src/styles/app.css`, `apps/desktop/src/renderer/src/features/groups/GroupComposer.upload.test.tsx`, `apps/desktop/src/renderer/src/styles/designTokens.test.ts`.

**Consumes:** Existing Modus brand token, composer actions, and focus styling.
**Produces:** Purple composer actions with a neutral focus treatment and regression coverage.

- [x] Add failing assertions that send, selected execution mode, and kickoff use the purple semantic token, and that focus-within adds neither a purple border nor purple glow.
- [x] Replace orange accent utilities with the existing Modus purple semantic token. Remove the purple focus border/glow and keep a subtle neutral focus cue with accessible keyboard focus.
- [x] Run focused tests:
  `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/groups/GroupComposer.upload.test.tsx apps/desktop/src/renderer/src/styles/designTokens.test.ts`
  **Expected:** action tests pass with the purple token and the CSS regression test rejects purple focus border/glow.
- [x] Commit: `fix(groups): align composer actions with Modus purple`.

### Task 2: Hide raw execution IDs while retaining their filter action

**Files:** `apps/desktop/src/renderer/src/features/groups/GroupMessageRow.tsx`, `apps/desktop/src/renderer/src/features/groups/GroupMessageRow.prompt-kit.test.tsx`.

**Consumes:** Existing execution ID and filter callback behavior.
**Produces:** An accessible icon filter control with no raw ID text in the message card.

- [x] Add a failing test that rejects visible `#<execution-id>` text, activates the accessible filter control, and verifies the existing callback receives the full original execution ID.
- [x] Replace the textual chip with a compact icon button carrying an accessible name and title. Keep the callback, timestamps, and human-readable execution status intact.
- [x] Run focused tests:
  `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/groups/GroupMessageRow.prompt-kit.test.tsx`
  **Expected:** the raw ID is absent and activating the control sends the unchanged full ID to the existing filter callback.
- [x] Commit: `fix(groups): hide raw execution ids in messages`.

### Task 3: Verify the complete composer/transcript change and update PR #124

- [x] Run both focused test groups, desktop typecheck, Biome, and the Electron Vite production build. The `pnpm --filter @modus/desktop build` wrapper was blocked by pnpm's ignored-build policy for `esbuild`; Electron Vite was run directly against the installed dependencies.
  **Expected:** all listed focused regression tests, typecheck, lint, and the desktop production bundle complete successfully.
- [x] Review the diff for unchanged send/filter behavior and confirm no raw execution ID or purple composer focus treatment remains.
- [ ] Push the task commits to the existing PR #124; do not merge it.
