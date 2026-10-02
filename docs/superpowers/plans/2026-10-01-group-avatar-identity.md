# Group Avatar Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every grouped agent a persistent, distinct geometric identity and accessible presence status while preserving 24 px header avatars.

**Architecture:** Extend the shared shape contract and SVG renderer; allocate shapes in shared code; normalize and constrain persisted group membership in SQLite; enforce that rule in stores and pickers; derive accessible status dots from runtime state.

**Tech Stack:** Electron, React, TypeScript, SQLite, Tailwind, Vitest.

**Spec:** [Group Avatar and Composer Polish](../specs/2026-10-01-group-avatar-and-composer-polish-design.md)

**Global constraints:** Keep existing shapes stable, add `triangle` and `pentagon` for ten total, keep all header avatars at 24 px, never change face/color identity, and do not alter Group Runtime or message persistence.

**Review Focus:**
1. Ten members render ten unique shapes at 24 px — `GroupRoom.test.tsx`.
2. Existing duplicate shapes normalize deterministically while all other data and foreign keys survive — migration cases in `group-agents.test.ts`.
3. Stores and SQLite reject duplicate shapes within a group but allow duplicate shapes for ungrouped agents — `agents-store.test.ts` and `group-agents.test.ts`.
4. Occupied shapes cannot be selected in existing or draft groups — `AgentDialog.test.tsx` and `NewGroupModal.test.tsx`.
5. Queued, working, waiting, idle, archived, and reduced-motion states remain distinguishable and accessible — `GroupRoom.test.tsx` and `useWorkingGroups.test.ts`.

---

### Task 1: Add ten crisp SVG silhouettes and deterministic allocation

**Files:** `apps/desktop/src/shared/contracts-parts/contracts-part-08.ts`, new `apps/desktop/src/shared/group-avatar-shapes.ts` and test, `apps/desktop/src/renderer/src/features/agents/AgentAvatar.tsx`, `apps/desktop/src/renderer/src/features/agents/AgentAvatar.test.tsx`.

**Consumes:** Existing eight-shape contract and SVG renderer.
**Produces:** Ten-shape shared contract, tested group allocator, and two additional SVG silhouettes.

- [x] First add failing tests for both new SVG shapes and for allocation: preserve unique preferred shapes; resolve duplicate preferences to the first free shape; assign ten unique shapes; reject an eleventh member.
- [x] Extend `AGENT_AVATAR_SHAPES`, implement `allocateUniqueGroupAvatarShapes`, and draw triangle/pentagon in the existing 48×48 SVG viewBox. Keep compact and 24 px render sizes unchanged.
- [x] Run focused tests:
  `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/shared/group-avatar-shapes.test.ts apps/desktop/src/renderer/src/features/agents/AgentAvatar.test.tsx`
  **Expected:** allocation and SVG cases pass, including ten distinct shapes and unchanged 24 px sizing.
- [x] Commit: `feat(agents): add ten unique avatar shapes`.

### Task 2: Migrate persisted shapes and enforce uniqueness in stores

**Files:** `apps/desktop/src/main/db/database.ts`, `apps/desktop/src/main/agents/agents-store.ts`, `apps/desktop/src/main/groups/group-store.ts`, `apps/desktop/src/shared/group-errors.ts`, `apps/desktop/src/main/groups/group-agents.test.ts`, `apps/desktop/src/main/agents/agents-store.test.ts`, relevant IPC tests.

**Consumes:** Task 1 shape contract and allocator.
**Produces:** Idempotent normalization migration, SQLite uniqueness enforcement, and typed store validation.

- [ ] Add failing migration and store cases for stable duplicate repair, preserved fields, foreign-key validity, uniqueness rejection, and allowed ungrouped duplicates.
- [ ] Add an idempotent table rebuild migration that accepts ten shapes, repairs only collisions in membership order, then creates the `(group_id, avatar_shape)` unique index.
- [ ] Allocate free shapes for create, add-member/adopt, and update paths; return a typed validation error for collisions while retaining the database constraint as the final guard.
- [ ] Run focused tests:
  `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/groups/group-agents.test.ts apps/desktop/src/main/agents/agents-store.test.ts apps/desktop/src/main/ipc/agents-ipc.test.ts`
  **Expected:** grouped collisions are repaired/rejected as specified, ungrouped duplicates remain valid, and unrelated fields plus foreign keys survive migration.
- [ ] Commit: `feat(agents): enforce unique group avatar shapes`.

### Task 3: Keep both agent editors within the group shape set

**Files:** `apps/desktop/src/renderer/src/features/agents/AgentDialog.tsx`, `apps/desktop/src/renderer/src/features/groups/NewGroupModal.tsx`, their tests.

**Consumes:** Tasks 1–2 shared shape allocation and store enforcement.
**Produces:** Existing and draft group editors that only offer free member shapes.

- [ ] Add failing tests proving occupied shapes are disabled, a member's current shape remains selectable, and draft members cannot reuse one another's shapes.
- [ ] Pass occupied shapes into existing-group editing and new-group draft editing; use the shared allocator before insertion so templates with repeated defaults still create valid groups.
- [ ] Run focused tests:
  `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/agents/AgentDialog.test.tsx apps/desktop/src/renderer/src/features/groups/NewGroupModal.test.tsx`
  **Expected:** occupied choices are disabled, the current choice remains selectable, and generated groups keep unique shapes.
- [ ] Commit: `feat(agents): prevent duplicate shapes in group editors`.

### Task 4: Add accessible agent presence dots and verify the room header

**Files:** `apps/desktop/src/renderer/src/features/groups/GroupAgentsPopover.tsx`, `apps/desktop/src/renderer/src/features/groups/GroupRoomHeader.tsx`, `apps/desktop/src/renderer/src/features/groups/useWorkingGroups.ts`, `apps/desktop/src/renderer/src/features/groups/GroupRoom.test.tsx`, `apps/desktop/src/renderer/src/features/groups/useWorkingGroups.test.ts`.

**Consumes:** Tasks 1–3 persisted identities plus the existing runtime activity state.
**Produces:** Ten visible 24 px header avatars and accessible, reduced-motion-aware status indicators.

- [ ] Add failing tests for all ten members, unique `data-shape`, agent-name hover/accessibility labels, each activity mapping, and reduced-motion behavior.
- [ ] Replace the outline status span with a reusable local status-dot component for idle, queued, working, waiting, and archived. Remove the dark outline, animate only working/waiting, honor reduced motion, and preserve current header spacing and avatar size.
- [ ] Map queued sessions explicitly without adding intermediate execution details to persistent chat content.
- [ ] Run focused tests:
  `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/groups/GroupRoom.test.tsx apps/desktop/src/renderer/src/features/groups/useWorkingGroups.test.ts`
  **Expected:** ten unique silhouettes and every documented state are visible and accessible; reduced motion suppresses status animation.
- [ ] Commit: `feat(groups): show accessible agent presence states`.

### Task 5: Verify the complete avatar change and update PR #124

- [ ] Run avatar, editor, store, migration, and presence tests together, then desktop typecheck, Biome, and `npm run build --workspace @modus/desktop`.
  **Expected:** the focused/full test suites, typecheck, lint, and desktop build complete successfully.
- [ ] Review the diff for unchanged avatar dimensions, stable shape identity, migration idempotency, and intact runtime contracts.
- [ ] Push the task commits to the existing PR #124; do not merge it.
