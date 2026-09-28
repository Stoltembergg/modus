# Modus Adaptive Harness Core — Architecture Design

**Status:** Approved architecture; Phase 1 implementation plan pending user approval.

## Goal

Add a local, evidence-first adaptive control plane that improves action selection, verification,
recovery, and context gathering by extending the current Modus harness. It must not replace
`PiSdkRuntime`, `ToolRegistry`, the permission broker, Plan/Spec/TODO state, Context Planner,
CodeGraph/Fast Codebase, Project Intelligence, or Harness Insights.

The primary success measure is **verified completion among tasks with applicable acceptance
criteria**. A completion must never be labeled verified without fresh, scope-matching evidence;
simple tasks remain `not_required` rather than receiving artificial test requirements.

## Current architecture and integration points

- `apps/desktop/src/main/agent/pi-sdk-runtime.ts` owns the run lifecycle, existing Intent Gate,
  Auto QA, Todo continuation, plan/runtime wiring, and terminal run outcomes. Queued input joins an
  existing run; it is not a new task episode. The automatic continuation budget is already bounded
  to one attempt per run.
- `apps/desktop/src/main/agent/pi-permission-extension.ts` and
  `apps/desktop/src/main/agent/tools/registry.ts` own permission classification and the existing
  approval path. The adaptive core is never an alternate tool executor or authorization authority.
- `apps/desktop/src/main/agent/harness/task-classifier.ts`, `intent-gate.ts`,
  `todo-continuation.ts`, and `qa-evidence.ts` provide typed deterministic inputs and policy seams.
  HyperPlan is already a bounded optional critic/synthesis flow; Spec Mode already links requirements,
  criteria, TODOs, and evidence.
- `apps/desktop/src/main/agent/agent-event-store.ts`, `agent-run-store.ts`, and `agent-store.ts`
  persist run/event/session identity and parent/worktree provenance. Existing events include structured
  routes, tool outcomes, QA, continuation, checkpoints, context usage, and child outcomes.
- `apps/desktop/src/main/fast-codebase/fast-codebase-service.ts` and
  `apps/desktop/src/main/agent/tools/fast-codebase-tools.ts` expose typed local CodeGraph hits and
  explicit-call discovery references. Git, checkpoint, and rollback services provide authoritative
  revision/change boundaries.
- `apps/desktop/src/main/context/context-planner.ts` ranks bounded context candidates; Docs provides
  explicit indexed search/chunk retrieval; Project Intelligence supplies bounded active verified
  memory. Harness Insights is an on-demand, local, workspace-scoped hypothesis report.

## Approved design decisions

- **Control authority:** bounded safe orchestration. The controller may sequence safe local retrieval,
  planning, read-only specialist delegation, verification, and bounded replanning. It cannot bypass
  the permission broker, Intent Gate, Build consent, or destructive-action confirmation. It may select
  only from the currently available model catalog; it cannot change providers, credentials, or user
  configuration.
- **Preflight:** for high uncertainty/risk, a visible preflight may query only local, already-available
  project state, CodeGraph indexes, plans, verified memory, and indexed docs before the first model call.
  It does not call external MCP, start subagents, write files, or trigger CodeGraph indexing/sync.
- **Failure Intelligence scope:** run/task and owning session only, stored as bounded structured events
  and evidence references in the existing event store. It does not copy raw prompts, model output,
  shell commands, or error bodies. Cross-session recurrence may be surfaced as a Harness Insights
  suggestion, not as an automatic block or promoted memory.
- **Delivery sequence:** (1) Verifier-First live task state; (2) Failure Intelligence plus a
  revision-scoped Project Model; (3) uncertainty-reducing Context Engine plus Meta Controller; (4)
  adaptive Execution Policy plus Harness Learning. Each subproject receives its own spec, plan,
  implementation, and gate.
