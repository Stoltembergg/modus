# HyperPlan Review-to-Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` task-by-task. Backend implementation is owned by `@fixer`; renderer implementation is owned by `@designer`; the orchestrator owns integration validation. Keep those write scopes disjoint.

**Goal:** Generate an ephemeral, complete HyperPlan revision, show only that revision after review, and immediately build either the accepted revision or the unchanged original.

**Architecture:** Keep the authoritative revision in main-process memory behind a one-use draft ID and verify its source fingerprint before either choice. Resolving a choice returns a main-owned selection token and reserves that session; the renderer then immediately calls the dedicated build-start API without another confirmation. That API starts exactly one new run or returns a clear conflict, never queues a follow-up prompt. Revision promotion and normal `plan.updated` publication happen before the selection is returned. Per-session reservations serialize review choices and build starts against active runs/promotions. Choice resolution and build-start requests are independently idempotent after lost responses; the UI may retry only the same choice/version and selection, never fall back to the original automatically. The renderer owns the full-modal GIF/ThinkingStates loading treatment and the two final build actions.

**Tech Stack:** Electron IPC, TypeScript, React, Zod, Pi coding-agent sessions, Node filesystem APIs, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-09-28-hyperplan-review-to-build-design.md`

## Global Constraints

- Do not persist a revision draft before the user chooses it.
- A revision draft is main-process-owned, bound to sender/session/workspace/plan and a fingerprint of title, overview, Markdown, TODOs, and Spec; the renderer returns only its opaque draft ID.
- Never generate from the truncated critic input; reject a source that exceeds the revision input budget rather than silently truncating it.
- Critic, synthesis, and revision sessions remain isolated and have no tools.
- Revision has no inherited QA evidence; todos and acceptance criteria are pending and build status is `not_built` until normal build lifecycle events update it.
- A failed review or promotion never starts a build and never mutates the original plan.
- The accepted revision is promoted coherently and its normal `plan.updated` event is persisted/emitted before the choice operation resolves; the original choice performs no promotion.
- A choice that is accepted by main starts a new run without a second renderer confirmation. An active run/build blocks the choice rather than turning its plan ID into a follow-up.
- Promotion and build start share a main-process per-session reservation/serialization mechanism; neither may race an active run or another promotion/start.
- A failed review may explicitly offer the unchanged original as a separate user choice. Once a choice request may have promoted a revision, failure/timeout is uncertain: do not offer original automatically; retry/reconcile only the exact same choice and source version after revalidation.
- The user-provided `hp-mode.gif` is bundled locally; runtime code must not depend on its absolute Desktop path.
- During review, only the GIF and `ThinkingStates` are visible. After success, only the revised plan and the two build choices are visible.

## Interfaces and Work Graph

Public shared contract, produced in Task 1:

```ts
export type HyperPlanRevision = {
  title: string;
  overview: string;
  content: string;
  todos: Array<Pick<PlanTodo, "id" | "content" | "acceptanceCriterionIds">>;
  spec: {
    requirements: PlanRequirement[];
    acceptanceCriteria: Array<Omit<PlanAcceptanceCriterion, "status">>;
    assumptions: string[];
    openQuestions: string[];
  };
};

