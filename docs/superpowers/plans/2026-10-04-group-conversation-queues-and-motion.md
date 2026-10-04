# Group Conversation Queues and Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Queue user follow-ups behind active Group turns, make agent replies concise and natural, and improve the Activity checklist and message-card entrances.

**Architecture:** Reuse the persisted per-session `group_jobs` FIFO and current GroupTask store. Route a busy member as a queued destination for user-originated wakes, bind execution identity only when each wake starts, and preserve the active card's live metadata. Use existing React/CSS and track message entry consumption outside virtualized rows.

**Tech Stack:** TypeScript, React, Electron main-process Group runtime, Vitest, CSS in `app.css`.

**Spec:** `docs/superpowers/specs/2026-10-04-group-conversation-queues-and-motion.md`

## Global Constraints

- Reuse persisted Group tasks and `group_jobs`; add no queue table, migration, or dependency.
- Preserve one running Group turn per member, the existing global concurrency limit, task routing/authorization, and queue recovery.
- Queue a user's follow-up behind a currently running member turn. Question-gated / `awaiting_user` turns keep the existing supersession behavior.
- Never change the execution ID used by an active turn when a later wake is enqueued; bind queued or recovered work when it actually starts.
- Keep the active card's live tools/presence metadata attached to that card; queued cards for the same member must not inherit it.
- Default agent replies to 1–3 direct sentences in the user's language; add detail when the user asks or the result requires it. Use one concise public response per turn, with a brief thank-you and specific feedback when useful after meaningful peer contribution. Avoid generic praise and numerical ratings; requested or required task reviews remain part of the existing Group review workflow.
- Hide the checklist with no tasks; reveal it before Activity details using an in-flow height expansion.
- Animate only newly appended cards once. Hydration, older-page prepends, revisions, filtering, virtualization remounts, room changes, and reduced-motion settings must not replay motion.

## Review Focus

- Explicit mentions, reply-author routing, and default Lead/coordinator intake queue behind a running selected member without `member-unavailable`, abort, or prompt replacement.
- Two or more user follow-ups persist and run FIFO; recovered jobs preserve order; explicit Stop cancels queued follow-ups.
- A Group tool used during active turn A records A's execution ID even while B/C wait; recovered queue heads bind only when started.
- Question-gated supersession remains covered by the existing `group-runtime-supersede.test.ts` behavior.
- A running/writing card retains live metadata while a later card stays queued.
- Checklist is absent for an empty list; on `[] → tasks`, it expands from zero height, fades/slides into place, and pushes Activity content down.
- Initial history, older pages, revised cards, hidden/filtered cards, room navigation, and virtual row remounts do not replay card entry animation.

---

### Task 1: Queue user follow-ups without changing active execution identity

**Files:**
- Modify: `apps/desktop/src/main/groups/group-runtime.ts`
- Modify: `apps/desktop/src/main/groups/group-runtime.test.ts`
- Modify: `apps/desktop/src/main/groups/group-runtime-more.test.ts`
- Modify: `apps/desktop/src/main/groups/group-runtime-reliability.test.ts`
- Modify: `apps/desktop/src/shared/group-execution-link.ts`
- Modify: `apps/desktop/src/shared/group-execution-link.test.ts`

**Interfaces:**
- Reuse `route`, `capabilityRoute`, `enqueue`, persisted `group_jobs`, and `GroupTaskWake`; no new public API or persisted field.
- Allow the selected destination for every user-originated wake to be queued when it is busy. Keep member, capability, tool, dependency, and authorization checks intact.
- Bind session execution at turn start with a unique wake token; clear only the binding belonging to that wake on settlement, cancellation, and disposal. This token must distinguish successive wakes that share one execution ID. Recovered jobs use the same start binding.

