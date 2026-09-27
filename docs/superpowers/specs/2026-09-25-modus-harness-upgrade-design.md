# Modus Harness Upgrade — Design Specification

**Status:** proposed; requires user review before implementation planning.

## Goal

Extend Modus’s existing Pi runtime, tools, subagents, plans, todos, permissions, Project Intelligence,
Fast Codebase, and MCP support into a lightweight, task-aware harness. The harness should route work,
clarify risky intent, keep multi-step execution moving, validate completion with real evidence, and
learn from sanitized session outcomes—without adding ceremony to simple tasks, duplicating existing
state, silently changing behavior, or importing an external orchestration framework.

## User-approved design decisions

- Extend native Modus flows; do not replace the runtime, `ToolRegistry`, Plan Mode, todo store, or
  Project Intelligence.
- Use deterministic local classification for task type/complexity; do not spend an extra model call
  just to route a simple task.
- Built-in roles are defaults below user and workspace definitions. Existing tool authorization still
  applies; a role prompt is not a security boundary.
- Reuse bounded parent-to-child `task`/`wait` for Team Mode. Do not add peer-to-peer agent messaging or
  recursive delegation in V1.
- Intent Gate proceeds without interruption for clear, low-risk work; it asks only for material
  ambiguity, missing requirements, or consequential actions. It does not replace per-tool permission
  checks.
- HyperPlan is optional, suggested for complex/high-risk tasks, and read-only. Build remains an
  explicit user decision.
- Spec Mode extends existing plan/todo state and is proportional to complexity. Simple tasks do not
  need formal specs or artificial tests.
- Todo continuation may automatically continue at most once per run/turn. Blocked or user-dependent
  tasks stop and are reported.
- Auto QA records actual check outcomes; a model assertion or successful run is not test evidence.
- Context7 and GitHub Code Search use only MCP servers explicitly configured by the user, through a
  vetted read-only allowlist. No native credentials, provider SDK, or dependency is added in V1.
- Harness Insights is local and on-demand; it produces evidence-backed suggestions and never changes
  prompts, routing, settings, or tools without explicit approval.

## Current Modus architecture

- `runtime-registry.ts` selects the singleton `PiSdkRuntime`. `ToolRegistry` owns registration,
  profile filtering, risk classification, and capabilities; the runtime narrows available tools per
  turn.
- User/workspace Markdown agents already load from `.codex`, `.claude`, `.cursor`, and `.modus`, with
  workspace overrides. Delegation creates background child sessions, forbids nesting, caps concurrent
  children, and harvests bounded results through `wait`.
- Plan Mode is read-only and writes one persisted plan. `plan_write` stores plan content and todos;
  `todo_write` separately records session TODO events. “Built” currently means a successful
  output-producing run, not verified acceptance.
- Existing permission classification, permission broker, approval modes, and `ask_user` handle tool
  authorization and clarification. Approval modes are prompting policy, not a sandbox.
- Session/run/tool events, token usage, checkpoints, rollback, worktree status, and Project
  Intelligence evidence are available locally. Todo state is rehydrated from events and must be
  invalidated/reloaded after rollback.
- Fast Codebase is a local CodeGraph tool; its user-facing result is prose and indexing/sync may be
  slow. `web_search`/`web_fetch`, local docs search, and configurable MCP exist. There is no native
  Context7 or GitHub Code Search adapter; current MCP tools are chat-only and marked dangerous by
  default.

## Components and behavior

### 1. Built-in specialist catalog and task router

Add concise built-in defaults for:

| Role | Intended work | Capability boundary |
|---|---|---|
| Explore | Map relevant files, symbols, flows, and tests | Read-only repository search/read |
| Librarian | Official docs, current APIs, and configured search sources | Read-only web/MCP allowlist |
| Oracle | Architecture, risk, and cross-system decisions | Read-only review/advice |
| Reviewer | Diff, correctness, regression, and acceptance review | Read-only diff/test evidence |
| Debugger | Reproduce failures, trace data flow, isolate a root cause | Read-only inspection in V1; no terminal execution until a bounded diagnostic runner can be enforced |
| UI/UX | User-visible interaction, hierarchy, responsive behavior, and visual polish | Read-only design/review in V1; implementation deferred until worktree/write approval and renderer-path allowlisting are enforceable |

