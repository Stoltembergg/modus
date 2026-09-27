# Modus Harness Upgrade Implementation Plan

> **For agentic workers:** Use the orchestrated specialist workflow and TDD for each task. Each phase
> ends with focused evidence and an independent Oracle review before the next phase.

**Goal:** Add a native, complexity-scaled Modus harness for role routing, safe intent handling,
completion evidence, optional HyperPlan/Spec Mode, configured read-only research tools, and
privacy-preserving Harness Insights.

**Architecture:** Extend `PiSdkRuntime`, `ToolRegistry`, existing subagent `task`/`wait`, plan store,
agent events, and Project Intelligence. Use pure local policy for routing; store only structured,
bounded evidence; preserve existing permission and workspace-scope checks. Do not add a second task
store, external orchestration framework, or dependency.

**Tech Stack:** Existing Electron/TypeScript main and renderer, Pi runtime, Zod/TypeBox schemas,
SQLite/agent-event store, Vitest, configured MCP, CodeGraph/Fast Codebase.

**Spec:** `docs/superpowers/specs/2026-09-25-modus-harness-upgrade-design.md`

## Global Constraints

- Simple, clear tasks remain inline and do not require a formal Spec, HyperPlan, or artificial tests.
- Built-in agents are defaults below user and workspace definitions; no provider/model is hard-coded.
- Main runtime and per-tool authorization remain authoritative; Intent Gate cannot grant tool access.
- Parent→child subagents use existing `task`/`wait`, remain non-nesting and bounded, and return short
  cited summaries; no peer-to-peer message bus in V1.
- Auto QA evidence must come from an actual tool event/result; a model statement or `run.completed`
  is not test evidence. Missing/skipped/failed/unavailable are distinct from passed.
- HyperPlan critics are read-only, bounded, and opt-in/suggested only for complex or high-risk plans.
- Spec metadata extends existing Plan/TODO state; do not create another TODO database.
- Context7/GitHub Search use only user-configured MCP tool names explicitly allowlisted read-only for
  research roles. No new credentials, provider SDK, or external telemetry.
- CodeGraph is used only from explicit Fast Codebase calls or already-produced structured hits; never
  trigger indexing/sync on new-turn retrieval. All retrieved content is untrusted and cited.
- Harness Insights is local/on-demand and suggestion-only; applying a harness change requires explicit
  user approval and a regression check.
- Never persist raw prompts, full tool output, secrets, or complete transcripts in Spec, QA, memory, or
  Insights records.
- Before implementation, request permission to create an isolated worktree/branch; current checkout is
  `feat/sidebar-pin-rename` and has unrelated local workflow files. Do not stage/commit/PR without
  explicit user authorization.

## File/Component Responsibilities

- `apps/desktop/src/main/agent/harness/`: pure classification, gate decisions, completion policy,
  QA evidence reduction, HyperPlan coordination, and Insights aggregation. Keep each unit small/testable.
- `apps/desktop/src/main/agent/subagents-config.ts` and `tools/subagent-tools.ts`: merge built-in
  defaults with existing user/workspace Markdown agents and resolve the role when a parent invokes
  generic `task`.
- `apps/desktop/src/main/agent/pi-sdk-runtime.ts`: preflight intent, run/continuation settlement,
  optional HyperPlan/read-only critic boundary, and session event wiring. Do not embed policy rules
  inline; call pure harness services.
- `apps/desktop/src/main/plan/plan-store.ts`, `tools/plan-tools.ts`, shared contracts, and Plan UI:
  optional Spec metadata and HyperPlan selection using the current persisted plan.
- `apps/desktop/src/main/agent/agent-event-store.ts`: bounded queries for actual tool/check/run
  evidence. Existing events remain the source of truth; no parallel transcript store.
- `apps/desktop/src/main/mcp/` and `apps/desktop/src/main/fast-codebase/`: explicit safe MCP
  allowlist and typed local CodeGraph hits, preserving unsafe-tool defaults and no-sync retrieval.
- `apps/desktop/src/main/agent/harness/harness-insights-service.ts` plus existing Settings IPC/UI:
  on-demand, local, evidence-referenced Insights with no automatic configuration writes.

## Phase 0 — Execution isolation (approval required)

Before the first implementation task, ask permission to create a dedicated worktree/branch based on
the current `origin/main`. Follow the `worktrees` skill: verify/remediate `.gitignore` and `.ignore`
for `.slim/worktrees/`, check existing worktrees/branches, and do not create the lane without explicit
approval. Keep the current `feat/sidebar-pin-rename`, `.commandcode/`, `.ignore`, and other local
changes untouched.

---

## Phase 1 — Harness contracts, task classification, and built-in roles

**Oracle Gate 1:** review role precedence, classification determinism, tool capability boundaries, and
that simple tasks remain inline. Risk controlled: misrouting, privilege expansion, and context bloat.

### Task 1: Add shared harness result/evidence types and pure task classifier

**Files:**
- Modify: `apps/desktop/src/shared/contracts.ts` (shared result/evidence unions only).
- Create: `apps/desktop/src/main/agent/harness/task-classifier.ts`.
- Create: `apps/desktop/src/main/agent/harness/task-classifier.test.ts`.