export type HyperPlanDraftPreview = { draftId: string; revision: HyperPlanRevision };
export type HyperPlanChoice = "revision" | "original";
export type HyperPlanReviewInput = Pick<PlanRef, "title" | "overview" | "content" | "todos"> & {
  spec: PlanSpec;
};
export type HyperPlanChoiceRequest = { draftId: string; choice: HyperPlanChoice; requestId: string };
export type HyperPlanBuildSelection = {
  selectionId: string;
  plan: PlanRef;
  planFingerprint: string;
};
export type HyperPlanBuildStart = {
  selectionId?: string;
  sessionId: string;
  planId: string;
  planFingerprint: string;
  runId: string;
};
```

Main-process persistence interface, produced in Task 2:

```ts
fingerprintPlanSource(plan: Pick<PlanRef, "title" | "overview" | "content" | "todos" | "spec">): string
promotePlanRevision(rootDir: string, input: {
  planId: string;
  expectedFingerprint: string;
  revision: HyperPlanRevision;
}): PlanRef
```

The main-process draft registry, per-session reservation primitive, and guarded choice IPC in Task 3 consume those interfaces. Task 4 extends that reservation primitive with the exclusive start API. Task 5 consumes those preload methods and owns renderer files/assets. Task 6 adds teardown cleanup and its tests. Tasks 1–4 and 6 are `@fixer`'s backend scope; Task 5 is `@designer`'s renderer scope. Task 5 depends on the public contract in Task 1 and preload methods in Tasks 3 and 4. Task 6 depends on Task 3's draft cleanup API and can run in parallel with Task 4 after Task 3; Task 5 waits for Task 4. Task 7 is orchestrator-owned integration and verification.

---

### Task 1: Define revision contract and generate a validated draft

**Owner:** `@fixer`

**Files:**
- Modify: `apps/desktop/src/shared/contracts.ts`
- Modify: `apps/desktop/src/main/agent/harness/hyperplan.ts`
- Test: `apps/desktop/src/main/agent/harness/hyperplan.test.ts`

**Interfaces:**
- Consumes: existing `PlanRef`, `PlanTodo`, `PlanSpec`, and the four critic/synthesis outputs.
- Produces: `HyperPlanRevision`, `HyperPlanReviewInput`, and a new `runHyperPlanRevision(input: HyperPlanReviewInput): Promise<HyperPlanRevision>`. Keep the existing `runHyperPlanReview` summary contract unchanged until Task 3 adds the new draft IPC and Task 5 migrates ChatPane.

- [ ] **Step 1: Add failing revision-pipeline tests**

Add tests for `runHyperPlanRevision` proving a successful review produces the complete revision shape, includes the untruncated source Markdown/title/todos in the revision prompt, and does not produce a revision if no critic completes or synthesis is invalid. Extend the prompt mock to return a revision payload only for a `REVISION_INPUT:` prompt; preserve the existing `runHyperPlanReview` summary tests and behavior.

```ts
expect(result).toEqual({ title: "Release readiness", overview: "Prepare the release safely.", content: "# Revised", todos: expect.any(Array), spec: expect.objectContaining({ requirements: expect.any(Array), acceptanceCriteria: expect.any(Array) }) });
expect(revisionPrompt).toContain("SOURCE_PLAN:");
expect(revisionPrompt).toContain("FULL_PLAN_END_SENTINEL");
```

- [ ] **Step 2: Run the harness tests and confirm the new assertions fail**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/agent/harness/hyperplan.test.ts`
Expected: the new revision tests fail because the current harness returns `HyperPlanSummary` and has no revision stage.

- [ ] **Step 3: Add the shared revision types and strict output schema**

Define the public revision type from the Interfaces section. Add a strict Zod schema for title, overview, Markdown, todos, requirements, acceptance criteria, assumptions, and open questions. Omit evidence and status from model output; reject extra fields, invalid todo/criterion links, duplicate IDs, empty required strings, and oversized JSON.

- [ ] **Step 4: Implement a bounded revision prompt over the full source**

Keep existing critic and synthesis stages in a shared internal pipeline. Add `runHyperPlanRevision` to call that pipeline and, only after valid critic and synthesis output, run a no-tool revision session with the full source `PlanRef` fields and bounded synthesis feedback. Keep `runHyperPlanReview` as a compatibility wrapper returning only `HyperPlanSummary` until the renderer migration. Give revision input/output explicit byte limits; if the complete source does not fit, return a safe unavailable error instead of truncating the source. Reset every generated todo and criterion to pending and set Spec evidence to `[]` before returning the revision.

- [ ] **Step 5: Run the harness tests and typecheck**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/agent/harness/hyperplan.test.ts`
Expected: all harness tests pass, including timeout, malformed output, full-source input, and no-draft-on-failure cases.

Run: `npm run typecheck --workspace @modus/desktop`
Expected: exit code 0.

- [ ] **Step 6: Commit the harness contract**

```powershell
git add -- apps/desktop/src/shared/contracts.ts apps/desktop/src/main/agent/harness/hyperplan.ts apps/desktop/src/main/agent/harness/hyperplan.test.ts
git commit -m "feat: generate validated HyperPlan revisions"
```

### Task 2: Fingerprint and coherently promote a chosen revision

**Owner:** `@fixer`; depends on Task 1.

**Files:**
- Modify: `apps/desktop/src/main/plan/plan-store.ts`
- Test: `apps/desktop/src/main/plan/plan-store.test.ts`

**Interfaces:**
- Consumes: `HyperPlanRevision` from Task 1.
- Produces: `fingerprintPlanSource(...)` and `promotePlanRevision(rootDir, input): PlanRef` from the Interfaces section.

- [ ] **Step 1: Add failing plan-store tests**

Cover a matching fingerprint promotion, stale-source rejection, reset of Spec evidence and statuses, hash recomputation, consistency of `plan.md` and `plan.json`, rollback after an injected publication failure, and recovery from a transaction marker left by an interrupted promotion.

```ts
const before = readPlanById(root, plan.id)!;
expect(() => promotePlanRevision(root, { planId: plan.id, expectedFingerprint: "stale", revision })).toThrow(/changed/i);
expect(readPlanById(root, plan.id)).toEqual(before);
```

- [ ] **Step 2: Run the plan-store test and confirm the missing API fails**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/plan/plan-store.test.ts`
Expected: the new tests fail because source fingerprinting and revision promotion do not exist.

