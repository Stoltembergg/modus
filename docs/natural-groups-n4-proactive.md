# N4 — Proactive wake and interrupt policy

- **Repository:** Stoltembergg/modus
- **Depends on:** N0–N3, N5 on `main`
- **Historical status:** merged as PR #97 (`deaf687`)

## Historical N4 behavior

The merged N4 change described these rules at the time:

1. After a silent turn with no `@` mention and no loop-closing status, resume one owner of an open or `in_progress` task with `Resume: "…" — continue your owned work`.
2. After `Agreed` or `Proposed`, wake the reviewer on the speaker’s `in_progress` task with `Review ready: "…" — please review`.
3. `Ready for you`, `Blocked · …`, and blocked turn outcomes do not proactively wake peers.

Lead routing for unowned open tasks (P1b) was unchanged. The historical tests named silence with an owned task, `Agreed` with a reviewer, and `Ready for you` without a peer wake.

These statements record the N4 change that was merged. They are not the current wake contract: the later approved task and evidence design supersedes automatic wakes based on silence or those status words. In particular, silence, `Agreed`/`Proposed` text, and public agent messages do not independently wake a peer today.

## Current behavior

The Group Runtime now bases proactive work on persisted, typed task events. It recognizes `task_assigned`, `task_unblocked`, `review_requested`, `review_changes_requested`, and `task_qa_updated`; it checks the current task version, dependencies, evidence/review state, member availability, execution state, Stop, and the existing chain budgets before deciding an action.

The per-group default is `suggest`. The Activity panel shows the reason, task, origin event, and eligible targets; a user must accept or discard a suggestion. Accepting rechecks current state and sends one runtime dispatch. Setting a group to `opt_in_auto` allows only eligible owner or reviewer wakes from typed task events. Both modes continue to use the durable Group Runtime queue, idempotency, budgets, Stop, and recovery rules.

Explicit delegation through tools such as `group_assign_task`, `group_request_review`, or `group_handoff` remains an explicit request and can wake its recipient in either mode. This is separate from a proactive wake chosen by the task policy. A mention or public message by itself is not delegation.

For task fields, verified QA, capabilities, routing, suggestions, and confirmed branch integration, see the [current Group task and proactivity guide](group-task-proactivity.md), the [approved specification](superpowers/specs/2026-10-02-group-proactivity-task-evidence-design.md), and the [implementation plan](superpowers/plans/2026-10-02-group-proactivity-task-evidence.md).
