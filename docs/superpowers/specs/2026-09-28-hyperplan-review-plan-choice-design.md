# HyperPlan Review: Failure Reporting and Plan Choice

## Problem

The current review path is `ReviewPlanCard` → `ChatPane.reviewPlanWithHyperPlan` → preload `agent:review-plan-hyperplan` → trusted IPC handler → `runHyperPlanReview`. The harness runs four read-only critics in isolated sessions and then synthesizes their output. Failures from session creation, model prompts, timeouts, cleanup, and invalid JSON are collapsed to `undefined` / `unavailable`. When every critic fails, the service returns a normal `HyperPlanSummary` with a generic “no critics completed” question, so the renderer labels the operation completed and cannot show the actual failure. IPC rejections are separately reduced to a status without their cause. The result contains feedback, not a revised plan.

## Goals

- Preserve the current `PlanRef` unchanged while HyperPlan runs and until the user chooses an action.
- On **Review with HyperPlan**, synchronously enter a visible `reviewing` state, block duplicate invocations, and show `docs/media/hp-mode.gif`.
- Return a validated revised plan alongside the critic feedback. Show it after a successful review without persisting it automatically.
- Persist the revised plan only after **Usar plano revisado**. **Manter plano anterior** restores the original view and leaves stored plan data untouched.
- On review failure, keep/show the original plan and display a short, actionable error that preserves the actual failure category/cause.
- Keep the existing renderer → preload → IPC → harness architecture; do not add a new service layer or generic fallback.
- Limit validation to the affected service/IPC/UI paths and the project typecheck; do not add a broad test suite.

## Design

### Service and IPC

Keep `runHyperPlanReview` as the existing harness entry point. Retain the original bounded inputs and parallel critic execution. Each critic must retain a failure reason (including timeout, session/model failure, invalid response, or cleanup failure) rather than swallowing it. A review with no valid critic output or no validated revised plan must reject with a bounded, user-actionable error; it must not return a normal all-unavailable result. Partial critics remain explicitly marked unavailable and synthesis may use only completed critics. The synthesis input includes the original plan and structured Spec as well as completed critiques, and its strict output schema includes a complete revised plan (`title`, `overview`, ordered `todos`, and Markdown `content`). Validate the revised plan before returning it; never infer approval from missing critics.

Keep `agent:review-plan-hyperplan` as the review call and extend its typed result to carry the candidate plan. Reuse the existing trusted IPC handler and `plan-store` ownership data. Add a narrowly scoped accepted-revision operation to the existing agent IPC surface: validate trusted sender, session/plan/workspace ownership, and the candidate fields, then persist through `writePlan` only when the renderer submits the explicit **Usar plano revisado** action. Preserve the original Spec when writing the chosen revision. The **Manter plano anterior** path makes no write call. IPC/service exceptions remain rejections with their meaningful cause; the renderer formats them for display instead of converting them to successful “unavailable” summaries.

### Renderer state and interaction

Use one `ChatPane` review-state union (`reviewing`, `completed`, `error`, or absent) keyed by plan id/hash, plus a synchronous in-flight ref so rapid/repeated clicks cannot invoke IPC more than once. Capture the original `PlanRef` before the call and keep the returned revised candidate separate. While `reviewing`, disable the action and render the requested GIF with an accessible status label. On completion, stop the GIF and present the revised plan with the two explicit choices. Accepting calls the existing IPC boundary to persist, updates the parent plan via `onPlanUpdated`, and then displays the selected plan. Keeping the previous plan discards the candidate and restores the captured original. Any failure restores the original display and exposes a short useful error; no plan store write occurs.

Copy `hp-mode.gif` from the user-provided local source `C:\Users\Gabriel\Desktop\Modus\modus\docs\media\hp-mode.gif` into the repository path `docs/media/hp-mode.gif`, then reference that asset using the renderer's existing Vite asset handling.

### Verification

Run focused checks for: (1) all critics failing causes an actionable rejected review rather than a successful generic summary; (2) IPC returns the revised plan and only persists a validated user-selected candidate for the owning session; (3) duplicate clicks issue one request, the GIF/review state stops on completion, **Keep previous** does not persist, and rejection restores the original with an error; and (4) desktop typecheck. Use existing test patterns and add only cases needed to establish these transitions.

## Non-goals

- Automatically build after review or treat critique output as approval.
- Persist review state across app restarts.
- Change the four-critic topology, provider/model selection policy, or unrelated plan/build lifecycle.
- Add a generic error fallback, silent catch, visual-only workaround, new architecture layer, or extensive test matrix.