- [ ] **Step 3: Implement canonical source fingerprinting**

Hash canonical title, overview, content, todo IDs/content/criterion links, and Spec fields using SHA-256. Preserve array order and serialize object fields deterministically. Do not use `PlanRef.hash` as the complete fingerprint; it only hashes Markdown.

- [ ] **Step 4: Implement promotion with recovery-safe publication**

Read the authoritative plan and compare its full fingerprint before writing. Build normalized Markdown, TODOs, pending acceptance criteria, empty evidence, and `not_built` metadata. Stage both files before publishing; use a transaction marker and backup so a normal exception rolls back immediately and a later read recovers the prior authoritative files after an interrupted promotion. Throw without returning a promoted `PlanRef` unless both files are coherent. This storage operation must not publish events itself; the guarded IPC choice path (Task 3) persists/emits the ordinary `plan.updated` event with the promoted `PlanRef` before resolving to the caller, so ChatPane observes the active plan.

- [ ] **Step 5: Run plan-store tests and desktop typecheck**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/plan/plan-store.test.ts`
Expected: all promotion, stale-source, and rollback tests pass.

Run: `npm run typecheck --workspace @modus/desktop`
Expected: exit code 0.

- [ ] **Step 6: Commit plan promotion**

```powershell
git add -- apps/desktop/src/main/plan/plan-store.ts apps/desktop/src/main/plan/plan-store.test.ts
git commit -m "feat: promote HyperPlan revisions safely"
```

### Task 3: Keep drafts in main and expose guarded choice IPC

**Owner:** `@fixer`; depends on Tasks 1 and 2.

**Files:**
- Create: `apps/desktop/src/main/agent/harness/hyperplan-draft-store.ts`
- Test: `apps/desktop/src/main/agent/harness/hyperplan-draft-store.test.ts`
- Modify: `apps/desktop/src/main/ipc/channels.ts`
- Modify: `apps/desktop/src/main/ipc/schemas.ts`
- Modify: `apps/desktop/src/main/ipc/register-app-ipc.ts`
- Test: `apps/desktop/src/main/ipc/register-app-ipc.test.ts`
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts` (normal runtime event dispatch/persistence path)
- Test: `apps/desktop/src/main/agent/pi-sdk-runtime.test.ts`
- Modify: `apps/desktop/src/preload/types.ts`
- Modify: `apps/desktop/src/preload/index.ts`

**Interfaces:**
- Consumes: `HyperPlanRevision`, `HyperPlanDraftPreview`, `HyperPlanChoice`, `fingerprintPlanSource`, and `promotePlanRevision`.
- Produces: new `createHyperPlanDraft({ sessionId, planId }): Promise<HyperPlanDraftPreview>` and `resolveHyperPlanDraft({ draftId, choice, requestId }): Promise<HyperPlanBuildSelection>` IPC/preload methods, plus a per-session reservation primitive shared with Task 4. Keep the existing `reviewPlanWithHyperPlan(): Promise<HyperPlanSummary>` bridge/channel intact until Task 5 migrates ChatPane. Resolution returns a main-owned selection token and reserves the session until Task 4's exclusive start API accepts or expires it. Renderer requests include only `{ draftId, choice, requestId }`; they never send plan/revision/build bodies.

Draft registry functions:

```ts
type StoredHyperPlanDraft = {
  ownerId: number;
  sessionId: string;
  workspaceId: string;
  planId: string;
  sourceFingerprint: string;
  revision: HyperPlanRevision;
  expiresAt: number;
};

type StoredHyperPlanSelection = {
  selectionId: string;
  ownerId: number;
  sessionId: string;
  workspaceId: string;
  planId: string;
  planFingerprint: string;
  choiceRequestId: string;
  choice: HyperPlanChoice;
  expiresAt: number;
};

storeHyperPlanDraft(input: {
  ownerId: number;
  sourcePlan: PlanRef;
  revision: HyperPlanRevision;
  now?: number;
}): HyperPlanDraftPreview
takeHyperPlanDraft(input: { ownerId: number; draftId: string; now?: number }): StoredHyperPlanDraft | undefined
resolveHyperPlanDraftRequest(input: HyperPlanChoiceRequest & { ownerId: number }): HyperPlanBuildSelection
getHyperPlanSelection(input: { ownerId: number; selectionId: string; now?: number }): StoredHyperPlanSelection | undefined
clearHyperPlanDraftsForOwner(ownerId: number): void // also removes its selections/releases reservations
clearHyperPlanDraftsForSession(sessionId: string): void // also removes its selections/releases reservations
```