- [x] **Step 1: Update queue tests first.** Change the existing busy explicit-mention assertion in `group-runtime-more.test.ts`, the existing F10 scenario in `group-runtime-reliability.test.ts`, and the busy Beta assertion in the intent-gate case in `group-runtime.test.ts` from expecting no queue to expecting a queued follow-up. Add coverage for reply-author and default Lead/coordinator intake when that selected member is running.
- [x] **Step 2: Add FIFO, durability, recovery, and Stop assertions.** Queue two messages behind A; assert both persisted `group_jobs` rows and transcript cards are queued, A remains the sole active prompt, no abort/steer call occurs, B then C start in order, and Stop marks queued follow-ups cancelled. Reconstruct the runtime with B/C pending and assert recovery starts them in persisted order.
- [x] **Step 3: Add execution-binding regression coverage.** While A runs and B/C are queued, call an existing Group tool that consumes `sessionExecutionId` (for example `group_record_decision`) and assert its recorded execution ID is A's. Assert B/C become the bound ID only when their respective turns start. Cover Stop and disposal cleanup, a late cancelled settlement, and successive wakes sharing one execution ID so an old wake cannot unbind its successor.
- [x] **Step 4: Run the focused main-process tests and verify the old execution-link ownership behavior fails:** `npm exec --workspace=@modus/desktop -- vitest run --root ../.. apps/desktop/src/main/groups/group-runtime.test.ts apps/desktop/src/main/groups/group-runtime-more.test.ts apps/desktop/src/main/groups/group-runtime-reliability.test.ts apps/desktop/src/shared/group-execution-link.test.ts`. The first attempt was blocked for the runtime suites by an incomplete `node_modules`; `npm ci` restored the locked dependencies without changing `package-lock.json`.
- [x] **Step 5: Implement queueable user routing and execution binding.** Pass the queue allowance only for the selected user-routed destination; remove binding from `enqueue`; bind in `start`; perform identity-guarded cleanup on settle/dispose without clearing a newer wake's binding.
- [x] **Step 6: Rerun the focused tests.** Also run `npm exec --workspace=@modus/desktop -- vitest run --root ../.. apps/desktop/src/main/groups/group-runtime-supersede.test.ts` to confirm gated-turn supersession remains unchanged.

### Task 2: Keep live metadata on the actual active card

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/groups/GroupMessageList.tsx`
- Modify: `apps/desktop/src/renderer/src/features/groups/GroupMessageList.timeline.test.tsx`

**Interfaces:**
- Preserve the existing `GroupMessageRow` props and live-row source.
- When several active-status cards for a member exist, running/writing/awaiting-user takes precedence over queued; queued receives live metadata only when no active turn card exists.
- Resolve active-card ownership from unfiltered `roomMessages`, so execution/search filters cannot expose a queued B card as owner when they hide the running A card.

- [x] **Step 1: Add regression tests** with a running/writing card A, a later queued follow-up B, and one live tools/presence row. Assert A shows the live snapshot and B does not; then hide A with an execution or search filter while B remains visible and assert B still does not show A's live snapshot.
- [x] **Step 2: Run `npm exec --workspace=@modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/groups/GroupMessageList.timeline.test.tsx` and confirm the new assertion fails.
- [x] **Step 3: Select the live-metadata card by active-state precedence** instead of allowing a later queued card to overwrite it.
- [x] **Step 4: Rerun the focused test and confirm existing timeline behavior is preserved.**

### Task 3: Make Group replies concise and conversational

**Files:**
- Modify: `apps/desktop/src/shared/group-collab-status.ts`
- Modify: `apps/desktop/src/main/groups/group-runtime-lib.ts`
- Modify: `apps/desktop/src/main/groups/group-runtime.test.ts`

**Interfaces:**
- Keep `GROUP_COLLAB_WAKE_PROTOCOL` as the shared source of conversation instructions.
- Keep `composeGroupSnapshotSection` aligned with the shared protocol in coordinator mode; remove the conflicting four-field final response template.
- Keep task results, handoffs, and reviews on existing Group tools and typed task state.

- [x] **Step 1: Extend the ordinary-wake and coordinator-snapshot tests** to require language matching, a natural and concise single public response per turn with detail allowed when requested/needed, no internal/tool narration, conditional peer thanks plus useful specific feedback, no generic praise/numerical ratings, continued use of requested/required Group task reviews, and one consolidated Lead response without a fixed response template.
- [x] **Step 2: Run `npm exec --workspace=@modus/desktop -- vitest run --root ../.. apps/desktop/src/main/groups/group-runtime.test.ts` and confirm the requested guidance is absent or contradictory.
- [x] **Step 3: Tighten the shared protocol and snapshot wording** without forcing praise, ratings, or long summaries.
- [x] **Step 4: Rerun the focused test and confirm both ordinary and coordinator prompts agree.**

### Task 4: Reveal the Activity checklist only when tasks exist

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/groups/GroupTaskPanel.tsx`
- Modify: `apps/desktop/src/renderer/src/features/groups/GroupActivityPanel.test.tsx`
- Modify: `apps/desktop/src/renderer/src/features/groups/GroupRoom.test.tsx`
- Modify: `apps/desktop/src/renderer/src/styles/app.css`

**Interfaces:**
- Keep `GroupTaskPanel.top` for Activity sections and decisions.
- Keep task rows and their cancel/details handlers unchanged.
- Use an in-flow height mechanism such as a zero-to-one grid track (with an inner `min-height: 0` wrapper) so content below moves down over the same reveal duration.

