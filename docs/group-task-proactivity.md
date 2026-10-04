# Group tasks, verification, and proactivity

This guide describes the current Group task and proactivity contracts. It links to the [approved design specification](superpowers/specs/2026-10-02-group-proactivity-task-evidence-design.md) and [implementation plan](superpowers/plans/2026-10-02-group-proactivity-task-evidence.md). For the history and superseded claims in N4, see [natural-groups-n4-proactive.md](natural-groups-n4-proactive.md).

## Tasks and transitions

A `GroupTask` has a title, optional description, status, owner, reviewer, kind, priority, stage, blocker, dependency IDs, acceptance criteria, verification policy, evidence references, review decision, and state/criteria versions. The current statuses are `open`, `in_progress`, `blocked`, `in_review`, `done`, and `cancelled`. Stages are `plan`, `implement`, `verify`, `review`, and `deliver`.

`group_create_task` creates an open, unowned task. A typed `draft` supplies `kind`, `priority`, `dependencyIds`, `criteria`, and `verificationPolicy`; the top-level `reviewer` can name a member by title or session ID. `group_claim_task` lets a member take an unowned open task. In coordinator mode, the Lead can use `group_assign_task`; `group_handoff` can assign an existing task or atomically create and assign a title-only task. A title-only handoff uses the legacy task defaults. To create a verified task and assign it, create a typed draft first, then claim or explicitly assign it.

The owner can use `group_report_progress` to set a stage or block an active task with a reason. Passing `blockedReason: null` clears an existing block. `group_request_review` moves an owned `in_progress` task to `in_review` and explicitly wakes the named reviewer. `group_review_task` records `approve` or `changes`; changes return the task to `in_progress`. Approval completes the task only when its current completion gate passes. `group_agree` can complete a task only when the same gate passes; otherwise it records the agreement and leaves the task active. Cancellation is a user action. These tools do not let an agent skip a gate by changing status text.

Use `group_get_work_state` or `group_list_tasks` to read authoritative task state and versions before making a versioned change. `group_get_work_state` includes bounded task and gate summaries, dependency state, member availability, and current execution budgets; omitted items are reported. Reuse a stable `operationId` on retries. `group_report_progress` requires the current `expectedVersion` and a stable `operationId`.

## Criteria, QA evidence, and review freshness

Each criterion has a stable `id`, a description, and `requiredCheckKinds`, whose supported values are `tests`, `typecheck`, `lint`, and `build`. A required verification policy must have at least one criterion. A criterion with no QA check must be covered by a required current review.

Group verification consumes QA already persisted by the individual harness. The Group records identity references to the exact task-bound run and its `harness.qa` event, including typed check names and a source fingerprint; it does not copy raw logs or transcripts. Every required check for a criterion must have `passed` evidence in the same exact QA event. `failed`, `skipped`, `missing`, `unavailable`, and `user_confirmed` are not automatic QA passes. An unrelated individual run is not task evidence.

Evidence is current only while the task criteria version, exact run/event binding, active task assignment, and source fingerprint still match. Editing the task's source makes previous QA and review stale. A review approval is bound to the assigned reviewer, current criteria version, source fingerprint, review event, and approved criterion IDs. When `requireReview` is true, the reviewer must approve every criterion before completion. Dependencies must be tasks in the same Group, cannot form cycles, and must be `done` before the dependent task can pass its gate.

## Legacy-safe defaults

Existing tasks are migrated without reopening or waking them and without retroactive verification requirements. They retain the legacy completion path and project defaults equivalent to `kind: "legacy"`, `priority: "normal"`, no criteria or dependencies, and `verificationPolicy: { mode: "none", requireReview: false }`. New title-only tasks use the same no-gate policy. A structured task opts into required verification in its draft; review is required only when `requireReview` is true. Group task verification reads the individual harness's persisted QA; it does not write into the individual's Task State or QA state.

## Capabilities and typed routing

Members can declare `capabilityIds` (`plan`, `implement`, `verify`, `review`, `research`, `docs`) and `supportedTaskKinds` (`legacy`, `code`, `docs`, `design`, `review`, `research`, `question`). These fields describe intended work. They do not grant a tool, permission, or access. Missing legacy metadata remains empty rather than being inferred from a role label, title, or free-form description.