- **Learning:** proposals only. Promoting a skill, strategy, routing rule, or setting requires explicit
  user approval, a versioned change, regression validation, and a rollback path.
- **Isolation:** PR #34 has merged. This design is in the separate `omos/adaptive-harness-core`
  worktree based on `origin/main`; its code has not been modified yet.

## Architectural approach and rejected alternatives

### Recommended: pure policy over typed, bounded state

Introduce a testable deterministic policy function over an immutable snapshot of existing and newly
structured state. It returns an action proposal with reason codes, confidence, and a bounded budget.
An adapter in the existing runtime maps an allowed proposal to existing Context Planner, Plan/Spec,
`task`/`wait`, Auto QA, or Oracle flows. The runtime and permission broker remain authoritative for
execution and settlement.

This keeps decision logic separate from `PiSdkRuntime` lifecycle code, reuses existing sources of
truth, supports replayable tests, and gives failures a clear stop/replan boundary.

### Rejected: inline all policy in `PiSdkRuntime`

This is the smallest initial diff, but couples retrieval, task state, failure handling, and policy to a
large run-lifecycle module. Decisions become difficult to replay, compare, or roll back.

### Deferred: persistent autonomous controller plus a new project graph

This creates parallel sources of truth, more model calls and indexing, and the possibility that
unverified hypotheses reinforce later policy decisions. It is not justified before a bounded policy
shows measurable value.

## Components and contracts

### 1. Verifier-First Task State

Build a run-scoped projection over the existing `PlanSpec`, TODO state, `AgentRunInfo`, and typed
`AgentEvent` evidence. The projection links:

- the owning `runId`, `sessionId`, and existing user-message/plan references;
- goals and constraints by existing message/criterion references, not copied prompt text;
- open questions and bounded hypothesis/recovery identifiers;
- criterion and TODO IDs, current action/stage, changed-scope revision, and evidence references;
- verification state: `not_required`, `pending`, `verified`, `user_confirmed`, `failed`, `unknown`, or
  `blocked`.

The task projection is not another TODO or plan store. Rehydrate it from the existing Plan/TODO/run
authorities plus appended structured state events. Do not serialize full transcripts or tool payloads.

Evidence rules:

- Verification obligations derive from the existing task classifier and explicit acceptance: moderate/
  complex or medium/high-risk work, and any task with user-stated acceptance criteria, gets observable
  criteria/checks before the controller treats completion as verified. For non-testable outcomes, use
  an explicitly user-confirmed or `unknown` state rather than inventing a passing check.
- `verified` requires main-authored check/outcome evidence from the owning current run, after the latest
  relevant change, covering the criterion's required scope. Model-authored claims alone are not evidence.
- New relevant changes invalidate older verification. Cross-run, cross-session, cross-workspace, stale,
  malformed, blocked, aborted, or skipped evidence cannot false-pass.
- No applicable criteria on a simple task yields `not_required`; missing required evidence yields
  `unknown`/`missing`/`blocked`, never success.
- Existing Auto QA and its single continuation limit remain authoritative; this design does not add an
  unbounded retry loop.

### 2. Failure Intelligence

Append bounded structured attempt records to the current task/session event history: action/strategy
signature, hypothesis or cause code, status (`tested`, `failed`, `discarded`, `supported`, `unknown`),
reason code, source evidence references, and the project revision/scope at which it was tested.

When the same strategy signature fails against unchanged evidence/revision, the policy marks it as a
duplicate and chooses a different action, reformulation, Oracle advice, or a user question. A strategy
is discouraged, not permanently blacklisted: changed evidence or project revision allows reevaluation.
Failure claims remain distinct from evidence-backed verdicts and are deleted with their owning session
under existing retention. No raw prompt, output, command, secret, or arbitrary error text is stored in
the ledger.

### 3. Revision-scoped Project Model

Create an on-demand ephemeral view keyed by workspace and repository revision. It combines only typed
sources: CodeGraph file/symbol references, Git changed paths/revisions, checkpoint impact, observed
test/check scope, Plan acceptance references, and verified Project Intelligence.