Built-ins are defaults, not hard-coded provider/model choices. Precedence is built-in < user-level
agent < workspace-level agent for the same role name. For UI/UX, only safe profile fields (such as
description, model, and body) are overridable; the read-only tool/capability boundary is clamped and
cannot be widened by Markdown overrides in V1. The existing generic task behavior remains a fallback
for unknown roles and providers.

The deterministic classifier returns a compact `TaskClassification` containing task type, complexity,
risk, confidence/reasons, and an optional suggested role. The pure classifier accepts structured path
scope, but the V1 task-tool context exposes no trusted current path inventory; the live router therefore
passes empty path lists, and path-based complexity does not affect live routing. Do not derive scope from
task prose or raw transcripts. This limitation is explicit and can be revisited when trusted structured
path context is available. Mixed specialist/implementation signals are ambiguous and must not auto-route
to a read-only specialist. The router does not pre-dispatch a child before the first model call:
simple/clear work remains inline, and when the main agent invokes `task` without naming a role, the
router selects a matching built-in only at high confidence. Low confidence keeps the generic task/parent
path. The parent remains the task owner and integrates/validates the result. This adds no separate model
classification call; the chosen route and reason are observable in the session event stream.

Team Mode is bounded parallel parent-to-child execution using the existing subagent lifecycle. The
parent owns the task list and synthesis. Children cannot spawn children, have explicit file/tool scope,
and return short cited summaries. Existing concurrency limits and worktree integration/verification
states remain authoritative. HyperPlan’s critics use a separate read-only path in Plan Mode rather
than granting all chat tools to the plan profile.

### 2. Intent Gate

Before a new execution, the main runtime evaluates a compact intent result:

- `proceed`: request and scope are clear, low consequence;
- `clarify`: a material requirement or target is ambiguous;
- `suggest_plan`: work spans multiple components or has meaningful dependencies;
- `confirm`: requested effect is consequential or irreversible and requires explicit intent.

Classification is deterministic and cheap; confirmation is based on the requested effect and execution
mode, not isolated keywords (a read-only security review or migration plan is not itself consequential).
A `suggest_plan` is surfaced as an optional suggestion without blocking execution. Clarification asks
for the missing decision, uses a bounded submitted answer for this turn, and uses the conservative
default only when skipped. A gate decision is associated with the user turn/run, not reused for a later
distinct request. Stopping/releasing a session cancels its pending gate; a stale answer cannot resume
the run. Additional prompts received during unresolved preflight are rejected before a second run or
user message is recorded; the reservation remains until the SDK reports preflight completion after its
input hooks. Cancellation cleanup changes session-wide state only while that run still owns the session.
The gate never grants tool permission or weakens the existing permission broker. No raw prompt copy is
persisted as a gate artifact.

### 3. Todo Continuation Enforcer and Auto QA

`todo_write` remains the single authoritative session TODO store. At a terminal run boundary, the
enforcer reloads current persisted TODO state and, when present, Spec acceptance links:

- all complete → allow a normal completion summary;
- actionable pending work → permit at most one bounded continuation for the same run/turn chain;
- blocked, needs-user, aborted, failed, or exhausted continuation budget → stop and summarize the
  remaining items without retrying indefinitely.

New user input resets the continuation budget. Rollback, session deletion, runtime release, and
compaction must not duplicate or resurrect stale TODO state.

Auto QA records evidence states `passed`, `failed`, `skipped`, `missing`, or `unavailable`, with a
small reference to the real command/check, exit status, run ID, and relevant revision/path. In V1,
required check kinds come from affirmative explicit Build requests; negations such as “do not run tests”
do not create a requirement. Phase 3 Spec acceptance criteria add structured check requirements. A
command is a check only when it matches an eligible invocation at the beginning of a supported tool
command, never because a command merely mentions or echoes `npm test` or similar. Help/version/list-only
invocations do not count, and target-level negation applies to each requested check. Fixing check options
such as `--write`, `--fix`, or `--apply` do not produce final passing evidence.
Evidence must reflect final changed scope: later source mutations invalidate earlier checks unless
fresh coverage is established; missing path scope does not imply coverage of every changed file. A
completed recognized built-in Bash check with no explicit exit code may pass only when `isError` is false;
other tools with unknown exit status remain `unavailable`. Every recognized package/check command is
classified for explicit permission through the existing broker before execution; eligible-script
presence alone is not authorization. Auto QA does not execute arbitrary model-generated shell or run a
large suite for a simple change. A single continuation may run only when an eligible bounded project
check exists and the existing permission flow authorizes it; otherwise
report `missing`/`unavailable`/`failed` without a completion claim. Manual user confirmation is separate
from automated `passed`. With no formal Spec, QA stays proportional and does not force tests where they
add no value.