Resolution consumes the draft exactly once but caches its result by owner/request ID so an identical retry can recover the same selection token. The selection token is main-owned, one-use for build start, and expires after five minutes; a pending session reservation is released on start, explicit cancellation, teardown, or expiry.

- [ ] **Step 1: Add failing draft-store tests**

Test that a draft ID is unpredictable, bound to its `webContents.id` and session, expires after 30 minutes, and cannot be read or consumed by another sender. During a mocked in-flight review, mutate the authoritative plan and assert the before/after fingerprint check prevents draft registration. Test choice operation identity: duplicate requests for the same request ID/draft/choice/version reconcile to one result; a conflicting choice or version is rejected. Preserve enough main-owned operation state to reconcile a lost IPC response without promoting or starting twice.

```ts
const preview = storeHyperPlanDraft({ ownerId: 4, sourcePlan, revision });
expect(takeHyperPlanDraft({ ownerId: 5, draftId: preview.draftId })).toBeUndefined();
expect(takeHyperPlanDraft({ ownerId: 4, draftId: preview.draftId })).toMatchObject({ revision });
expect(takeHyperPlanDraft({ ownerId: 4, draftId: preview.draftId })).toBeUndefined();
```

- [ ] **Step 2: Run the draft-store tests and confirm the new API fails**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/agent/harness/hyperplan-draft-store.test.ts`
Expected: the new tests fail because the main-process draft registry does not exist.

- [ ] **Step 3: Implement main-owned one-use draft storage**

Store revision bodies only in main memory. Return preview data plus an opaque ID, retain sender/session/workspace/source fingerprint in the private record, set a 30-minute TTL, and expose cleanup by sender ID and session ID for window/session teardown. Never accept revision content from the renderer during choice resolution.

- [ ] **Step 4: Add strict choice IPC and preload methods**

Add a new draft-generation handler/channel that fingerprints the plan before invoking Task 1's `runHyperPlanRevision`, re-reads and compares after generation, and registers/returns a preview only if unchanged. Preserve the old summary-only handler/channel for the current renderer until Task 5 migrates it. A review failure may return a distinct recoverable state that allows the user to explicitly choose a fresh build of the original. Add guarded choice handling accepting only `{ draftId, choice, requestId }`; verify sender/session/workspace and source fingerprint, reserve the session through Task 3's shared reservation primitive, and resolve only that exact choice/version. For revision, atomically promote and publish normal `plan.updated` through the established runtime event path (`pi-sdk-runtime.ts` dispatches/persists via `agent-event-store.ts`) before returning the selection; for original, use the unchanged original without promotion. Return a main-owned selection token/fingerprint for Task 4's immediately-following exclusive start API, never a selection intended for a generic prompt. Record/reconcile operation state for duplicate requests and lost responses, and reject a different choice or stale fingerprint after an uncertain result. Add the new draft/choice bridge methods to `ModusApi` and `preload/index.ts` without changing the legacy summary bridge yet. The main operation must not accept a plan body from renderer.

- [ ] **Step 5: Test IPC ownership, stale drafts, and both choices**

Add tests proving acceptance promotes and persists/emits `plan.updated` before returning, choosing original performs no store write, invalid owner/session and stale source are rejected, and replay cannot consume the draft twice. Simulate a lost choice-resolution response and retry the same choice request ID to recover one selection. Assert a conflicting choice/request or attempt to switch to original is rejected. Test that a busy run prevents reservation/promotion and concurrent choice/promotion attempts in one session serialize so only one can win. Defer lost-start-response idempotency and duplicate `run.started` assertions to Task 4, which introduces the exclusive start API.

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/agent/harness/hyperplan-draft-store.test.ts apps/desktop/src/main/ipc/register-app-ipc.test.ts apps/desktop/src/main/agent/pi-sdk-runtime.test.ts`
Expected: all draft registry, stale-during-generation, and IPC cases pass, including lost-response idempotency, event publication ordering, and concurrent-operation exclusion.

- [ ] **Step 6: Commit guarded draft IPC**

```powershell
git add -- apps/desktop/src/main/agent/harness/hyperplan-draft-store.ts apps/desktop/src/main/agent/harness/hyperplan-draft-store.test.ts apps/desktop/src/main/ipc/channels.ts apps/desktop/src/main/ipc/schemas.ts apps/desktop/src/main/ipc/register-app-ipc.ts apps/desktop/src/main/ipc/register-app-ipc.test.ts apps/desktop/src/main/agent/pi-sdk-runtime.ts apps/desktop/src/main/agent/pi-sdk-runtime.test.ts apps/desktop/src/preload/types.ts apps/desktop/src/preload/index.ts
git commit -m "feat: add guarded HyperPlan draft choices"
```

