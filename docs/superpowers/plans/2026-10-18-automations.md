# Modus Automations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local scheduled Automations to the existing Modus runtime, with a minimal list/detail experience and execution history.

**Architecture:** Keep definitions, occurrence claims and run state in the existing SQLite database. A main-process service owns scheduling and calls the existing `AgentRuntime` only while a live Modus window exists; trusted IPC connects that service to the renderer. The UI adds one primary destination above Settings and reuses the existing conversation view for run history.

**Tech Stack:** Electron main process, TypeScript, SQLite (`node:sqlite`), Pi SDK `AgentRuntime`, React, existing IPC/Zod, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-10-18-automations-design.md`

## Global Constraints

- Scheduled work runs only while Modus is open with a live window; minimized counts as open.
- At most one automation execution is active globally; foreground chats keep current concurrency.
- Claim a scheduled occurrence transactionally before runtime admission; missed occurrences are recorded and never replayed automatically.
- Keep user-selected project, Agent, provider and model authoritative; unavailable selections fail without substitution.
- Use existing dispatcher, approvals, permissions, Verifier-First, notifications, conversation storage and runtime cleanup.
- Keep list/editor usable without inference; chat proposals require explicit user confirmation before persistence or execution.
- Use a ten-minute deadline including approval wait; retain the automation slot until runtime termination is confirmed.
- Do not add a daemon, cloud/OS scheduler, hidden window, second Harness, generic job framework, or new dependency without a demonstrated need.
- Keep the interface minimal, localized in English, Portuguese and Chinese, accessible by keyboard and respectful of reduced motion.

## Review Focus

- **DST and timezone changes:** test nonexistent/repeated local times and explicit timezone edits in `automation-schedule.test.ts`.
- **Duplicate claims after clock changes, wake or renderer reload:** test a unique occurrence claim in `automation-store.test.ts` and repeated wake/reload in `automation-service.test.ts`.
- **Unconfirmed or malformed chat proposal:** test that no definition, run or runtime call is created in `automation-proposal-tool.test.ts`.
- **Cancelled, timed-out or unresolved runtime session:** test slot retention until confirmed settlement in `automation-service.test.ts`.
- **Window closed while a task waits for user approval:** test admission pause and cancellation through the existing runtime when the interaction owner closes in `automation-service.test.ts`.

---

### Task 1: Persist definitions, execution history and calendar occurrences

**Files:**
- Create: `apps/desktop/src/main/automations/automation-types.ts`
- Create: `apps/desktop/src/main/automations/automation-schedule.ts`
- Create: `apps/desktop/src/main/automations/automation-schedule.test.ts`
- Create: `apps/desktop/src/main/automations/automation-store.ts`
- Create: `apps/desktop/src/main/automations/automation-store.test.ts`
- Modify: `apps/desktop/src/main/db/database.ts`

**Interfaces:**
- `AutomationDefinition`: id, revision, name, instruction, schedule, IANA timezone, next instant, workspace/cwd, Agent/model/provider/thinking selection, enabled state, timestamps and soft-delete timestamp.
- `AutomationExecution`: id, automation/revision, occurrence or manual trigger key, immutable config snapshot, timestamps, session/run ids, outcome and bounded error.
- `createAutomationStore(db)` provides validated create/update, list/get, pause/resume, soft-delete, history, unresolved-run reconciliation and transactional `claimOccurrence` operations.
- `nextAutomationOccurrence(schedule, timeZone, after)` returns the next calendar instant or `null`; missed-interval calculation advances without claiming an execution.

- [x] Add failing tests for one-time/daily/weekly recurrence, timezone changes, DST skip/first-repeat behavior, and missed intervals using fixed dates.
- [x] Run `npx vitest run --root ../.. apps/desktop/src/main/automations/automation-schedule.test.ts`; confirm the new schedule cases fail before implementation.
- [x] Implement the schedule calculation and strict input validation without adding a recurrence dependency.
- [x] Add failing store tests for persisted snapshots, soft deletion/history retention, unique occurrence claims under competing callers, and restart reconciliation.
- [x] Run `npx vitest run --root ../.. apps/desktop/src/main/automations/automation-store.test.ts`; confirm failures are limited to the missing store behavior.
- [x] Add the minimal tables and indexes in `migrateDatabase`, then implement the store operations with transactions for occurrence claims.
- [x] Run both automation test files and the focused database migration tests; confirm all pass and old database migration remains idempotent.

### Task 2: Own scheduling and execution in the main process

**Files:**
- Create: `apps/desktop/src/main/automations/automation-service.ts`
- Create: `apps/desktop/src/main/automations/automation-service.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Reuse: `apps/desktop/src/main/agent/runtime-registry.ts`, `apps/desktop/src/main/agent/runtime.ts`, and `apps/desktop/src/main/notifications/agent-notifications.ts`

**Interfaces:**
- `createAutomationService({ store, runtime, clock, notify })` returns `start(window)`, `windowClosed()`, `runNow(id)`, `stop()`, list/detail/update/pause/delete operations and execution-history queries.
- The service uses `AgentRuntime.create`, `prompt`, `abort`, `onTurnSettled` and `onQuestionPending`; it maps only automation-owned sessions to execution records.
- Window closure pauses new admission and aborts owned sessions. Minimized windows remain valid. Shutdown stops claims and drains owned sessions before `shutdownAgentRuntime()`.