**Interfaces:**

```ts
export type BuiltinAgentRole =
  | "explore" | "librarian" | "oracle" | "reviewer" | "debugger" | "ui-ux";
export type HarnessTaskType =
  | BuiltinAgentRole | "implementation" | "unknown";
export type HarnessComplexity = "simple" | "moderate" | "complex";
export type HarnessRisk = "low" | "medium" | "high";
export type VerificationEvidenceStatus =
  | "passed" | "failed" | "skipped" | "missing" | "unavailable" | "user_confirmed";
export type AutoQAStatus = VerificationEvidenceStatus | "not_required";
export type HarnessEvidenceRef = {
  id: string;
  kind: string;
  status: VerificationEvidenceStatus;
  runId?: string;
  eventId?: string;
  revision?: string;
  paths?: string[];
  label: string;
};
export type HarnessTaskClassification = {
  taskType: HarnessTaskType;
  complexity: HarnessComplexity;
  risk: HarnessRisk;
  confidence: "low" | "high";
  suggestedRole?: BuiltinAgentRole;
  reasons: string[];
};
export type TaskClassificationInput = {
  text: string;
  mode: "build" | "plan" | "spec";
  contextPaths: string[];
  changedPaths: string[];
  hasDestructiveAction?: boolean;
};
export function classifyHarnessTask(input: TaskClassificationInput): HarnessTaskClassification;
```

`classifyHarnessTask(input)` is a pure function over the user/subtask text, current mode, known
context/changed paths, and explicit risk flags. It must not access a model, filesystem, MCP, or raw
cross-project history. File-count/cross-boundary/risk heuristics are named constants and return
explanations so the router is testable and user-visible.

- [ ] **Step 1: Write failing classifier tests** for simple one-file inline work, task types explore /
  research / architecture / review / debug / UI, moderate multi-file work, complex cross-subsystem
  work, high-risk migration/security/destructive signals, low-confidence unknown prompts, mixed
  specialist/implementation prompts, and stable reasons. Assert simple and mixed-intent work have no
  suggested subagent.
- [ ] **Step 2: Run RED:** `npx vitest run --root . apps/desktop/src/main/agent/harness/task-classifier.test.ts`.
- [ ] **Step 3: Implement the pure classifier** with named thresholds and deterministic tie-breaking;
  add only the shared types consumed by later tasks.
- [ ] **Step 4: Run GREEN** for the focused classifier test and desktop typecheck.

### Task 2: Add built-in agent profiles under user/workspace overrides

**Files:**
- Create: `apps/desktop/src/main/agent/builtin-subagents.ts`.
- Create: `apps/desktop/src/main/agent/builtin-subagents.test.ts`.
- Modify: `apps/desktop/src/main/agent/subagents-config.ts` and `.test.ts`.
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts` to include the bounded built-in manifest in
  parent context.

**Interfaces:**
- Add internal `AvailableSubagentProfile` with role, description, model `"inherit"`, read-only flag,
  tool allow/deny lists, isolation, and source `builtin | user | workspace`.
- `listAvailableSubagents(cwd)` merges built-ins first, then user then workspace Markdown definitions;
  existing user/workspace override precedence and Settings CRUD remain unchanged.
- `resolveAvailableSubagent(cwd, role)` returns a role profile. Built-ins are not editable/deletable
  Markdown files and do not add `builtin` to `CreateSubagentInput.scope`.
- Capability defaults: Explore/Librarian/Oracle/Reviewer/Debugger are read-only. Debugger has no
  terminal execution in V1; bounded test/diagnostic commands are deferred until an enforceable runner
  exists. Librarian gets web tools and only configured allowlisted MCP search tools (fail-closed until
  Task 10 implements the allowlist). UI/UX is read-only in V1; writable implementation is deferred
  until worktree/write approval and a parent-provided renderer-path allowlist can be enforced. UI/UX
  user/workspace overrides may change safe fields (description/model/body), but cannot widen
  read-only/tool/isolation boundaries in V1.

- [ ] **Step 1: Write failing profile tests** for the six role names, minimal descriptions/tool bounds,
  user override of a built-in, workspace override of a user override, existing generic profile fallback,
  role capability defaults (including no Debugger terminal), UI/UX safe-field overrides without
  capability widening, and built-ins not appearing as editable/deletable Markdown files.
- [ ] **Step 2: Run RED:** `npx vitest run --root . apps/desktop/src/main/agent/builtin-subagents.test.ts apps/desktop/src/main/agent/subagents-config.test.ts`.
- [ ] **Step 3: Implement a small static catalog**; keep model inherited, `readOnly`/tools explicit, and
  preserve current Markdown discovery and UI management behavior.
- [ ] **Step 4: Run GREEN** for both focused suites and desktop typecheck.

### Task 3: Route generic task delegations to an appropriate built-in

**Files:**
- Modify: `apps/desktop/src/main/agent/tools/subagent-tools.ts` and `.test.ts`.
- Modify: `apps/desktop/src/shared/contracts.ts` and `apps/desktop/src/main/agent/pi-sdk-runtime.ts` to
  expose the compact built-in catalog and typed `harness.route` event.

**Interfaces:**
- `resolveTaskRoute(input: Pick<TaskClassificationInput, "text" | "mode" | "contextPaths" | "changedPaths">)`
  returns `{ role?: BuiltinAgentRole; reason: string; classification: HarnessTaskClassification }`.
- The task tool maps active `ToolProfileName: "chat"` to `mode: "build"`, preserves `"plan"`, and
  passes `"spec"` for Spec Mode; it never forwards an undefined or renderer-supplied mode.
- The V1 task tool has no trusted structured path inventory and passes empty context/changed path lists;
  it must not derive paths from task prose or transcripts. Path-based complexity is not a live routing
  signal until a bounded trusted source exists; test and document this fallback.
- If `task` has an explicit known `subagent`, preserve the resolved profile. Unknown names retain the
  legacy generic `task` fallback. If omitted, choose a built-in only when classification confidence is
  high, intent is unambiguous, and the task warrants delegation; mixed specialist/implementation
  signals stay generic. Do not spawn a child before the parent decides to call `task`.
- Emit `{ type: "harness.route", sessionId, runId, taskType, selectedRole?, reasonCodes }` via the
  owning tool context; never persist full prompt/task text in this event.

- [ ] **Step 1: Write failing task-routing tests** for exact explicit roles, high-confidence inferred
  roles, low-confidence generic fallback, simple-task fallback, mixed specialist/implementation prompts,
  unknown-name generic fallback, absent trusted paths, and built-in read-only tool restrictions. Verify
  the parent remains responsible for wait/synthesis.
- [ ] **Step 2: Run RED:** `npx vitest run --root . apps/desktop/src/main/agent/tools/subagent-tools.test.ts`.
- [ ] **Step 3: Implement the pure route resolver and wire it into omitted-role `task` calls.** Keep
  `task`/`wait`, no-nesting, concurrency and worktree semantics unchanged.
- [ ] **Step 4: Run GREEN** for subagent tool/context tests and desktop typecheck.

### Task 4: Add the pre-execution Intent Gate

**Files:**
- Create: `apps/desktop/src/main/agent/harness/intent-gate.ts` and `.test.ts`.
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts` and `.test.ts`.
- Reuse: `apps/desktop/src/main/interaction/question-broker.ts` without changing tool permissions.