### Task 4: Exclusively start the selected plan build

**Owner:** `@fixer`; depends on Tasks 2 and 3. This task extends some of Task 3's IPC/preload/runtime files and must run after Task 3, not in parallel with it; no renderer-owned files overlap this backend lane.

**Files:**
- Modify: `apps/desktop/src/main/ipc/channels.ts`
- Modify: `apps/desktop/src/main/ipc/schemas.ts`
- Modify: `apps/desktop/src/main/ipc/register-app-ipc.ts`
- Test: `apps/desktop/src/main/ipc/register-app-ipc.test.ts`
- Modify: `apps/desktop/src/main/agent/harness/hyperplan-draft-store.ts`
- Test: `apps/desktop/src/main/agent/harness/hyperplan-draft-store.test.ts`
- Modify: `apps/desktop/src/main/agent/runtime.ts`
- Modify: `apps/desktop/src/preload/types.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts`
- Test: `apps/desktop/src/main/agent/pi-sdk-runtime.test.ts`
- Modify: `apps/desktop/src/main/browser/browser-service.ts`
- Test: `apps/desktop/src/main/browser/browser-service.test.ts`
- Modify: `apps/desktop/src/main/browser/tab-store.ts`
- Modify: `apps/desktop/src/main/agent/tools/browser-tools.ts`
- Test: `apps/desktop/src/main/agent/tools/browser-tools.test.ts`

**Interfaces:**
- Consumes: `fingerprintPlanSource(plan)` from Task 2.
- Produces: `startPlanBuild({ selectionId, requestId }): Promise<HyperPlanBuildStart>` on `window.modus.agent`, plus an explicit `startOriginalPlanBuild({ sessionId, planId, requestId }): Promise<HyperPlanBuildStart>` for the user's deliberate original choice after review failure. Main derives and revalidates the fingerprint from authoritative state; renderer sends no plan/build body. Both are backed by a main-process per-session reservation. A successful start creates exactly one new run and returns only after `run.started` is persisted/emitted. They reject if any run/build is active and can never become generic follow-up prompts.

- [ ] **Step 1: Add a failing runtime test for a stale selected plan**

Add failing tests for a stale selected fingerprint and for the dedicated start API. Assert stale selection or an active build is rejected before start; an allowed selection starts exactly one new run and emits/persists one `run.started`; concurrent identical retries share the same in-flight operation and a retry after a lost response returns the same run without a second run/event; conflicting request parameters are rejected. Inject failure during pre-run user-message/status emission (after event persistence) and verify cleanup releases both preflight and HyperPlan reservations while retries reuse stable event identities. Inject failures in both authoritative plan reads after preflight and verify the exact preflight reservation is released. Inject failure after `run.started` (for example the following busy-status send) and verify that exact run is failed/settled, tracker/status/build state and its reservation are released, and a best-effort `session.status: idle` is emitted; the background rejection is handled. During every async preparation boundary, generic prompts and competing choices remain blocked. Test both race orders with compaction: a pending HyperPlan reservation prevents compaction, and a compaction reservation prevents start until it finishes. No code path submits a follow-up prompt or asks renderer for confirmation.

Browser-control visuals are leased per `(tab, sessionId)`: repeated engage by one session is idempotent; releasing one session must not dim a tab still owned by another; distinct tabs remain independent; close/dispose drops the tab's leases. Browser tools pass their AsyncLocalStorage session owner, and every runtime release site supplies that owner. Agent-initiated navigation must use the same owner-aware path.