### 4. Plan Mode, HyperPlan, and Spec Mode

Plan Mode stays read-only and remains the source of the implementation plan. HyperPlan is an optional
planning action suggested for high-complexity or high-risk work, with an explicit user choice. It runs
four independent bounded read-only critics:

1. architecture and interfaces;
2. security/data-loss/operational risks;
3. simplicity, reuse, and YAGNI;
4. failure modes and how the plan will be verified.

Critics receive only the spec/request and bounded relevant repository context. They cannot write code,
modify settings, or recursively delegate. The parent synthesizes agreements, disagreements, and
open questions into a compact plan; full critic transcripts are not inserted into the parent context.
The user reviews the plan and explicitly chooses Build.

Spec Mode is a distinct, optional planning variant for multi-step or high-risk work. It extends the
existing plan representation, rather than creating another TODO database, with:

- stable requirement IDs and observable acceptance-criterion IDs;
- links from existing plan todos to the criteria they implement;
- evidence references and outcome state (`passed`, `failed`, `skipped`, `missing`, `unavailable`);
- a short assumption/open-question list where relevant.

Evidence references are structured (test/check name, run ID, revision, path/symbol, or external URL),
not copied raw output. Acceptance criteria are complete only with real passing evidence or an explicit
user-approved exception. Simple changes retain the existing chat/build flow and do not require a
formal spec.

### 5. Harness Insights and knowledge/search integration

Harness Insights is an on-demand, local report under **Settings → Harness Insights**, derived from
structured session/run/tool/QA/checkpoint/rollback/delegation events. It may surface repeated
failure/retry patterns, rework on the same paths, context/token pressure, delegation mismatch (chosen
role versus task type, child failure, or parent rework after handoff), routing outcomes, and missing
verification. Context waste is an estimate from token/tool-event metadata, never inferred from raw
prompt content. Each finding includes its sample size, window, confidence/limitations, and evidence
references. “No evidence” remains unknown, not zero. It does not copy raw prompts, secrets, complete
shell output, or session transcripts into the report.

Insights can suggest a harness adjustment (e.g. improve a role prompt, routing rule, or check), but
never self-modifies. Applying a suggestion requires explicit user approval and a versioned change
with a regression check/rollback path. A currently successful run alone is not evidence of a
long-term improvement; compare later, comparable episodes.

Integration boundaries:

- Project Intelligence remains the durable source for concise, verified reusable facts. Insights
  telemetry is not automatically promoted to project memory; only a user-approved, verified summary
  may become a `task_result` or related memory with provenance.
- Context7/GitHub findings are transient by default. If a parent explicitly proposes a durable
  project-memory claim based on an external result, persist only typed `external_reference` evidence:
  a canonical HTTP(S) URL, bounded title, source label, and main-assigned retrieval time; do not store
  copied excerpts, search responses, headers, or credentials. A configured source label is attested
  only when the main process resolves a main-issued citation ID created by a successful, allowlisted
  MCP result with a structured URL/resource link. Keep this citation registry bounded and run-scoped;
  persist only the selected source metadata on explicit memory proposal. If no attested citation ID is
  supplied, any agent-provided URL is labeled `agent_supplied_unverified`.
- External-reference evidence is untrusted provenance, never verification. An external-only claim
  remains `needs_review`, cannot become global or enter automatic context until separately verified by
  user confirmation or independent local evidence.
  Validate/normalize URLs (reject userinfo and credential-like query values, strip fragments, cap
  length) in main. Extend the SQLite evidence kind with a transactionally rebuilt compatibility
  migration that preserves existing rows, IDs, indexes, and foreign keys.
- On chat deletion, detach the session/run identity but retain the external citation with the approved
  reusable Project Intelligence claim; deleting the memory or its project removes the citation.
  Display the link as untrusted source metadata in Settings, never as copied page content.