**Interfaces:**

```ts
export type IntentGateResult =
  | { action: "proceed" }
  | { action: "suggest_plan"; classification: HarnessTaskClassification }
  | { action: "clarify"; question: QuestionPrompt; default: string }
  | { action: "confirm"; question: QuestionPrompt };
```

`evaluateIntentGate()` is pure. Confirmation is based on an explicit consequential effect in Build mode,
not broad risk keywords: a security review or plan about a migration does not confirm solely because of
those terms; direct destructive actions, including later clauses targeting production data, an account,
or a database table, still confirm. A complex request returns a non-blocking `suggest_plan` that the
runtime surfaces as an optional Plan Mode suggestion. Clarification asks for the missing decision and accepts a bounded custom answer; only skip
uses the conservative default, while cancel blocks. No raw task prompt is persisted as a gate artifact.
The runtime uses an abort signal for the pending question, cancels it on stop/release, and verifies the
same run still owns execution before proceeding; a late answer cannot resume a cancelled run. New prompt
calls received during unresolved preflight are explicitly rejected before a new run/user message is
recorded. Keep the reservation through the SDK's asynchronous input/before-agent hooks; release it only
when the SDK preflight callback fires (or the prompt settles). Cancellation cleanup changes session-wide
state only if that run still owns the session. The gate remains separate from the permission broker and
applies once to a fresh user turn (not queued steer/follow-up).

- [ ] **Step 1: Write failing gate tests** for proceed/simple, non-blocking suggest plan/complex,
  clarify/ambiguous with bounded custom-answer/default-on-skip behavior, confirm/direct-consequential
  Build actions, no confirm for read-only security review or Plan Mode migration discussion,
  skip-default vs cancel, multi-prompt preflight rejection, abort/stop with a late answer,
  run-ownership/session-status checks, second prompt during a blocked SDK pre-stream hook, later
  destructive clauses (including account/table targets) plus read-only/conditional negatives, and no raw
  prompt persisted.
- [ ] **Step 2: Run RED:** focused intent-gate and PiSdk runtime tests.
- [ ] **Step 3: Wire preflight into the fresh-run boundary** using `requestQuestions` and a run-scoped
  abort signal; queued turns, retries, and existing approval checks must not be bypassed or gated twice.
- [ ] **Step 4: Run GREEN** for question-broker/PiSdk tests and desktop typecheck.

**Phase 1 Oracle Gate:** review Intent Gate fresh-run behavior, mixed-intent routing and simple-task
fallback, profile precedence/capability boundaries (including no Debugger terminal and UI/UX safe-field
overrides), typed route-event privacy, and the explicit V1 deferrals for UI/UX writes and path-aware
live routing. Do not continue until material findings are resolved.