- [ ] **Step 2: Run the focused runtime test and confirm it fails**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/agent/pi-sdk-runtime.test.ts -t "plan fingerprint"`
Expected: the current generic prompt path has no selection-bound exclusive start API, so these assertions fail.

- [ ] **Step 3: Implement the exclusive start API and reservation**

Add the dedicated main/preload `startPlanBuild({ selectionId, requestId })` API and strict schemas, plus `startOriginalPlanBuild({ sessionId, planId, requestId })` for an explicit original choice after review failure. Resolve the authoritative plan/fingerprint in main; renderer-supplied plan bodies are never accepted. Extend the draft store with a synchronous selection claim and a main-owned `StartOperation` keyed by owner/request ID and bound to kind, selection or session/plan, and fingerprint. Before the first `await`, an identical concurrent retry joins the same Promise; conflicting parameters or another operation for the reserved session are rejected. Keep `isHyperPlanSessionReserved()` true through `selection → starting → active(runId)`; only the dedicated runtime start capability may cross its own reservation, while generic prompts and competing choices remain blocked through every await.

Implement runtime starts as exclusive fresh-run operations, not calls to a generic path that may queue a follow-up. Revalidate plan ownership/fingerprint and busy/compaction state after async preparation. Every pre-run emission must be inside cleanup that releases its exact preflight reservation even if event persistence or renderer delivery throws; wrap both plan reads after reservation in that cleanup path and give retryable pre-run events stable identities derived from the start operation. Record `runId` in the start operation immediately after `createAgentRun()` and before persisting/emitting `run.started`. Protect all work after run creation—including setup before the long prompt-finalization block—with run-scoped failure settlement, so any throw marks the same run terminal, updates plan/session status, removes only its tracker, and releases only its matching reservation. Emit a best-effort `session.status: idle` after terminal settlement, but not when preserving an active run for same-event delivery retry. The start API resolves once `run.started` is persisted/emitted, then leaves the long-running turn in background with its rejection handled. Give `run.started` a stable persistence identity derived from `runId`, so a retry after persistence/send failure re-emits the same event without inserting another row; distinguish only failure in the current emission attempt from errors before it. A failure before run creation releases the reservation for a safe retry; after creation, the same run must be reconciled/settled rather than creating another. Compaction and HyperPlan start must acquire the same synchronous per-session exclusion before awaiting. Transfer reservation ownership to the active run and release it only on matching terminal lifecycle events. Browser-control visuals use per-tab sets of owning session IDs; only release a visual when its last owner ends. Retain request/run mappings long enough to recover a lost start response, including if the run terminates before retry. A failed start after successful promotion leaves the accepted plan persisted with `not_built`; the UI reports the failure and retries only that same selection.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/agent/pi-sdk-runtime.test.ts -t "plan fingerprint"`
Expected: a selection whose source changes after resolution and active runs are rejected; a matching main-owned selection begins exactly one fresh lifecycle and emits one `run.started`, with no follow-up or duplicate run on retry.

Run: `npm run typecheck --workspace @modus/desktop`
Expected: exit code 0.

- [ ] **Step 5: Commit the build guard**

```powershell
  git add -- apps/desktop/src/main/ipc/schemas.ts apps/desktop/src/main/ipc/register-app-ipc.ts apps/desktop/src/main/ipc/register-app-ipc.test.ts apps/desktop/src/main/agent/runtime.ts apps/desktop/src/preload/types.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/agent/pi-sdk-runtime.ts apps/desktop/src/main/agent/pi-sdk-runtime.test.ts apps/desktop/src/main/browser/browser-service.ts apps/desktop/src/main/browser/browser-service.test.ts apps/desktop/src/main/browser/tab-store.ts apps/desktop/src/main/agent/tools/browser-tools.ts apps/desktop/src/main/agent/tools/browser-tools.test.ts
  git commit -m "feat: exclusively start selected HyperPlan build"
```

### Task 5: Implement the full-modal loading and plan-choice UX

**Owner:** `@designer`; depends on Tasks 1, 3, and 4 so the public draft, selection IPC, and fingerprint-guarded build API exist.

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.tsx`
- Test: `apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.test.tsx`
- Modify: `apps/desktop/src/renderer/src/features/agent/ChatPane.tsx`
- Test: `apps/desktop/src/renderer/src/features/agent/ChatPane.test.ts`
- Add: `apps/desktop/src/renderer/src/assets/hp-mode.gif` (copy from the user-provided `docs/media/hp-mode.gif`)

**Interfaces:**
- Consumes: `HyperPlanDraftPreview`, `HyperPlanChoice`, `createHyperPlanDraft`, and the dedicated choice/start preload APIs.
- Produces: in-memory ChatPane states `idle | loading | ready | choosing | review-error | choice-error | start-error`; `ready` carries the preview and opaque draft ID. `buildPlanLocally` uses the dedicated main-process start API with a main-owned selection token, never generic `submitPrompt` as the guarantee.

The card receives that status plus the preview when ready and exposes `onChoosePlan(choice: HyperPlanChoice): void`; it never receives the authoritative main-process revision object except for the renderer-safe preview. Distinguish review failure (where the UI may explicitly offer build-original) from uncertain choice-resolution failure (where only an explicit retry of the same choice/draft version is permitted).

- [ ] **Step 1: Add failing renderer tests for loading and ready states**

In `ReviewPlanCard.test.tsx`, assert loading contains the GIF and `ThinkingStates` labels but not the title, original content, criteria, footer, or build buttons. Assert ready shows revised Markdown and exactly the revised/original choices, but no original body, critic summary, or criteria. Use Testing Library clicks to prove each choice emits only its matching `HyperPlanChoice`.

```tsx
const loading = renderCard({ hyperPlanState: { status: "loading" } });
expect(loading).toContain('data-testid="hyperplan-gif"');
expect(loading).not.toContain("Implement this plan?");
expect(loading).not.toContain("Acceptance criteria");