Represent relationships only when a typed source establishes them. Estimate dependency impact and
blast radius with provenance, freshness, and confidence; if edges or ownership are absent, label impact
`unknown` and prefer retrieval/verification rather than inferring certainty from prose. Keep any raw
path identifiers internal for matching; insight/claim output uses bounded event/run references and does
not interpolate filenames. Do not create a second graph database or automatically index/sync CodeGraph.

### 4. Uncertainty-reducing Context Engine

Extend Context Planner candidate scoring from semantic similarity alone to a bounded score using:

- which task criteria/open questions are unresolved;
- expected uncertainty reduction and direct relevance to those unknowns;
- source trust, workspace scope, evidence freshness/revision, and known limitations;
- token/time cost and the current execution budget.

Prefer current-run evidence and verified local sources; retrieve only the smallest candidate set that
can reduce a named uncertainty. Retrieved content remains untrusted data, never instructions, and is
not injected into system/developer policy. Preflight follows the visible local-only boundary above.
External research uses only user-configured exact-name read-only MCP tools after the first model call,
through the existing MCP citation and permission constraints.

### 5. Meta Controller

Expose a pure function conceptually equivalent to:

```ts
decideNext(snapshot: AdaptiveDecisionSnapshot): AdaptiveDecision
```

The snapshot includes Task State, Failure Intelligence, the current Project Model revision, evidence
freshness/scope, risk/complexity/uncertainty, existing user settings, and remaining budgets. A decision
contains one next action, stable reason codes, expected uncertainty reduction, applicable verification
requirements, and the budget consumed. It does not contain executable tool code or permission overrides.

Action classes are: bounded local retrieval, plan/HyperPlan suggestion, allowed read-only delegation,
verification, Oracle advice for high risk/uncertainty, replan/reformulate, ask user, finish, or existing
runtime execution. The controller is called at explicit lifecycle boundaries (after Intent Gate before
the approved local preflight, and after typed evidence/outcomes); progress is visible. It invokes existing
runtime adapters, and all tools still pass through `ToolRegistry` and the permission broker.

Rollout starts in shadow mode, recording local reason-coded decisions without dispatching new actions.
After phase acceptance tests and user-visible confirmation of the safe policy, it can orchestrate the
approved safe actions. It preserves the current one-continuation and six-active-child caps and never
loops until success.

### 6. Adaptive Execution Policy

Use deterministic, versioned policy rules initially—not a learned model that mutates itself. Inputs are
task complexity/risk, uncertainty, Project Model confidence/impact, failure signatures, configured
model availability, remaining cost/time/parallel budgets, and previous comparable outcomes.

It may select an exact model ID from the enabled catalog, an existing specialist role with its current
read-only/worktree restrictions, whether HyperPlan is justified, safe action parallelism within the
existing cap, and the verification level. It may not add providers, change credentials, widen a profile's
capabilities, relax permissions, or increase retry/parallelism limits without a separately approved
versioned policy change.

### 7. Harness Learning

Analyze completed local sessions on demand from bounded structured events. Use the current
`MIN_COMPARABLE_EPISODES` floor for hypothesis surfacing; do not claim causality from sample count or
from one successful run. A candidate change includes its evidence references, comparison window,
sample/confidence/limitations, expected benefit, regression scenarios, and rollback plan.

Before promotion, replay the proposal against fixed regression cases and shadowed comparable episodes.
Promotion remains an explicit user-approved, versioned change with a regression check and rollback path.
The learner cannot write skills, prompts, routing, models, permissions, or settings on its own.

## Decision flow

1. A new run begins through existing run ownership and Intent Gate checks. The existing user prompt or
   PlanSpec remains the goal source; Task State stores references rather than a duplicate prompt.