---

## Phase 2 — Todo continuation and Auto QA evidence

**Oracle Gate 2:** review run settlement, persistence/rollback, continuation bounds, and truthfulness
of check evidence. Risk controlled: retry loops and unsupported completion claims.

### Task 5: Add run-scoped continuation budget and TODO rehydration

**Files:**
- Create: `apps/desktop/src/main/agent/harness/todo-continuation.ts` and `.test.ts`.
- Modify: `apps/desktop/src/shared/contracts.ts` to add `TodoStatus: "blocked"` and
  `harness.continuation` event.
- Modify: `apps/desktop/src/main/agent/tools/todo-tools.ts` and `.test.ts` to export/test
  `clearTodoSessionCache(sessionId)` for rehydration.
- Modify: `apps/desktop/src/main/agent/agent-event-store.ts` only for bounded latest-state queries.
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts` and `.test.ts` for authoritative run settlement.
- Modify: `apps/desktop/src/renderer/src/features/agent/TodosCard.tsx` and add
  `TodosCard.test.tsx` for blocked status and reason rendering.

**Interfaces:**
- `evaluateTodoContinuation({ todos, outcome, aborted, hasQueuedInput, attempts }): { action: "stop" | "continue" | "blocked"; reason: string }`.
- Add `blocked` to `TodoStatus`, with a bounded `blockedReason` on `TodoItem`; persist through the
  existing `todos.updated` event shape.
- The continuation count is at most one per original user turn; a new user message resets it.
- Persist the continuation marker as a small agent event tied to root run ID; reconstruct after restart.

- [ ] **Step 1: Write failing tests** for all-complete stop, one pending continuation, blocked/user-needed
  stop, run failure/abort stop, queued input stop, max-attempt stop, new-turn reset, rollback rehydrate,
  and runtime release/restart behavior.
- [ ] **Step 2: Run RED:** focused todo/agent-event/PiSdk tests.
- [ ] **Step 3: Implement a pure evaluator and the smallest persisted per-turn counter.** Do not create
  another todo store or recursively continue from the continuation run itself.
- [ ] **Step 4: Run GREEN** for focused tests and desktop typecheck.

### Task 6: Derive Auto QA only from actual tool/check evidence

**Files:**
- Create: `apps/desktop/src/main/agent/harness/qa-evidence.ts` and `.test.ts`.
- Modify: `apps/desktop/src/main/agent/agent-event-store.ts` for exact-run tool event references.
- Modify: `apps/desktop/src/main/agent/pi-event-normalizer.ts` and `.test.ts` to attach the active
  run ID to durable tool.started/tool.ended events.
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts` and `.test.ts` to evaluate QA at settlement.
- Modify: `apps/desktop/src/main/agent/tools/registry.ts` and `.test.ts` so recognized QA script/check
  invocations require the existing permission broker's approval before execution.
- Modify: `apps/desktop/src/shared/contracts.ts` only for a structured QA status/event.

**Interfaces:**
- `HarnessQAResult` is `{ required: boolean; status: AutoQAStatus; reasonCode: string; evidence: HarnessEvidenceRef[] }`.
- `summarizeRunQA({ sessionId, runId, changedPaths, requiredChecks, events }): HarnessQAResult` returns
  concise evidence refs (event/run ID, safe check label, exit/error state, relevant revision/path); it
  never returns raw command output.
- `getRunToolEvidence(sessionId, runId)` queries bounded `tool.started`/`tool.ended` pairs by run ID;
  it must not call `listAgentEvents()` if that API also loads prompt text.
- V1 `requiredChecks` come from affirmative explicit Build requests; negated/prohibited checks do not
  create a requirement. Spec acceptance-derived check kinds are added in Phase 3 (Tasks 7–8). No
  requested checks → `not_required`.
- `commandCheckName` recognizes only eligible check invocations at the start of a supported tool command;
  substring mentions/echoes (e.g. `echo npm test`) and help/version-only invocations never count.
- Evidence is fresh only if it reflects final source changes. Later write/edit or unclassified shell
  actions or fixing check options (`--write`, `--fix`, `--apply`) invalidate earlier evidence; fixing check
  invocations themselves cannot be final passing evidence. Absent paths do not imply coverage of every
  changed file.
- A completed recognized `bash` check with `isError: false` may pass when Bash omits an exit code; other
  tools with unknown exit status remain `unavailable`. Failed/skipped/missing remain distinct, and
  manual/user confirmation is not an automated pass.
- Recognized check/package-script invocations are permission-gated at the terminal tool boundary; an
  eligible script declaration alone never authorizes execution.
- Continuation is allowed only when an eligible bounded project script/check exists; otherwise retain
  `missing`/`unavailable` and do not spend the continuation budget.

- [ ] **Step 1: Write failing tests** for successful/failed pairs; target-level negation in both check
  orderings; `echo npm test`, quoted, help/version/list-only, and other false-positive command forms;
  no-result/aborted calls; successful Bash without explicit exit code versus unknown-tool/no-exit-code;
  check-then-edit and `--write`/`--fix`/`--apply` invalidation; no raw output; unknown/missing requirements;
  no continuation when no eligible script exists or a script uses fixing flags; and simple-task
  `not_required` behavior.
