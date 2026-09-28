# HyperPlan Review Plan Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HyperPlan return a validated revised plan body with traceable failures, preserve the original until an explicit choice, and persist only a chosen revision.

**Architecture:** Keep the existing renderer → preload → trusted IPC → `runHyperPlanReview` path. The harness returns `revisedContent` and rejects total/invalid reviews with the underlying bounded cause; an accepted revision updates only `plan.md` through the existing plan store and emits the existing `plan.updated` event. `ChatPane` owns the in-flight guard and original/candidate display state; `ReviewPlanCard` renders the GIF and explicit choices.

**Tech Stack:** Electron IPC, shared TypeScript contracts, Zod, React, Vite asset imports, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-hyperplan-review-plan-choice-design.md`

## Global Constraints

- Preserve the current `PlanRef` unchanged while HyperPlan runs and until the user chooses an action.
- On **Review with HyperPlan**, synchronously enter a visible `reviewing` state, block duplicate invocations, and show `docs/media/hp-mode.gif`.
- Return a validated revised Markdown body alongside the critic feedback. Show it after a successful review without persisting it automatically.
- Persist the revised plan only after **Usar plano revisado**. **Manter plano anterior** restores the original view and leaves stored plan data untouched.
- On review failure, keep/show the original plan and display a short, actionable error that preserves the actual failure category/cause.
- Keep the existing renderer → preload → IPC → harness architecture; do not add a new service layer or generic fallback.
- Limit validation to the affected service/IPC/UI paths and the project typecheck; do not add a broad test suite.
- Do not commit implementation changes unless explicitly requested.

---

## File Structure

- `apps/desktop/src/shared/contracts.ts`: add `revisedContent` to the HyperPlan result contract.
- `apps/desktop/src/main/agent/harness/hyperplan.ts`: carry critic/synthesis failure causes and require valid revised Markdown.
- `apps/desktop/src/main/agent/harness/hyperplan.test.ts`: focused service failure and revision tests.
- `apps/desktop/src/main/plan/plan-store.ts`: update the Markdown body by plan id/hash without changing metadata, Spec evidence, todos, or build state.
- `apps/desktop/src/main/plan/plan-store.test.ts`: verify content/hash change, retained metadata, and stale-hash rejection.
- `apps/desktop/src/main/ipc/channels.ts`, `schemas.ts`, `register-app-ipc.ts`: add a trusted, ownership-checked apply-revision IPC method and persist/broadcast `plan.updated`.
- `apps/desktop/src/main/ipc/register-app-ipc.test.ts` and `schemas.test.ts`: focused acceptance and validation checks.
- `apps/desktop/src/preload/types.ts`, `index.ts`: expose the typed apply-revision method on the existing agent API.
- `apps/desktop/src/renderer/src/features/agent/ChatPane.tsx` and `ChatPane.test.ts`: preserve original/candidate separately, guard duplicate requests synchronously, and surface the actual failure message.
- `apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.tsx` and `ReviewPlanCard.test.tsx`: render the reviewing GIF, revised body, original body on error/keep, and the explicit Portuguese choice labels.
- `docs/media/hp-mode.gif`: copy the user-provided 700,546-byte asset into the repository from `C:\Users\Gabriel\Desktop\Modus\modus\docs\media\hp-mode.gif`.

## Interfaces

`HyperPlanSummary` gains the required field:

```ts
revisedContent: string;
```

Add to `window.modus.agent`:

```ts
applyHyperPlanRevision(input: {
  sessionId: string;
  planId: string;
  planHash: string;
  revisedContent: string;
}): Promise<PlanRef>;
```

Add to `plan-store.ts`:

```ts
updatePlanContentById(
  rootDir: string,
  id: string,
  expectedHash: string,
  content: string,
): PlanRef | undefined;
```

It returns `undefined` for a missing plan and throws a conflict error when the stored hash differs. A successful update changes only `content`, Markdown `blocks`, `hash`, and `updatedAt`.

---

### Task 1: Make HyperPlan failures traceable and return revised Markdown

**Files:**
- Modify: `apps/desktop/src/shared/contracts.ts`
- Modify: `apps/desktop/src/main/agent/harness/hyperplan.ts`
- Test: `apps/desktop/src/main/agent/harness/hyperplan.test.ts`

**Interfaces:**
- `runHyperPlanReview(input: { planContent: string; spec: PlanSpec }): Promise<HyperPlanSummary>` resolves only with a validated non-empty `revisedContent`.
- `HyperPlanSummary` retains its current critique/summary fields and adds `revisedContent: string`.
- Each unavailable critic records a bounded failure reason internally; a review with zero completed critics or a failed/invalid synthesis rejects with the originating actionable reason, not a successful empty summary.

- [ ] **Step 1: Add a regression test for the screenshot path.** In `hyperplan.test.ts`, make every critic prompt reject with `new Error("429: temporary rate limit")`; assert that `runHyperPlanReview(reviewInput())` rejects with that cause and that only four critic prompts ran (no synthesis prompt).

```ts
it("rejects total critic failure with the original cause", async () => {
  mocks.promptHandler = async (prompt) => {
    if (criticId(prompt)) throw new Error("429: temporary rate limit");
  };

  await expect(runHyperPlanReview(reviewInput())).rejects.toThrow("429: temporary rate limit");
  expect(mocks.promptTexts).toHaveLength(4);

  useSuccessfulPromptHandler();
  await expect(runHyperPlanReview(reviewInput())).resolves.toMatchObject({
    revisedContent: expect.any(String),
  });
});
```

- [ ] **Step 2: Add the revision contract to the successful test fixtures.** Extend `synthesisOutput` and every successful synthesis JSON fixture with `revisedContent: "# Feature\nUse the reviewed approach."`; assert the resolved summary carries exactly that Markdown. Change the existing synthesis-exception and malformed-synthesis tests to expect a rejected review, because no valid revised plan exists. Keep the one-invalid-critic tests as partial-review cases. Run `npx vitest run --root . apps/desktop/src/main/agent/harness/hyperplan.test.ts`; confirm the new assertions fail because no rejection/revised content is produced.
- [ ] **Step 3: Implement bounded cause retention and revised-body validation.** Pass `{ planContent, spec, critiques }` into synthesis; add strict `revisedContent` schema validation; keep timeout, output-overflow, prompt/session, malformed critic, and cleanup failures distinguishable; do not swallow `session.prompt` rejection; skip synthesis when there are zero completed critics and reject with their cause. Keep partial critic statuses explicit and synthesize only completed critiques. Reject invalid synthesis rather than returning an empty “unavailable” summary. Move review completion/release bookkeeping into a `finally` path so a rejected review frees admission after outstanding workers settle and can be retried.
- [ ] **Step 4: Run the focused harness test again.** Run the same Vitest command and verify total failure rejects with its cause, successful synthesis returns revised Markdown, and existing partial-critic/concurrency/cleanup behavior remains green.

### Task 2: Add a lossless plan-body update in the existing store

**Files:**
- Modify: `apps/desktop/src/main/plan/plan-store.ts`
- Test: `apps/desktop/src/main/plan/plan-store.test.ts`

**Interfaces:**
- Implement `updatePlanContentById(rootDir, id, expectedHash, content): PlanRef | undefined` as defined above.
- Preserve the stored Spec, its evidence, todo ids/links/statuses, title, overview, path, and build status; update the Markdown body, hash, blocks, and timestamp only.

- [ ] **Step 1: Add a failing store test.** Create a Spec plan using the existing test helper, add one valid QA evidence reference with `applyPlanAcceptanceEvidenceById`, then call `updatePlanContentById(root, plan.id, plan.hash, "# Revised")`. Assert that content/hash/blocks change while the evidenced `spec`, `todos`, `title`, and `buildStatus` remain equal to the updated original.
- [ ] **Step 2: Add a stale-review assertion.** Call the helper with `"stale-hash"`; assert that it throws a plan-changed conflict and the stored body is still the original.
- [ ] **Step 3: Verify RED.** Run `npx vitest run --root . apps/desktop/src/main/plan/plan-store.test.ts`; confirm the failure is the missing update function.
- [ ] **Step 4: Implement the synchronous update.** Resolve the plan directory by id; read the current `PlanRef`; reject an unexpected hash; trim and reject empty Markdown; write `plan.md`; write metadata derived from the existing plan with only `hash`, `blocks`, and `updatedAt` changed; return the updated `PlanRef`.
- [ ] **Step 5: Verify GREEN.** Run the focused store test again and confirm stale hashes leave the original content untouched.

### Task 3: Expose explicit acceptance through trusted IPC

**Files:**
- Modify: `apps/desktop/src/main/ipc/channels.ts`
- Modify: `apps/desktop/src/main/ipc/schemas.ts`
- Modify: `apps/desktop/src/main/ipc/register-app-ipc.ts`
- Modify: `apps/desktop/src/preload/types.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/ipc/register-app-ipc.test.ts`
- Modify: `apps/desktop/src/main/ipc/schemas.test.ts`

**Interfaces:**
- Add channel `agentApplyHyperPlanRevision: "agent:apply-hyperplan-revision"`.
- Add strict schema `{ sessionId, planId, planHash, revisedContent }` with non-empty ids/hash and non-empty Markdown bounded to 12 KiB.
- The handler checks `assertTrustedSender`, session ownership, plan/session/workspace ownership, Spec presence, and expected plan hash; then calls `updatePlanContentById`.
- On success, persist and send `{ type: "plan.updated", sessionId, plan }` on the existing `IPC_CHANNELS.agentEvent` channel and return the updated `PlanRef`.

- [ ] **Step 1: Add a failing IPC test for explicit acceptance.** Mock the store updater to return an updated plan; invoke the registered handler with the owning trusted sender; assert the updater receives the plan id/hash and revised Markdown, the returned value is the updated plan, and a `plan.updated` event is recorded and sent.
- [ ] **Step 2: Add an ownership/stale-plan case.** Change the session workspace or plan hash; assert the handler rejects before updating or recording an event. Keep the existing untrusted-sender test pattern.
- [ ] **Step 3: Add schema bounds tests.** Verify the strict schema accepts the exact valid payload and rejects extra keys, empty Markdown, and Markdown longer than 12 KiB.
- [ ] **Step 4: Verify RED.** Run `npx vitest run --root . apps/desktop/src/main/ipc/register-app-ipc.test.ts apps/desktop/src/main/ipc/schemas.test.ts`; confirm the missing channel/handler/schema causes the expected failures.
- [ ] **Step 5: Implement the channel, schema, handler, and preload method.** The handler loads the active session and plan, validates ownership and `plan.hash`, invokes `updatePlanContentById`, then persists/broadcasts the normal `plan.updated` event. Add `applyHyperPlanRevision` with the exact typed signature above; do not allow renderer-selected paths, workspace ids, or Spec/evidence fields.
- [ ] **Step 6: Verify GREEN.** Run the same focused IPC/schema test command and `npm --workspace @modus/desktop run typecheck`.

### Task 4: Implement reviewing, preview, and explicit plan choice

**Files:**
- Copy: `docs/media/hp-mode.gif` from the user-provided source path above.
- Modify: `apps/desktop/src/renderer/src/features/agent/ChatPane.tsx`
- Modify: `apps/desktop/src/renderer/src/features/agent/ChatPane.test.ts`
- Modify: `apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.tsx`
- Modify: `apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.test.tsx`

**Interfaces:**
- Update `requestHyperPlanReview(input, activeRequest, review)` to synchronously admit one request, release only its own token, return `undefined` for a duplicate, and propagate rejection unchanged.
- `ReviewPlanCard` receives review status, error text, summary, `onUseRevisedPlan`, and `onKeepPreviousPlan`; buttons read **Usar plano revisado** and **Manter plano anterior**.
- The successful IPC result is passed to `onPlanUpdated`; review itself never writes the plan store.

- [ ] **Step 1: Add failing request-guard tests.** Start a deferred review, invoke `requestHyperPlanReview` twice before resolving it, and assert the review callback ran once and the duplicate returned `undefined`. Also assert a rejected review still rejects with the exact provider cause and releases its token.
- [ ] **Step 2: Add failing card-state assertions.** Extend `ReviewPlanCard.test.tsx` to verify `reviewing` renders an accessible status and GIF, disables the review button, `completed` renders `revisedContent` and both choice labels, and `error` displays the supplied short error without showing candidate Markdown.
- [ ] **Step 3: Verify RED.** Run `npx vitest run --root . apps/desktop/src/renderer/src/features/agent/ChatPane.test.ts apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.test.tsx` and confirm failures point to missing guard/state/rendering behavior.
- [ ] **Step 4: Copy the provided GIF and implement the renderer state.** Keep `originalPlan` and `revisedContent` in one review-state union keyed by plan id/hash; enter `reviewing` before awaiting IPC; use a synchronous token ref to prevent same-tick duplicates; catch only to set an actionable error; on review rejection show the original and error; on **Manter plano anterior** discard the candidate without IPC; on **Usar plano revisado** enter `applying`, call `window.modus.agent.applyHyperPlanRevision` with the original hash, and update the parent only after success. If acceptance fails, restore the original and show that cause.
- [ ] **Step 5: Implement the card.** Import `docs/media/hp-mode.gif` using the existing renderer Vite asset import path. While reviewing, show the GIF and `role="status"`; after completion stop rendering it and show the revised Markdown with both explicit actions; after failure show the original plan and the error. Keep build/continue actions separate from both review-choice actions.
- [ ] **Step 6: Verify GREEN.** Run the same focused renderer Vitest command and desktop typecheck.

### Task 5: Focused final verification

**Files:**
- No additional files unless a focused check exposes a specific regression.

- [ ] **Step 1: Run the affected functional tests once together.**

```powershell
npx vitest run --root . `
  apps/desktop/src/main/agent/harness/hyperplan.test.ts `
  apps/desktop/src/main/plan/plan-store.test.ts `
  apps/desktop/src/main/ipc/register-app-ipc.test.ts `
  apps/desktop/src/main/ipc/schemas.test.ts `
  apps/desktop/src/renderer/src/features/agent/ChatPane.test.ts `
  apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.test.tsx