2. For eligible high-uncertainty/high-risk tasks, the policy may do visible, bounded local preflight
   retrieval from existing Project Model/CodeGraph, Git/checkpoint, verified memory, plan, and indexed
   docs. It cannot use external MCP, launch children, index/sync, or write before the model call.
3. The parent model proceeds with normal tool permissions. After each typed outcome, update task state,
   evidence status, project revision, and failure signatures; invoke the pure policy to choose the next
   safe action or stop/ask.
4. Verification is evaluated against the current changed scope. Failure or stale evidence cannot mark
   the task verified. Repeated failed strategy signatures cause a switch/reformulation or user support;
   existing continuation limits still apply.
5. On completion, structured outcomes remain in the existing local event/run stores. Harness Learning
   is a separate on-demand proposal flow, not a runtime mutation step.

## Phased subprojects and acceptance boundaries

1. **Verifier-First Task State** — run-scoped projection, current-run/current-scope evidence, rehydrate
   from existing run/Plan/TODO stores. Tests cover stale evidence after edits, cross-run/workspace
   references, blocked/aborted/restarted settlement, and simple `not_required` tasks with no extra model
   or test workflow. This is the prerequisite for any controller decision that depends on completion.
2. **Failure Intelligence + Project Model** — bounded attempt signatures, tested/discarded hypotheses,
   revision-scoped typed impact, and explicit unknown state. Tests prove duplicate failed strategies are
   not repeated on unchanged state, may be reconsidered after a revision change, and never become
   verified facts without evidence.
3. **Context Engine + Meta Controller** — expected uncertainty reduction ranking, safe local preflight,
   shadow policy, and bounded safe action mapping to existing runtime adapters. Tests cover decision
   reasons/budgets, no hidden/external preflight, no permission bypass, timeouts/unavailable sources,
   and a low-risk typo that triggers no unnecessary search, delegation, or HyperPlan.
4. **Execution Policy + Harness Learning** — catalog-only model choice, existing capability/parallel
   caps, complexity/risk-based verification, comparable-session proposal analysis, regression validation,
   explicit approval, versioning, and rollback. Tests prove no automatic skill/rule/config mutation and no
   proposal promotion without fresh evidence and user approval.

Each subproject gets a separate reviewed spec and TDD plan before implementation, plus a read-only
architecture/security gate at its completion. Do not implement later subprojects until their dependency
and acceptance gate passes.

## Security, privacy, reliability, and non-goals

- No raw prompt, tool output, shell command, credential, or transcript is copied into new Task State,
  Failure Intelligence, Project Model claims, or learning proposals. Existing user messages are
  referenced by their current IDs only.
- Enforce workspace/session/run ownership in main-process store queries and reducers. Chats/Inbox is
  excluded. Reject malformed/stale evidence and expose `unknown`, not a guessed success or impact.
- Existing retrieved Web/MCP/code-map data remains untrusted and cannot update system/developer policy
  or permissions. Read-only external access is configured and explicit.
- No new P2P agent framework, background telemetry, second durable TODO/spec/graph database,
  self-modifying harness, new model provider/credential, or unbounded autonomous loop.
- Keep simple tasks lightweight. Add retrieval, delegation, HyperPlan, or tests only when risk,
  uncertainty, explicit acceptance, or prior verified outcomes justify them.

## Measures and rollout gates

- **Primary:** verified completion rate for tasks with applicable criteria; `false_verified` must remain
  zero in regression scenarios. Exclude `not_required`, and report `unknown`/`blocked` separately.
- **Secondary:** repeated equivalent failed strategies per task, time/token cost to acquire relevant
  evidence, unresolved-criterion rate, and recovery success after failure/rollback.
- Start all new controller decisions in local shadow mode. Do not activate safe automatic sequencing
  until deterministic boundary tests pass, per-phase gate review passes, and the user has reviewed the
  resulting spec/plan. Existing permissions and build consent remain in effect after activation.