- [x] Add synthetic-runtime tests for service reuse, one global automation slot, Run now busy behavior, due occurrence skipped while occupied (no backlog), question-waiting state, timeout, cancellation and settlement cleanup.
- [x] Add lifecycle tests proving minimized-window execution, closed-window pause/cancel, reopening resume, app shutdown and unresolved-run reconciliation.
- [x] Run `npx vitest run --root ../.. apps/desktop/src/main/automations/automation-service.test.ts`; confirm failures expose missing lifecycle behavior.
- [x] Implement the service with injected clock/runtime, transactional admission and a single scheduler timer; retain the slot until runtime settlement is confirmed.
- [x] Wire service creation after database/runtime availability, start it for the live main window, pause it from the window `closed` callback, resume on window recreation, and stop it in the existing bounded shutdown drain.
- [x] Run service, runtime-registry and focused main lifecycle tests; confirm scheduled prompts use saved project/cwd/Agent/model settings without changing foreground chat concurrency.

### Task 3: Expose validated host operations and confirmed chat proposals

**Files:**
- Create: `apps/desktop/src/main/automations/automation-ipc.ts`
- Create: `apps/desktop/src/main/automations/automation-ipc.test.ts`
- Create: `apps/desktop/src/main/agent/tools/automation-proposal-tool.ts`
- Create: `apps/desktop/src/main/agent/tools/automation-proposal-tool.test.ts`
- Modify: `apps/desktop/src/main/ipc/channels.ts`
- Modify: `apps/desktop/src/main/ipc/schemas.ts`
- Modify: `apps/desktop/src/main/ipc/register-app-ipc.ts`
- Modify: `apps/desktop/src/preload/types.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts`

**Interfaces:**
- Add a narrow `window.modus.automations` bridge for list/detail/history/create/update/pause/delete/run-now and events; validate every request with strict Zod schemas and the existing trusted-sender check.
- The chat tool may only create a proposal. It presents instruction, project, effective Agent/model, schedule and timezone for explicit confirmation through the existing question flow; only an affirmative response calls the same host create service. It cannot update, enable, or run an existing automation.

- [x] Add IPC tests for trusted-sender enforcement across all handlers, malformed arguments, host-owned paths and enabled-state validation.
- [x] Add chat-tool tests for an explicit accepted proposal, declined/skipped/custom answers, malformed proposals and no side effects before confirmation.
- [x] Run the focused IPC and tool tests; confirm no IPC/tool path can invoke the runtime before explicit user confirmation.
- [x] Implement the typed bridge, host handlers and proposal-only tool using existing IPC and ask-user patterns; register it with `PiSdkRuntime` without adding a parallel tool registry.
- [x] Run focused IPC, tool-registry and Pi SDK registration tests; confirm proposals and UI creation converge on the same validated service.

### Task 4: Add the minimal Automations destination and screens

**Files:**
- Create: `apps/desktop/src/renderer/src/features/automations/AutomationsPage.tsx`
- Create: `apps/desktop/src/renderer/src/features/automations/AutomationsPage.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/shell/navigation-state.ts`
- Modify: `apps/desktop/src/renderer/src/components/shell/AppSidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/app/App.tsx`
- Modify: `apps/desktop/src/shared/shell-text.ts`
- Modify: `apps/desktop/src/shared/shell-text.test.ts`

**Interfaces:**
- Add `automations` to `PrimaryDestination` and restoration normalization. Place its localized icon and label immediately above Settings in `AppSidebar`.
- `AutomationsPanel` consumes only `window.modus.automations` and navigation callbacks. It renders the minimal list/empty state, detail/history, and editor in the main content area; execution history links open the existing conversation by session id.

- [x] Add renderer tests for empty/create/list/detail/history, linked conversations, pause/run-now and sidebar/navigation restoration; store tests cover refusing deletion while a run is active.
- [x] Run focused renderer and navigation tests, including RED/GREEN coverage during implementation.
- [x] Implement the localized page in English, Portuguese and Chinese and connect it to the host bridge while preserving sidebar hover/pin behavior and existing Settings/Projects routes.
- [x] Run renderer tests, desktop TypeScript typecheck and Biome on changed files; confirm navigation, language strings and accessible interactions pass.

### Task 5: Validate lifecycle and provide visual evidence

**Files:**
- Modify only test files created or touched above unless a concrete integration failure requires a narrowly scoped fix.
- Visual output: `automations-list.png` and `automations-details-history.png` in `/workspace/modus/artifacts/automations/`, if desktop or existing browser capture is available. Keep capture images as review artifacts unless the user requests them in the repository.

- [x] Verify the proposal-to-definition and persisted-snapshot-to-`AgentRuntime` boundaries with focused tests, including exact prompt, Project, Agent, model and session linkage; verify chat-only registration in `PiSdkRuntime`.
- [x] Run focused automation/IPC/UI tests, Pi SDK/runtime tests, desktop TypeScript typecheck and Biome on changed files.
- [x] Capture list and detail/history from the production React component in headless Chromium with disposable fixture data. Electron itself cannot be launched because this environment has no graphical display; the screenshots are component captures, not a desktop smoke test.
- [x] Review both images at normal app size for overlap, scrolling, density, transparency and truncation; include them in the implementation report.
- [x] Run `git diff --check`, inspect the final diff for unrelated changes, and distinguish synthetic test evidence from desktop smoke evidence.

