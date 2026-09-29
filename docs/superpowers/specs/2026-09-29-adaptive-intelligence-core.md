# Modus Adaptive Intelligence Core

**Status:** Slice 2 implemented (safe auto-dispatch, persistence, learning promotion, timeline UI, cross-session blacklist)  
**Fork:** [Stoltembergg/modus](https://github.com/Stoltembergg/modus)  
**PR:** [#50](https://github.com/Stoltembergg/modus/pull/50)  
**Prior art:** `docs/superpowers/specs/2026-09-27-modus-adaptive-harness-core-design.md` (approved) + PR #46 (Task State) + slice 1 Meta Controller

## Goal

Add a local, evidence-first **decision layer** above / alongside `PiSdkRuntime` that improves action selection, verification, recovery, and context gathering. It must **not** replace memory, context planner, subagents, worktrees, ToolRegistry, permissions, Plan/Spec/TODO, CodeGraph, or Harness Insights — it orchestrates them.

Primary success measure: **verified completion among tasks with applicable acceptance criteria**, with zero false-verified regressions.

## Mapping: requirement → existing surface → new work

| Requirement | Existing Modus surface | Extend vs new |
| --- | --- | --- |
| **1. Meta Controller** | Intent Gate, task classifier, HyperPlan, subagent `task`/`wait`, Auto QA continuation | **New** pure `decideNext()` + safe-dispatch adapter in `PiSdkRuntime` |
| **2. Verifier-First** | `harness/qa-evidence.ts`, Task State (`harness.task_state`), checkpoints, git change scope | **Extended** (Phase 1 shipped in PR #46); gate hooks consulted by Meta Controller |
| **3. Failure Intelligence** | `agent_events`, project memory `failed_attempt`, Harness Insights `repeated_failures` | **New** run-scoped ledger + **cross-session soft blacklist** |
| **4. Project Model** | Fast Codebase / CodeGraph hits, Git change stats, checkpoints, PlanSpec, project memory | **New** SQLite edge/snapshot store + impact API backed by stored edges |
| **5. Context Engine** | `context/context-planner.ts`, project memory, docs chunks, CodeGraph discoveries | **New** uncertainty-reduction scoring; safe retrieve uses Context Planner |
| **6. Living task state** | `harness/task-state.ts`, PlanSpec, todos, QA events | **Extended** — Meta Controller reads it for re-planning |
| **7. Adaptive Execution Policy** | Model catalog, builtin roles, HyperPlan opt-in, child concurrency caps, required checks | **New** deterministic policy selector |
| **8. Harness Learning** | `harness-insights-service.ts` | **Extended** — guarded promotion path (user confirm + evidence gate) |

## Architecture

```text
User prompt
  → PiSdkRuntime.prompt()
    → Intent Gate (existing)
    → AdaptiveDecisionSnapshot (Task State + failures + blacklist + impact + policy)
    → decideNext()  [Meta Controller — pure]
    → planSafeDispatch()  [allowlisted local effects only]
    → Tools still go through ToolRegistry + permission broker
    → QA / tool outcomes → FailureIntelligence + blacklist + Task State
    → harness.decision / harness.failure → timeline notices + Insights
```

### Safe auto-dispatch allowlist (binding)

Allowlisted for automatic local effects (`active` mode):

| Action | Effect |
| --- | --- |
| `retrieve_local` | Bounded Context Planner digest injection (untrusted data) |
| `verify` | Strengthen verification gate for the turn |
| `suggest_plan` | Advisory Plan/HyperPlan suggestion text |
| `finish` | Terminal when verification already satisfied |

**Never auto-dispatched:** `execute`, `suggest_oracle`, `replan`, `ask_user`, `avoid_retry`, child subagent spawn, MCP external calls, file writes, destructive shell. These remain hints or human-gated.

Cannot bypass permission broker, Intent Gate, Build consent, or destructive confirmation.

### Persistence (slice 2)

SQLite tables (via `migrateDatabase`):

- `project_model_edges` / `project_model_snapshots` — revision-scoped typed edges + impact cache
- `harness_failure_blacklist` — workspace soft blacklist with TTL, clear, expire
- `harness_promotions` — proposed/validated/promoted/rejected learning records
- `app_settings` keys `harness.promotion.<kind>:<workspaceId>` — versioned preference only

Events (unchanged types, now surfaced in UI):

- `harness.decision` — Meta Controller output
- `harness.failure` — attempt signature + status + evidence refs

### Harness Learning promotion

1. Insights remain suggestion-only by default.
2. `evaluatePromotionEligibility` requires comparable episodes + non-low confidence + multi-run refs.
3. `promoteHarnessInsight` additionally requires `confirmedByUser: true`.
4. Promotion writes a versioned preference flag — **never** mutates skills, prompts, routing rules, or permissions silently.

### Cross-session failure blacklist

- Soft discourage by strategy signature across sessions in the same workspace.
- Default TTL 14 days; auto-expire; clear per strategy or all via Settings.
- Not a permanent hard block; changed revision still allows reevaluation in-run.

### Decision timeline UI

`Timeline.tsx` renders `harness.decision` and `harness.failure` as compact notices inside the existing turn fold.

## Slice status

**Slice 1 (landed):** core types, Meta Controller, Failure Intelligence (run-scoped), Execution Policy, Project Model API, Context Engine scoring, advisory wiring, unit tests.

**Slice 2 (this update):**

1. Safe auto-dispatch allowlist + runtime adapter  
2. Project Model SQLite persistence + CodeGraph/git refresh hooks  
3. Guarded Harness Learning promotion path + Settings confirm  
4. Decision timeline UI for decision/failure events  
5. Cross-session failure blacklist with expire/clear  

**Remaining gaps / follow-ups**

- Active dispatch still does not spawn children or call MCP (by design)
- CodeGraph binary sync/index is still user/agent-triggered; we only persist hits already produced
- No dedicated blacklist management panel beyond Settings clear-all
- Promoted preferences are stored but not yet a full policy DSL consumer beyond Meta Controller avoidance signals

## How to verify

```bash
npm install
npm run test --workspace @modus/desktop -- harness/meta-controller harness/safe-dispatch harness/adaptive-slice2 harness/failure-intelligence harness/execution-policy harness/project-model harness/context-engine
npm run typecheck --workspace @modus/desktop
npm run check
```

## Non-goals

- More agents/MCPs/workflows for their own sake
- Replacing PI coding-agent runtime
- Silent self-modifying harness without user approval