- [ ] **Step 2: Run RED:** focused QA evidence tests.
- [ ] **Step 3: Implement a bounded query/reducer over existing events** and attach only structured
  results to the run/plan. Recognize eligible invocations only, invalidate stale evidence after later
  mutations, and spend the shared single continuation only when a bounded existing script is eligible;
  otherwise report the result unverified without arbitrary shell execution.
- [ ] **Step 4: Run GREEN** for QA, event-store, rollback and runtime tests plus typecheck.

**Phase 2 Oracle Gate:** verify outcomes are grounded in persisted events, not model claims; check
abort, rollback, restart and continuation loops before Phase 3.

---

## Phase 3 — Spec Mode and HyperPlan

**Oracle Gate 3:** review plan migration compatibility, acceptance/evidence traceability, read-only
critic tools, costs, and explicit Build consent. Risk controlled: plans claiming verification without
evidence or critics gaining edit permissions.

### Task 7: Extend Plan Mode storage with optional Spec metadata

**Files:**
- Modify: `apps/desktop/src/shared/contracts.ts` for requirement/criterion/evidence types and optional
  `PlanRef.spec`.
- Modify: `apps/desktop/src/main/plan/plan-store.ts` and `.test.ts` to round-trip optional spec data
  and preserve legacy `plan.json` compatibility.
- Modify: `apps/desktop/src/main/agent/tools/plan-tools.ts` and `.test.ts` to accept structured spec
  fields only in Spec Mode.
- Modify: `apps/desktop/src/main/agent/plan-prompt.ts` for Spec Mode instructions.

**Interfaces:**
- Extend `AgentMode` from `"build" | "plan"` to `"build" | "plan" | "spec"`; Spec Mode reuses the
  read-only Plan tool profile while adding structured requirements/evidence input.
- `PlanRequirement { id, text }`.
- `PlanAcceptanceCriterion { id, requirementId, description, todoIds, requiredCheckKinds?, status }`, with
  statuses `pending | passed | failed | skipped | blocked`; optional required checks use bounded kinds
  `tests | typecheck | lint | build`.
- `PlanEvidenceRef = HarnessEvidenceRef & { criterionId: string }`; no raw command output or transcript
  text.
- Existing `PlanTodo` gains optional `acceptanceCriterionIds`; no second task list is introduced.

- [ ] **Step 1: Write failing store/tool tests** for legacy plan read, new spec round-trip, stable IDs,
  todo-to-criterion links, invalid criterion references, and no Spec object in ordinary Plan Mode.
- [ ] **Step 2: Run RED:** plan-store and plan-tools tests.
- [ ] **Step 3: Implement optional metadata and strict TypeBox validation** while preserving Markdown
  plan rendering and existing Build status semantics.
- [ ] **Step 4: Run GREEN** for plan, runtime, serialization and typecheck.

### Task 8: Add Spec Mode UI and bounded HyperPlan critics

