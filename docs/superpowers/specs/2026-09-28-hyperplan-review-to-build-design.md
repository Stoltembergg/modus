# HyperPlan Review-to-Build Design

## Goal

Make HyperPlan produce a complete revised-plan draft and let the user choose the revised plan or the original plan, starting the selected plan's build immediately.

## Approved user decisions

- HyperPlan generates a full rewritten draft; it does not persist that draft before the user chooses.
- The final choice starts the build immediately; there is no second implementation-confirmation step.
- During generation, the GIF and `ThinkingStates` are the only visible modal contents.
- On success, show only the revised plan and the two version choices.
- Use the user-provided GIF at `C:\Users\Gabriel\Desktop\Modus\modus\docs\media\hp-mode.gif`, copied into the desktop renderer's bundled assets. The source file exists and is 700,546 bytes.
- “Follow the previous plan” starts its build without mutating the original.

## Current-state findings

- The current HyperPlan harness runs four critics and a synthesis pass, returning only `HyperPlanSummary`; it does not rewrite or persist a plan.
- The existing review card keeps the plan details and actions visible during loading and renders critic results when complete.
- The current renderer obtains the active plan from persisted plan events. A draft must remain separate from that source of truth until acceptance.
- The plan store writes `plan.md` and `plan.json` in a session-scoped directory. The build executor reads the authoritative persisted plan, not renderer-only draft content.

## Architecture and data flow

1. The main process validates the session and source plan, then runs the existing read-only critic and synthesis stages.
2. A new constrained revision stage consumes the complete source title, overview, Markdown, TODOs, Spec, and bounded critic feedback, and returns a complete structured draft. It must not use the smaller/truncated critic input as the source plan. Preserve the source title and overview unless the revision explicitly returns replacements.
3. Validate the draft against explicit schemas and size limits. Keep the authoritative draft in main-process memory behind an opaque, one-use draft ID; send the renderer only the preview data and ID. Bind it to the originating session, workspace, plan ID, and a fingerprint of canonical title, overview, Markdown, TODOs, and Spec (not `PlanRef.hash`, which covers Markdown only). Do not emit a persisted `plan.updated` event for a draft. Expire unconsumed drafts and discard them on session/window teardown.
4. The renderer displays that draft separately from the persisted plan. Both final actions send only the draft ID and choice, are guarded against duplicate submission, and revalidate source identity in the main process. Never trust a revised plan body sent back from the renderer.
5. “Accept revised plan” atomically promotes the main-owned draft to the active persisted plan, resets build status to `not_built`, removes old QA evidence, and emits the normal plan update. The renderer then starts the existing build entry point with the returned persisted plan.
6. “Build with previous plan” consumes/discards the draft and returns the validated original plan without writing it or changing its Markdown, TODOs, Spec, hash, build status, or evidence. The renderer starts the existing build entry point with that original plan.

Only one active plan version is required. Persistent revision history and rollback are out of scope. Accepting a revision replaces the active plan after the user chooses it; before that choice, the original remains intact. If the source fingerprint no longer matches, reject the stale draft and require a fresh review rather than building from stale data.

## Persistence and failure behavior

- The promotion operation must not leave Markdown and JSON describing different plan versions. Use an atomic publication strategy or explicit rollback/recovery so any failed promotion leaves the original authoritative plan intact.
- Never start a build if plan promotion fails.
- If promotion succeeds but build startup fails, leave the revised plan persisted with `not_built` status and report the startup failure; do not claim the build started.
- If revision generation or schema validation fails, do not create a draft or alter the source plan. Offer retry and an explicit path to build the original plan.
- The revision carries no old-run QA evidence. Criteria/evidence are validated consistently, criteria return to pending where applicable, and build status is `not_built` until the normal build lifecycle changes it.
- Every IPC action validates trusted sender, session/workspace ownership, current source plan identity, and draft fingerprint in the main process. The choice consumes the draft ID once so replayed or duplicate requests cannot promote or build twice.

## Modal behavior

### Generating

- An overlay covers the complete plan modal and hides the title, source plan, criteria, critic results, footer copy, and action buttons.
- Center the bundled `hp-mode.gif`; show the existing `ThinkingStates` component beneath it and no other content.
- Prevent repeated review/build submissions while this state is active.

### Ready to choose

- Hide the original plan body and all critic/evidence details.
- Render only the complete revised plan and two clearly labeled actions: accept the revised plan and build it, or build with the previous plan.
- Do not show a separate implementation-confirmation step.

### Error

- Show a concise, non-sensitive failure message with retry and a way to build the unchanged original plan.
- A failed or timed-out review is never treated as approval and never mutates the persisted plan.

## Implementation scope

- `apps/desktop/src/main/agent/harness/hyperplan.ts`: structured revision output and validation while preserving isolated, no-tool model sessions and bounded inputs/outputs.
- Shared contracts, preload types, and IPC: draft response plus guarded accept/build-original actions.
- `apps/desktop/src/main/plan/plan-store.ts`: atomic promotion of the accepted revision with coherent Markdown, TODOs, Spec, hash, evidence, and build status.
- Existing build entry point: start from the exact persisted plan selected by the action.
- `apps/desktop/src/renderer/src/features/plan/ReviewPlanCard.tsx` and `features/agent/ChatPane.tsx`: full-modal loading overlay, separate in-memory draft state, final two-action view, stale/error handling.
- Copy `hp-mode.gif` into a renderer asset location and import it as a bundled local asset; runtime code must not depend on the user's absolute Desktop path.

## Verification requirements

- Harness tests: valid complete revision, invalid/oversized output, no tool access, full source plan reaches the revision stage, timeouts/failures yield no draft, and source remains unchanged.
- Plan-store tests: promotion is coherent/atomic, recalculates the plan hash, resets build status/evidence appropriately, and leaves the original intact on failure.
- IPC/build tests: reject wrong-session/workspace/stale fingerprints; acceptance promotes before build; choosing original performs no promotion and starts the original plan; duplicate actions cannot start duplicate builds.
- Renderer tests: loading hides all other modal content and displays only the GIF and `ThinkingStates`; ready state shows only revised content and two choices; each choice dispatches the correct action; errors allow retry or original-plan build without displaying unsafe exception details.
- Run the HyperPlan/plan-store/IPC/renderer tests, desktop typecheck, and formatter/linter before completion.

## Non-goals

- Persisting a revision history or implementing rollback between accepted revisions.
- Displaying critics, synthesis details, or the original plan in the successful final state.
- Automatically building after a failed or incomplete review.
- Starting a second model review after the user makes a choice.