- `wait` shares bounded child IDs, findings, and file/symbol citations, preserving provisional status
  for unverified worktrees. The parent receives summaries, not full child reports.
- Fast Codebase may provide structured file/symbol hits only from an explicit agent-initiated local
  tool call. If a typed hit API is unavailable, do not parse prose. Never trigger CodeGraph indexing
  or sync in a new-turn retrieval path.
- Context7/GitHub Search are available only through user-configured MCP servers explicitly exposed as
  read-only search capabilities to Librarian/Plan/HyperPlan. Do not pass through arbitrary dangerous
  MCP tools. Bound query/result count, timeout, and response size; keep citations and fail soft when
  servers or credentials are unavailable. Do not call these sources during automatic new-turn retrieval.
- Retrieved web/code-map/MCP output is untrusted evidence, not instructions. It is summarized with
  source references and never inserted into system/developer prompts.

## Complexity-scaled behavior

- **Simple:** one clear bounded change, no risky side effect. Proceed inline; no Spec Mode or HyperPlan;
  only relevant lightweight checks.
- **Moderate:** several related files or known subsystem work. Use existing todos/plan and route one
  specialist when a clear role adds value; no automatic multi-critic review by default.
- **Complex/high-risk:** cross-subsystem changes, migrations/security/data loss, meaningful unknowns,
  or multiple dependent phases. Suggest Plan/Spec and offer HyperPlan; require explicit user approval
  before Build and use linked acceptance evidence.

The classifier can propose a higher level but must not force a lower-risk user request into a long
workflow. The user can choose a lighter route unless the action itself is prohibited by existing
permissions.

## Non-goals and constraints

- No replacement of PiSdkRuntime, ToolRegistry, existing plans/todos, permission broker, Project
  Intelligence, or Fast Codebase.
- No P2P agent chat bus, recursive autonomous agent teams, unbounded continuation/Ralph loop, or
  automatic prompt/config self-modification.
- No copying code or dependencies from Oh My OpenCode (SUL-1.0); use conceptual references only.
- No new API keys/providers/SDKs for Context7 or GitHub Search in V1; configured MCP only.
- No raw transcript analytics, external telemetry, or forced Spec/Test ceremony for simple changes.
- Preserve Windows/macOS/Linux support, existing authentication/permission rules, user/workspace
  agent overrides, fail-soft behavior, and parent-context budgets.

## Phased delivery and acceptance criteria

1. **Harness contracts and safety:** task classification/result contracts, built-in role catalog,
   deterministic routing, Intent Gate; tests prove simple tasks remain inline and permissions are not
   bypassed.
2. **Completion evidence:** Todo Continuation Enforcer and Auto QA; tests prove continuation cap,
   blocked/aborted stop behavior, rollback/resume rehydration, and actual-versus-missing check state.
3. **Planning:** optional HyperPlan and Spec Mode, reusing Plan/TODO data; tests prove read-only critics,
   no nested delegation, acceptance-to-evidence links, and no required Spec for simple tasks.
4. **Sources/memory:** configured MCP read-only allowlist, structured CodeGraph/Fast Codebase hits, and
   typed external-reference evidence in Project Intelligence; tests prove old-schema migration
   compatibility, URL validation/untrusted status, chat detachment versus deletion, tool scope,
   timeouts, citations, fail-soft and provisional child evidence.
5. **Insights:** local evidence queries, privacy-minimized reports, sample/confidence labeling, and
   approval-only improvement proposals; tests prove no transcript/secret leakage and no automatic
   configuration mutation.

Every phase is independently useful, has focused tests and an Oracle review gate. Later phases may be
reordered only if the approved implementation plan records the dependency and rationale.

## External reference notes

- Oh My OpenCode’s current docs provide useful specialist/routing and planning workflow concepts, but
  the exact “HyperPlan” name was not found; Prometheus/Atlas is an analogue. Its SUL-1.0 license bars
  treating its source as an implementation template for this project.
- ONP Spec Driven is MIT; reuse the requirement→acceptance→task→evidence traceability concept with a
  lighter simple-task path.
- Better Harness is MIT; reuse scoped evidence, privacy protection, comparable-episode analysis and
  stop/revert discipline, not its entire multi-host reporting system.