**Files:**
- Create: `apps/desktop/src/main/agent/harness/hyperplan.ts` and `.test.ts`.
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts` and `.test.ts` for the internal critic call.
- Modify: `apps/desktop/src/main/agent/tools/registry.ts` and plan tools only for a dedicated
  read-only `hyperplan_review` action.
- Modify: `apps/desktop/src/renderer/src/features/agent/ChatPane.tsx` and relevant plan UI/tests for
  Spec Mode and optional HyperPlan choice.

**Interfaces:**
- `HyperPlanCriticId = "architecture" | "risk" | "simplicity" | "failure"`.
- `HyperPlanCriticResult = { critic: HyperPlanCriticId; status: "completed" | "unavailable"; findings: string[]; references: string[] }`.
- `HyperPlanSummary = { critiques: HyperPlanCriticResult[]; agreements: string[]; disagreements: string[]; risks: string[]; openQuestions: string[]; references: string[] }`.
- `runHyperPlanReview(input): Promise<HyperPlanSummary>` runs four fixed critic prompts: architecture,
  risk, simplicity/YAGNI, and failure/verification; returns those exact bounded summary fields.
- Maximum four concurrent critics, no nested delegation, no write/terminal/MCP-dangerous tools, per-
  critic timeout, and a capped total summary. Failure of a critic is recorded as unavailable, not as
  approval.
- HyperPlan is only invoked when explicitly selected or user accepts the complexity suggestion. The
  final plan must be reviewed and Build explicitly selected.
- Build runs from Spec plans derive `requiredChecks` from linked acceptance criteria and pass them to
  Task 6's QA reducer; ordinary non-Spec Build runs retain the explicit-request policy.

- [ ] **Step 1: Write failing tests** for simple task no suggestion, complex task suggestion, critic
  tool allowlist/read-only isolation, independent critic result separation, timeout/failure summaries,
  bounded output, and explicit Build consent.
- [ ] **Step 2: Run RED:** focused HyperPlan, plan tools and Plan UI tests.
- [ ] **Step 3: Implement the internal critic coordinator** using existing runtime/subagent operations;
  Plan Mode does not receive unrestricted `task`/`wait` or edit tools.
- [ ] **Step 4: Add the Spec Mode selection and acceptance display**; simple tasks retain existing chat/
  plan flow without generated artifacts.
- [ ] **Step 5: Run GREEN** for plan/hyperplan/UI tests and typecheck.

**Phase 3 Oracle Gate:** review JSON compatibility, exact acceptance evidence, plan read-only boundary,
critic output privacy and resource budgets.

---

## Phase 4 — Search integrations and shared discoveries

**Oracle Gate 4:** review MCP read-only enforcement, result limits/citations, CodeGraph no-sync boundary,
and Project Intelligence provenance. Risk controlled: arbitrary MCP access and untrusted search data.

### Task 9: Add typed external-reference evidence to Project Intelligence

**Files:**
- Modify: `apps/desktop/src/shared/contracts.ts` for the external evidence DTO/input union.
- Modify: `apps/desktop/src/main/db/database.ts` for a compatibility-tested evidence-table rebuild.
- Modify: `apps/desktop/src/main/memory/project-memory-service.ts` and `.test.ts` for URL validation,
  insert/dedupe mapping, status policy, detach/delete, and planner projection.
- Modify: `apps/desktop/src/main/agent/tools/project-memory-tools.ts` and `.test.ts` for the
  external-reference proposal input.
- Modify: `apps/desktop/src/main/context/context-planner.ts` and `.test.ts` for untrusted source labels.
- Modify: `apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx` and
  `projectMemory.test.ts` to show validated external links as untrusted evidence.

**Interfaces:**
- Stored `ProjectMemoryEvidence` adds `kind: "external_reference"` with
  `externalReference: { url, title?, sourceLabel, retrievedAt, origin: "mcp_attested" | "agent_supplied_unverified" }`.
- Main-only normalized evidence carries source/trust metadata. The agent-facing proposal input for this
  task accepts only `{ kind: "external_reference", url, title? }`; main sets
  `sourceLabel: "Agent-supplied"`, `origin: "agent_supplied_unverified"`, and `retrievedAt`.
- `url` must canonicalize to HTTP(S), have no userinfo/credential-like query keys, drop fragments,
  and fit the existing bounded evidence metadata limit. No page text/excerpts are stored.
- External evidence is provenance, not verification. A proposal supported only by external references
  becomes `needs_review`, cannot become global, and is excluded from automatic context until the
  existing explicit Verify flow or qualifying local evidence makes it eligible.
- Chat deletion detaches session/run identifiers but preserves the external citation with the reusable
  memory. Memory/project deletion cascades it.

- [ ] **Step 1: Write failing migration/service tests** for populated legacy DB rebuild with foreign
  keys, preservation of evidence IDs/rows/indexes/triggers, idempotent rerun, accepted/rejected URL
  forms, title/source/time bounds, secret query rejection, dedupe, global-scope rejection, external-only
  `needs_review`, rollback, chat detach retention, and project/memory deletion.
- [ ] **Step 2: Run RED** for the memory service suite; expected failures cover absent kind/columns and
  missing trust/status behavior.
- [ ] **Step 3: Add the transactional SQLite migration** that creates a replacement evidence table
  with the expanded kind check and external JSON metadata, copies existing rows, recreates indexes and
  the session-delete detach trigger, then swaps tables atomically.
- [ ] **Step 4: Implement service-boundary URL validation for direct agent references** on both new and
  deduped proposals. Ignore any caller-supplied source label/origin/retrieval time; label it
  `Agent-supplied` and `agent_supplied_unverified`.
- [ ] **Step 5: Keep external-only records out of automatic context** and display validated external
  source labels/links in Settings; do not mark an external URL itself as verified.
- [ ] **Step 6: Run GREEN** for migration, memory, planner and Settings tests plus desktop typecheck.

### Task 10: Expose allowlisted MCP research tools and main-issued citation IDs

**Files:**
- Modify: `apps/desktop/src/main/mcp/mcp-config.ts` and `.test.ts` for allowlist round-trip.
- Modify: `apps/desktop/src/main/mcp/mcp-service.ts` and `.test.ts` for tool registration and structured
  citation extraction.
- Create: `apps/desktop/src/main/agent/harness/mcp-citation-registry.ts` and `.test.ts`.
- Modify: `apps/desktop/src/main/agent/tools/project-memory-tools.ts` and `.test.ts` to resolve citation
  IDs into external evidence.
- Modify: `apps/desktop/src/shared/contracts.ts`, `McpServerInfo`/`McpServerUpsertInput`, MCP IPC
  schemas/preload, `McpFormState`/`McpServerForm` in `SettingsPanel.tsx`, and Settings tests.

**Interfaces:**
- `McpServerConfig.readOnlyToolAllowlist?: string[]`, default empty. Settings displays the connected
  server’s discovered tool names with explicit read-only checkboxes and confirms the user’s assertion.
- `McpCitation = { id, sessionId, runId, serverName, toolName, url, title?, retrievedAt }` exists only
  in a bounded main-process map for the current run. `registerMcpCitations()` registers structured
  resource links/structured URL fields from successful allowlisted MCP calls; it never parses result
  prose or retains response bodies. The returned tool text appends a short citation list with each
  main-issued ID, source name and title/domain so the model can cite it.
- `resolveMcpCitations(sessionId, runId, ids)` returns metadata only for IDs created by that exact
  session/run. The Project Memory tool accepts citation IDs as an alternative to a direct URL; a valid
  ID resolves to main-attested metadata, while a direct URL stays `agent_supplied_unverified`. The tool
  schema never accepts model-supplied `sourceLabel`, `origin`, or `retrievedAt`.
- Only exact allowlisted tool names are registered as safe/read for existing chat/plan profiles; the
  built-in Librarian profile exposes only that allowlist. All other MCP tools retain existing
  chat-only/dangerous behavior; no credentials/headers enter the model.

- [ ] **Step 1: Write failing tests** for config default/round-trip, per-server workspace/user scopes,
  Settings checkboxes, read-only tool registration, arbitrary tool denial, structured-link extraction
  only, citation IDs visible to the agent, citation ID forgery/wrong run, URL bounds/secrets, timeouts,
  and response/header non-persistence in stored evidence.
- [ ] **Step 2: Run RED:** MCP config/service/registry and citation registry tests.
- [ ] **Step 3: Implement the allowlist and MCP Settings control** using existing
  `McpServerUpsertInput`, `McpFormState`, and the connected server tool list; default every checkbox
  off and do not add credentials/provider dependencies.
- [ ] **Step 4: Implement the bounded main citation registry** and connect citation IDs to
  `project_memory_propose`; expire IDs at run finalization/abort and fail closed on wrong-owner IDs.
- [ ] **Step 5: Run GREEN** for MCP/citation/project-memory/Settings tests and desktop typecheck.

### Task 11: Preserve typed Fast Codebase discoveries for bounded sharing

**Files:**
- Modify: `apps/desktop/src/shared/contracts.ts` for a structured `codegraph.discoveries` AgentEvent.
- Modify: `apps/desktop/src/main/fast-codebase/fast-codebase-service.ts` and `.test.ts`.
- Modify: `apps/desktop/src/main/agent/tools/fast-codebase-tools.ts` and `.test.ts`.
- Modify: `apps/desktop/src/main/agent/agent-event-store.ts` for a bounded session discovery query.
- Modify: `apps/desktop/src/main/agent/tools/wait-tools.ts` and `pi-sdk-runtime.ts` plus tests for
  compact parent harvest of child discoveries.
- Modify: `apps/desktop/src/main/context/context-planner.ts` and `.test.ts` only to consume validated
  path/symbol memory evidence; no per-turn CodeGraph source is added.

**Interfaces:**
- `FastCodebaseResult` keeps existing `text`/`details` and adds bounded typed
  `hits: Array<{ path, symbol?, line?, kind? }>` from existing structured CodeGraph nodes.
- `codegraph.discoveries` contains `{ sessionId, runId, hits }` only; it stores no query text or code
  excerpts. The tool validates paths against its owning workspace and emits this event after a
  successful explicit Fast Codebase call.
- A bounded `getSessionCodeGraphDiscoveries(sessionId)` returns only references for `wait`. Worktree
  child hits remain provisional; parent verification/integration is still required before persisting as
  trusted memory evidence. No indexing/sync occurs in Context Planner/new-turn retrieval.

- [ ] **Step 1: Write failing typed-hit tests** for query parsing, line/path normalization, bounds,
  hidden text compatibility, invalid/outside-workspace rejection, and no result when CodeGraph is
  unavailable.
- [ ] **Step 2: Run RED:** Fast Codebase service/tool and Context Planner tests.
- [ ] **Step 3: Implement typed hit propagation** while preserving current tool-card text and existing
  indexing/sync behavior only for explicit user/agent tool calls.
- [ ] **Step 4: Add bounded wait-handoff tests** proving that only path/symbol references are returned,
  no query/prose/source body is included, duplicates are removed, and worktree hits are marked provisional.
- [ ] **Step 5: Run GREEN** for Fast Codebase/planner/wait tests and typecheck.

**Phase 4 Oracle Gate:** review tool capabilities, MCP allowlist enforcement, CodeGraph network/sync
boundaries, workspace/path validation, and child provenance before Insights work.

---

## Phase 5 — Harness Insights

**Oracle Gate 5:** review privacy, statistical claims, workspace scoping, retention and non-mutation.
Risk controlled: telemetry leakage and recommendations presented as proven facts.

### Task 12: Add local evidence-backed Harness Insights service and UI

**Files:**
- Create: `apps/desktop/src/main/agent/harness/harness-insights-service.ts` and `.test.ts`.
- Modify: `apps/desktop/src/main/agent/agent-event-store.ts` for bounded structured event queries.
- Modify/add: `apps/desktop/src/shared/contracts.ts`, `apps/desktop/src/main/ipc/channels.ts`,
  `schemas.ts`, `register-app-ipc.ts` and `apps/desktop/src/main/ipc/harness-insights-ipc.ts` with tests.
- Modify: `apps/desktop/src/preload/types.ts`, `index.ts`.
- Modify: `apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx` and add
  `harnessInsights.test.tsx`; route visual work to `@designer`.

**Interfaces:**
- `HarnessInsight` includes `id`, `kind`, short claim, recommendation, period, sample count,
  confidence/limitations, and event/run references; it has no raw prompt/output fields.
- `MIN_COMPARABLE_EPISODES = 3`; fewer comparable task episodes return no recommendation and an
  `unknown` evidence state.
- `getHarnessInsights({ workspaceId?, since, limit })` queries local runs/events/checkpoints only,
  applies scope/window/limit before aggregation, and returns `unknown` when evidence is insufficient.
- Applying any suggestion is not included in V1; no prompt/config/tool auto-write or background
  telemetry. Approved reusable facts may be explicitly saved through existing Project Intelligence
  APIs with normal provenance/promotion rules.

- [x] **Step 1: Write failing aggregation tests** for repeated error loops, same-path rework/rollback,
  context-pressure proxy, delegation mismatch, insufficient sample/unknown state, workspace isolation,
  event window, no raw transcript/secret inclusion, and no automatic mutation.
- [x] **Step 2: Run RED:** Harness Insights service/IPC tests.
- [x] **Step 3: Implement bounded local queries and pure reducers**; avoid full transcript loading and
  label all insights as hypotheses with source evidence.
- [x] **Step 4: Write renderer helper tests** for sample/confidence labels, scope and empty/error states.
- [x] **Step 5: Ask `@designer` to build the Settings view** using existing UI patterns; keep reports
  compact and provide links to source events rather than embedding them.
- [x] **Step 6: Run GREEN** for insights service/IPC/UI tests, typecheck, build, and diff checks.

**Gate 5:** Oracle PASS after the user-authorized follow-up. The final review confirmed literal JSON
boolean typing, run/session evidence ownership, Inbox exclusion, path-value non-disclosure, bounded
on-demand reporting, and no persisted telemetry or automatic mutation. Task 12 focused verification
passed 5 files / 57 tests; desktop typecheck, production build, Biome, and diff checks passed. The full
suite remains 1259/1261 with the unchanged locale-sensitive `modelThinking.test.ts` failure and
intermittent Git temp-cleanup `EBUSY` (the Git suite passed 39/39 in isolation).

## Plan Self-Review

- **Spec coverage:** Task 1 covers shared policy contracts/classification; Tasks 2–4 cover built-ins,
  routing, and Intent Gate; V1 explicitly defers Debugger terminal commands, UI/UX writes, and live
  path-aware routing until enforceable capabilities/trusted inputs exist. Tasks 5–6 cover continuation
  and evidence-based Auto QA; Tasks 7–8 cover
  Spec Mode and HyperPlan; Tasks 9–11 cover typed external evidence, safe MCP citations, and CodeGraph
  sharing; Task 12 covers local Harness Insights; final verification covers integration/baseline.
- **Placeholder scan:** no TBD/FIXME/incomplete steps; each task names file ownership, RED/GREEN
  target suites, concrete cases and an output boundary. Exact commands are provided where test paths
  are already established; the final verification commands are explicit.
- **Type consistency:** `TaskClassificationInput`, `HarnessTaskClassification`, `IntentGateResult`,
  `HarnessEvidenceRef`, `AutoQAStatus`, `PlanEvidenceRef`, `HyperPlanSummary`, `McpCitation`,
  `ProjectMemoryEvidence.externalReference`, `codegraph.discoveries`, and `HarnessInsight` are defined
  before later consumers.
- **Ownership/dependencies:** phase gates are sequential; within Phase 4, external-evidence schema
  precedes MCP citation resolution, which precedes CodeGraph discovery sharing. `@designer` owns
  Settings surfaces; `@fixer` owns main/runtime/persistence; Oracle gates are read-only. No commit/PR
  without user request.
- **Baseline:** final full `npm test` reported 1259 passed / 2 failed: the unchanged locale-sensitive
  `modelThinking.test.ts` assertion and an intermittent Windows Git temp-cleanup `EBUSY` (the isolated
  `git-service.test.ts` passed 39/39). Task 12's focused suites passed 5 files / 57 tests; typecheck,
  production build, scoped Biome, and diff checks passed.

## Final verification (after phase gates)

- Run the complete Project Harness focused suites for classifier, routing, intent, todos, QA, Spec,
  HyperPlan, MCP allowlist, Fast Codebase, Insights, and affected runtime/IPC/UI behavior.
- Run `npm --workspace @modus/desktop run typecheck`, `npm --workspace @modus/desktop run build`,
  new-file Biome checks, `git diff --check`, and `npm test`.
- Compare any full-suite failures with the existing `origin/main` baseline; report exact evidence and
  do not mask unrelated environment-sensitive failures.
- No commit/PR is included in this plan unless the user explicitly requests it later.