- [x] **Step 1: Extend Activity tests** to assert no checklist or empty placeholder when there are no tasks, checklist ordering before `{top}`, and a real `[] → tasks` rerender that reveals it with the entry class. Update the existing `GroupRoom.test.tsx` ordering expectation to put the checklist before Decisions.
- [x] **Step 2: Run `npm exec --workspace=@modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/groups/GroupActivityPanel.test.tsx` and confirm current ordering/empty state violates the assertions.
- [x] **Step 3: Render the checklist before Activity details only when tasks exist** and animate its in-flow height, opacity, and upward-to-rest movement.
- [x] **Step 4: Add reduced-motion CSS and rerun the focused Activity and GroupRoom tests.** Confirm the visual expansion still occupies layout rather than overlaying later sections.

### Task 5: Animate newly appended message cards once

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/groups/GroupMessageList.tsx`
- Modify: `apps/desktop/src/renderer/src/features/groups/GroupMessageList.timeline.test.tsx`
- Modify: `apps/desktop/src/renderer/src/styles/app.css`

**Interfaces:**
- Preserve the virtualizer's translated positioning wrapper; apply animation to an inner card wrapper so positioning transforms do not conflict.
- Track seen/consumed entry IDs outside virtual row components. Consume IDs at first eligible appearance so scrolling, virtual remounts, filters, threshold changes, and room navigation cannot replay them.
- Keep `GroupMessageRow` rendering and message identity unchanged.

- [x] **Step 1: Add tests** for initial hydration (`loaded=false → true`), append, older-page prepend, same-ID body/status revision, filter hide/show, room switch, filter-induced row remount, and nonvirtual-to-virtual threshold change. Assert only a genuinely new appended card receives one entry class; assert the reduced-motion class is available. Happy DOM did not reliably evict a tail row by scrolling, so the remount assertion hides and restores it with an execution filter.
- [x] **Step 2: Run `npm exec --workspace=@modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/groups/GroupMessageList.timeline.test.tsx` and confirm there is no entry class yet.**
- [x] **Step 3: Track appended IDs only after the initial loaded transcript is established.** Keep consumption state outside row components and clear room-scoped pending IDs on navigation without making old IDs eligible again.
- [x] **Step 4: Add the brief fade/up motion and reduced-motion rule.** Keep virtualization's `translateY` on its existing wrapper and put the animation on an inner wrapper.
- [x] **Step 5: Rerun the focused timeline test, including virtualization cases.** It passed 15/15.

### Task 6: Verify the complete change

**Files:**
- Review: all files changed by Tasks 1–5.

- [x] **Step 1: Run the focused Vitest commands from Tasks 1–5**, including `apps/desktop/src/renderer/src/features/groups/GroupRoom.test.tsx`, `apps/desktop/src/shared/group-execution-link.test.ts`, and the gated-turn regression command from Task 1. Combined run: 8 files, 184 tests passed.
- [x] **Step 2: Run `npm run typecheck --workspace=@modus/desktop`.** Passed after fixing two test typing issues.
- [x] **Step 3: Run Biome on all changed TypeScript/TSX/CSS files, including `group-runtime-lib.ts`, the shared execution-link helper/test, and `GroupRoom.test.tsx`:** `npm exec -- biome check apps/desktop/src/main/groups/group-runtime.ts apps/desktop/src/main/groups/group-runtime-more.test.ts apps/desktop/src/main/groups/group-runtime-reliability.test.ts apps/desktop/src/main/groups/group-runtime.test.ts apps/desktop/src/main/groups/group-runtime-lib.ts apps/desktop/src/shared/group-collab-status.ts apps/desktop/src/shared/group-execution-link.ts apps/desktop/src/shared/group-execution-link.test.ts apps/desktop/src/renderer/src/features/groups/GroupTaskPanel.tsx apps/desktop/src/renderer/src/features/groups/GroupActivityPanel.test.tsx apps/desktop/src/renderer/src/features/groups/GroupRoom.test.tsx apps/desktop/src/renderer/src/features/groups/GroupMessageList.tsx apps/desktop/src/renderer/src/features/groups/GroupMessageList.timeline.test.tsx apps/desktop/src/renderer/src/styles/app.css`. Passed with pre-existing warnings in `group-runtime-more.test.ts` and unrelated CSS rules.
- [x] **Step 4: Review the full diff** for routing regressions, stale execution binding, duplicate cards, task authorization, queue order/recovery, animation replay, reduced motion, checklist layout, and prompt verbosity. Independent reviews approved Tasks 1–5 with no blockers.