For typed tasks, routing checks the task kind and stage against declared capabilities, member availability and load, and active tools resolved by the ToolRegistry. Explicitly requested members are considered first but still must be available and compatible. If there is no reliable match, the router can suggest an eligible Lead with a reason; if none is eligible, it asks the user. Actual tool use continues through ToolRegistry and the existing permission checks.

The supervised flow is derived from persisted task kind, stage, criteria, dependencies, verification policy, owner, and reviewer. The current typed flow applies to `code`, `docs`, `design`, and `review` tasks. It describes the ready stage and skips stages the task does not require; it does not launch future stages early or classify free-text requests with keyword regexes.

## Suggestions, opt-in wakes, Stop, and recovery

Each Group defaults to `suggest`, including migrated Groups. In this mode, a typed task event can create a visible suggestion in Activity, but a user must accept or discard it before a policy-generated wake is dispatched. The suggestion carries its task, reason, source event, and candidate targets. Acceptance checks the current task and target again and dispatches once through the Group Runtime. If the originating execution has ended, the UI marks that acceptance as requiring a new execution.

`opt_in_auto` is an explicit per-Group setting. It permits limited automatic owner/reviewer wakes only from persisted task events: assignment and unblock can wake the owner; a review request can wake the reviewer; requested changes can wake the owner; a QA update can wake the owner, or the reviewer when the task is in review, required QA is ready, and review is required. Dependencies, task and evidence freshness, reviewer/owner assignment, availability, active execution, Stop, and budgets still apply. Ineligible work becomes a suggestion or is discarded when stale. Duplicate source events do not dispatch twice.

Both modes use the Group Runtime's existing durable queue, idempotency, chain budgets, Stop, and recovery. Stop and waiting for the user fence policy-generated work. Explicit tool delegation remains explicit: `group_assign_task`, `group_request_review`, and `group_handoff` may wake their requested recipient in either mode, subject to existing runtime rules. Silence, `Agreed`/`Proposed` text, and public messages are not automatic task triggers. See the [N4 history](natural-groups-n4-proactive.md) for the superseded description.

## Branch preview and confirmed integration

After a task is `done` and its gate is still current, the Group Activity task panel can request an integration preview for the task owner's registered Group worktree. The preview lists source and target branches, commits, changed files, and a diff summary. The service requires a clean source and target and rechecks task, source, and target revisions before applying. A changed preview input requires a fresh preview and confirmation.

Applying requires the user to confirm the displayed preview. The service then requests the existing `git.write` permission and checks the preview again after that permission wait. It reuses the Git service's `git merge --no-commit --no-ff` operation: changes are applied to the target as a pending no-commit merge, without creating a merge commit or pushing. The user completes the merge in Git or aborts it; another integration cannot start while a merge is pending.

If Git reports conflicts, the UI lists the conflict files and the task becomes blocked. The user can resolve the conflict in Git or use the integration dialog's Abort action, which requests a fresh `git.write` decision. After abort, the task returns to `done` only when the service verifies that its evidence is still current; otherwise it remains blocked for re-verification. A preview with no changes does not offer an apply action.

## Tool argument examples

These examples show arguments accepted by the current Group tool schemas. Replace reviewer names and task IDs with current Group members and values returned by `group_get_work_state` or `group_list_tasks`. Keep the same `operationId` when retrying an operation.

Português — criar uma tarefa de código com QA obrigatório e revisor atribuído:

```json
{
  "operationId": "task:validar-relatorio:create:v1",
  "reviewer": "Revisor QA",
  "draft": {
    "title": "Validar os campos do relatório",
    "description": "Validar a entrada antes de gerar o relatório.",
    "kind": "code",
    "priority": "normal",
    "dependencyIds": [],
    "criteria": [
      {
        "id": "validacao-relatorio",
        "description": "A validação passa nos testes e na verificação de tipos.",
        "requiredCheckKinds": ["tests", "typecheck"]
      }
    ],
    "verificationPolicy": { "mode": "required", "requireReview": true }
  }
}
```

Use the object above as the arguments to `group_create_task`. It creates an open, unowned task with `Revisor QA` as reviewer; it does not start an owner run.

English — report the verification stage for an existing task using its current version:

```json
{
  "taskId": "task-a17",
  "expectedVersion": 4,
  "stage": "verify",
  "operationId": "task-a17:verify:v4"
}
```

Use this object as the arguments to `group_report_progress`. The tool records progress; it does not complete the task. `taskId` and `expectedVersion` must refer to the current Group task.