const onChoosePlan = vi.fn();
render(<ReviewPlanCard hyperPlanState={{ status: "ready", draft }} onChoosePlan={onChoosePlan} {...baseProps} />);
await user.click(screen.getByRole("button", { name: "Accept revised plan and build" }));
expect(onChoosePlan).toHaveBeenCalledWith("revision");
```

- [ ] **Step 2: Run the ReviewPlanCard tests and confirm the new assertions fail**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.test.tsx`
Expected: the current card still shows original content/actions during loading and has no revised-plan state.

- [ ] **Step 3: Bundle the user-provided GIF**

Run:

```powershell
Copy-Item -LiteralPath 'C:\Users\Gabriel\Desktop\Modus\modus\docs\media\hp-mode.gif' -Destination 'apps/desktop/src/renderer/src/assets/hp-mode.gif'
```

Confirm the destination exists and is 700,546 bytes before importing it. The renderer must import the bundled asset, never use the absolute source path at runtime.

- [ ] **Step 4: Implement the reviewed-plan card states**

Have `@designer` implement the overlay across the entire modal, centered GIF, and cycling `ThinkingStates` labels; hide every other modal element while loading and block all submissions. Render only the revised plan and the two build choices in `ready`. In review `error`, allow retry or an explicit original-build choice by calling `startOriginalPlanBuild` with only the current session/plan IDs and a new request ID. In post-choice uncertain error, do not show or trigger original-build; show only retry of the exact same choice and version, preserving request IDs for main reconciliation. Keep copy consistent with existing English UI and make interactive states keyboard/accessibility friendly.

- [ ] **Step 5: Connect ChatPane to main-owned draft choices**

Have `@designer` update `ChatPane` to use `createHyperPlanDraft` for the preview, hold only renderer preview data/draft ID, and automatically sequence choice resolution then the existing build entry point backed by the dedicated exclusive start API:

```ts
const selection = await window.modus.agent.resolveHyperPlanDraft({
  draftId,
  choice,
  requestId: choiceRequestId,
});
await buildPlanLocally(selection);
```

`buildPlanLocally(selection)` calls `window.modus.agent.startPlanBuild({ selectionId: selection.selectionId, requestId: startRequestId })`; it never submits a generic prompt or renderer-built plan body. Create one choice request ID and one start request ID per user choice, and reuse each only to retry/reconcile that exact choice/version/selection after an uncertain response. The renderer performs this sequence automatically after the user's single choice, with no second confirmation. Never automatically offer original after choice resolution may have promoted. Ignore stale UI responses, disable duplicate clicks while pending, and clear/replace drafts on plan/session changes; allow a new explicit original choice only when review itself failed or the user chose original in the ready state.

- [ ] **Step 6: Run renderer tests and typecheck**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.test.tsx apps/desktop/src/renderer/src/features/agent/ChatPane.test.ts`
Expected: loading, ready, review-failure original action, uncertain-choice same-version retry only, choice dispatch, duplicate prevention, and stale response tests pass.

Run: `npm run typecheck --workspace @modus/desktop`
Expected: exit code 0.

- [ ] **Step 7: Commit the renderer UX**

```powershell
git add -- apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.tsx apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.test.tsx apps/desktop/src/renderer/src/features/agent/ChatPane.tsx apps/desktop/src/renderer/src/features/agent/ChatPane.test.ts apps/desktop/src/renderer/src/assets/hp-mode.gif
git commit -m "feat: show HyperPlan revision choice flow"
```

### Task 6: Clear drafts during owner and session teardown

**Owner:** `@fixer`; depends on Task 3.

**Files:**
- Modify: `apps/desktop/src/main/windows/main-window.ts`
- Test: `apps/desktop/src/main/windows/main-window.test.ts`
- Modify: `apps/desktop/src/main/agent/session-lifecycle.ts`
- Create: `apps/desktop/src/main/agent/session-lifecycle.test.ts`

- [ ] **Step 1: Add failing teardown cleanup tests**

Test that closing/destroying the owning window/webContents invokes `clearHyperPlanDraftsForOwner(webContents.id)` exactly once, clearing its drafts, selections, and pending reservations; deleting an agent session invokes `clearHyperPlanDraftsForSession(sessionId)` before session teardown completes and also releases any reservation. Cover both explicit close and webContents teardown without relying on window close alone.

- [ ] **Step 2: Run focused lifecycle tests and confirm failure**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/windows/main-window.test.ts apps/desktop/src/main/agent/session-lifecycle.test.ts`
Expected: the cleanup assertions fail because lifecycle hooks are not wired.