```

- [ ] **Step 2: Run `npm --workspace @modus/desktop run typecheck` and `git diff --check`.** Do not run the full repository test suite or add broader verification unless one of these focused checks fails.
- [ ] **Step 3: Inspect the final diff against the approved spec.** Confirm the review never writes; only explicit acceptance updates the current body; stale plan hashes reject; the event preserves state after reload; errors retain their causes; no generic successful all-unavailable result remains.

## Self-review

- **Spec coverage:** harness cause propagation and revised body are Task 1; original-plan metadata preservation is Task 2; trusted acceptance, hash validation, and persisted `plan.updated` are Task 3; GIF, duplicate lock, error restoration, and explicit choices are Task 4; essential verification is Task 5.
- **Placeholder scan:** no TBD/TODO implementation steps; each code step gives a concrete behavior or exact command.
- **Type consistency:** `HyperPlanSummary.revisedContent` is consumed by the UI; `applyHyperPlanRevision` returns `PlanRef`; `updatePlanContentById` receives the captured `planHash` and returns `PlanRef | undefined`.
- **Ownership/dependencies:** Task 1 produces the shared response contract; Task 2 is independent and owns only `plan-store`; Task 3 depends on both and owns IPC/preload; Task 4 consumes the published signatures and owns renderer/UI/asset; Task 5 validation owner is the orchestrator.

## Integrity Review Follow-up

Oracle review confirmed that the prompt's 12 KiB cap can silently discard part of a plan accepted at up to 64 KiB, the store trusts metadata hashes over current Markdown, and sequential Markdown/metadata/event writes can leave divergent state after an error. Keep the current one-window, sender-scoped `agentEvent` behavior; do not add a HyperPlan-only global broadcast.

### Task 6: Never review or replace a truncated plan

**Files:**
- Modify/test: `apps/desktop/src/main/agent/harness/hyperplan.ts`
- Test: `apps/desktop/src/main/agent/harness/hyperplan.test.ts`

- [ ] Add a test passing a plan body of `12 * 1024 + 1` UTF-8 bytes; assert review rejects with an actionable 12 KiB limit error and no critic prompt runs.
- [ ] Add an assertion that a successful critic and synthesis prompt both contain a unique marker at the very end of an accepted full plan body.
- [ ] Change prompt construction so it never shortens `planContent`. Reject the review before starting critics when the complete body exceeds 12 KiB. Keep the complete body unchanged in critic and synthesis inputs; if a complete prompt cannot fit after trimming only critic findings/references, reject instead of removing plan text.
- [ ] Run `npx vitest run --root . apps/desktop/src/main/agent/harness/hyperplan.test.ts` and confirm both the oversized rejection and full-body marker assertions pass.

### Task 7: Make explicit acceptance recoverable on synchronous failures

**Files:**
- Modify/test: `apps/desktop/src/main/plan/plan-store.ts`, `apps/desktop/src/main/plan/plan-store.test.ts`
- Modify/test: `apps/desktop/src/main/ipc/register-app-ipc.ts`, `apps/desktop/src/main/ipc/register-app-ipc.test.ts`

**Interface refinement:**

```ts
updatePlanContentById(
  rootDir: string,
  id: string,
  expectedHash: string,
  content: string,
  afterPersist?: (updated: PlanRef) => void,
): PlanRef | undefined;
```

- [ ] Add a store test that edits `plan.md` directly while leaving its metadata hash unchanged; assert applying with the old hash rejects and does not overwrite the external edit.
- [ ] Add a store test whose `afterPersist` callback throws; assert both the Markdown body and metadata/hash are restored to their exact pre-update state.
- [ ] In `updatePlanContentById`, require both metadata hash and `hashContent(plan.content)` to equal `expectedHash`. Replace each file through a same-directory temporary file and rename, following `main/files/files-service.ts`; retain the old body and metadata bytes and restore both if either replacement or `afterPersist` fails. If restoration fails, set an in-memory block for that plan before attempting to write `hyperplan-revision-in-doubt`; if marker creation succeeds, the marker blocks updates until manually removed after repair, and if marker creation fails, retain the in-memory block until process restart. Report an indeterminate state in either case. Add tests for failed Markdown replacement, failed metadata replacement, failed rollback of one/both files, successful marker creation, marker creation failure, rejection of a later update in both marker and in-memory-lock cases, and successful acceptance after manual repair plus marker removal.
- [ ] In the IPC handler, resolve the sender window before mutation; pass event persistence as `afterPersist`, so event-recording failure triggers store rollback. Send `plan.updated` only after the callback commits. If sending to the already-committed sender window throws, log the delivery failure but resolve with the persisted updated plan; do not roll back a durable update. Keep the existing sender-only event scope.
- [ ] Add IPC tests proving an event-store exception rejects before delivery and a post-commit send exception does not turn a persisted update into a reported failure. Run `npx vitest run --root . apps/desktop/src/main/plan/plan-store.test.ts apps/desktop/src/main/ipc/register-app-ipc.test.ts`.

### Task 8: Re-run focused final verification

- [ ] Run all six focused files listed in Task 5 together; require zero failures.
- [ ] Run `npm --workspace @modus/desktop run typecheck` and `git diff --check`.
- [ ] Inspect the final diff for complete-body review, actual-disk hash validation, rollback on synchronous file/event failure, explicit apply-only mutation, and the documented residual that process termination between filesystem writes is not a cross-filesystem/database transaction.