- [ ] **Step 3: Wire draft cleanup to lifecycle owners**

Import `clearHyperPlanDraftsForOwner` in the actual directory `apps/desktop/src/main/windows/main-window.ts` (note plural `windows`) and clear on owner teardown/closed hooks. Import `clearHyperPlanDraftsForSession` in `apps/desktop/src/main/agent/session-lifecycle.ts` and invoke it in `deleteAgentSessionTree` before deleting the session. Both cleanup functions must remove pending selections and release matching session reservations as well as dropping draft records. Keep cleanup idempotent and best-effort where teardown already tolerates cleanup failures.

- [ ] **Step 4: Run lifecycle tests and desktop typecheck**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/windows/main-window.test.ts apps/desktop/src/main/agent/session-lifecycle.test.ts`
Expected: owner and session draft cleanup tests pass.

Run: `npm run typecheck --workspace @modus/desktop`
Expected: exit code 0.

- [ ] **Step 5: Commit lifecycle cleanup**

```powershell
git add -- apps/desktop/src/main/windows/main-window.ts apps/desktop/src/main/windows/main-window.test.ts apps/desktop/src/main/agent/session-lifecycle.ts apps/desktop/src/main/agent/session-lifecycle.test.ts
git commit -m "fix: clear HyperPlan drafts on teardown"
```

### Task 7: Verify the complete flow

**Owner:** orchestrator; depends on Tasks 1–6.

**Files:**
- Verify: all touched HyperPlan, plan-store, IPC, runtime, lifecycle, and renderer test files.

- [ ] **Step 1: Run all focused feature tests**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/agent/harness/hyperplan.test.ts apps/desktop/src/main/agent/harness/hyperplan-draft-store.test.ts apps/desktop/src/main/plan/plan-store.test.ts apps/desktop/src/main/ipc/register-app-ipc.test.ts apps/desktop/src/main/agent/pi-sdk-runtime.test.ts apps/desktop/src/main/windows/main-window.test.ts apps/desktop/src/main/agent/session-lifecycle.test.ts apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.test.tsx apps/desktop/src/renderer/src/features/agent/ChatPane.test.ts`
Expected: every focused HyperPlan revision, promotion/event, IPC/idempotency, exclusive-build, cleanup, and UI test passes.

- [ ] **Step 2: Run desktop typecheck, formatting/lint, and full test suite**

Run: `npm run typecheck --workspace @modus/desktop`
Expected: exit code 0.

Run:

```powershell
npx biome check --line-ending=crlf `
  apps/desktop/src/shared/contracts.ts `
  apps/desktop/src/main/agent/harness/hyperplan.ts `
  apps/desktop/src/main/agent/harness/hyperplan.test.ts `
  apps/desktop/src/main/agent/harness/hyperplan-draft-store.ts `
  apps/desktop/src/main/agent/harness/hyperplan-draft-store.test.ts `
  apps/desktop/src/main/plan/plan-store.ts `
  apps/desktop/src/main/plan/plan-store.test.ts `
  apps/desktop/src/main/ipc/channels.ts `
  apps/desktop/src/main/ipc/schemas.ts `
  apps/desktop/src/main/ipc/register-app-ipc.ts `
  apps/desktop/src/main/ipc/register-app-ipc.test.ts `
  apps/desktop/src/main/agent/runtime.ts `
  apps/desktop/src/main/agent/pi-sdk-runtime.ts `
  apps/desktop/src/main/agent/pi-sdk-runtime.test.ts `
  apps/desktop/src/main/windows/main-window.ts `
  apps/desktop/src/main/windows/main-window.test.ts `
  apps/desktop/src/main/agent/session-lifecycle.ts `
  apps/desktop/src/main/agent/session-lifecycle.test.ts `
  apps/desktop/src/preload/types.ts `
  apps/desktop/src/preload/index.ts `
  apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.tsx `
  apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.test.tsx `
  apps/desktop/src/renderer/src/features/agent/ChatPane.tsx `
  apps/desktop/src/renderer/src/features/agent/ChatPane.test.ts
```

Expected: no formatter or lint errors.

Run: `npm run test --workspace @modus/desktop`
Expected: all enabled desktop test suites pass; record any pre-existing skipped tests separately.

- [ ] **Step 3: Review the final diff and verify scope**

Run: `git diff --check; git status --short; git diff --stat`
Expected: only the approved HyperPlan flow, asset, lifecycle cleanup, and tests are modified; no `plan.md` or plan metadata changes are checked in.
