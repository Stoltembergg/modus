# Modus Harness quality evolution — qualification report

- Date: 2026-10-25
- Branch: `feat/modus-maturity-remediation`
- Starting revision: `c7ed5df020e33b4a97bcf70109ab444029cef6d6`
- Upstream merged: `fd74a37b74f121f5cf6fb59c15aa009d3b6c4f66`
Implementation commits: `7b133e1b`, `4ad07b84`, `598dec9c`

This report records functional evidence from the VPS. It does not claim live
model quality, macOS package validation, THX integration, or resolution of the
separate payment-period ownership finding.

## Changes in this execution

- Fetched and merged the current `origin/main` into the dedicated remediation
  branch. Three conflicts were reconciled: Pi `Stop` keeps upstream restoration
  of queued prompts and the local orphan-run reconciliation; `AgentRuntime.abort`
  preserves both contracts; Automations keeps generation-scoped history and
  adopts upstream row styling.
- Added a separately selected `v2` Harness quality corpus. The original seven
  fixtures and their IDs, prompts, verifiers, and fixture hash are unchanged.
- Added a Portuguese iterative code-repair fixture whose zero-argument host tool
  reads only the approved source, returns only `passed` and fixed failure IDs,
  and stops after four checks. It reuses the original independent behavioral
  verifier; no reference implementation or expected values are exposed.
- Added an English scoped-recall fixture using the production SQLite memory
  retrieval and Context Planner in isolated temporary storage. A relevant
  current-workspace decision is seeded beside a same-topic different-workspace
  decoy; the real planner selects the former and excludes the latter.
- Refreshed the offline calibration record's source hashes after the evaluation
  runner changed. It continues to state `inferenceExecuted: false`; this is not a
  provider/model result.
- Inventoried the available THX native source ref. No THX runtime or shadow
  service was ported because the experimental secure bootstrap refuses launch
  and the ref has no Pi SDK/Meta Controller observer integration.

## Validation evidence

Commands and observed results:

| Command | Result |
| --- | --- |
| `node --test scripts/package-workflow-paths.test.mjs scripts/probe-workflow-gates.test.mjs` | 6 passed |
| `npm exec vitest run apps/desktop/scripts/release/merge-mac-update-yml.test.ts apps/desktop/scripts/release/release-channel.test.ts apps/desktop/scripts/build-rea-supervisor.test.ts apps/desktop/scripts/verify-packaged-sidecars.test.ts` | 52 passed |
| Plan-focused broad Vitest run (quality, Meta Controller, failure intelligence, TODO continuation, task state, QA evidence, delivery acceptance, memory/context, compaction, questions, Pi runtime) | 671 passed, 7 skipped; 16 files passed, 1 file could not import Electron |
| `vitest run apps/desktop/src/main/agent/harness/guards/guards.test.ts` using a temporary test-only `electron` alias | 27 passed |
| Task 6 local v2/v1 verifier run plus stored calibration and `command-line.test.ts` | 51 passed, 7 skipped; six files passed, live suite skipped |
| `NODE_OPTIONS=--max-old-space-size=4096 npm run check` | exit 0; Biome and desktop TypeScript passed; 238 existing warnings and 31 infos |

The initial guards suite failed before collecting tests because the shared
Electron package had no installed binary and attempted a network download
(`fetch failed`). No package or shared `node_modules` content was changed. A
temporary Vitest alias replaced only Electron's app boundary for that pure
guard suite; its 27 assertions then passed. The remaining run tests had already
passed independently. This is a test-environment limitation, not an app fix.

The live-inference cases were skipped. No provider/model or inference budget was
specified, so the runner was not enabled and no external inference request was
made. The checked-in offline calibration records `inferenceExecuted: false`.

The macOS package and signature workflow cannot be executed on this Linux VPS.
Workflow-input/filter and merge-script behavior is covered by the passing local
tests, but real macOS packaging/signing remains unqualified.

## Plan status

| Plan area | Status | Evidence / remaining limitation |
| --- | --- | --- |
| 0. Upstream and packaging-validation reference | **HOLD for macOS; GO for local checks** | Upstream merge and local release/workflow tests passed. Real macOS artifact/signature execution needs a macOS runner. |
| 1. Frozen baseline | **GO offline / HOLD live** | Seven original fixture identities and hash are unchanged; offline verifier calibration reproduced. No live model baseline. |
| 2. Recovery after failures | **GO for tested contracts** | Meta Controller, failure intelligence, repeat guard, TODO continuation and Pi runtime tests passed. No new product gap was reproduced, so no retry behavior was changed. |
| 3. Delivery evidence | **GO for tested contracts** | Task state, QA evidence and acceptance tests passed, including stale/contradictory evidence cases already in the suite. |
| 4. Context precision | **GO for tested contracts** | Memory and Context Planner tests passed. V2 additionally demonstrated scoped retrieval in the real planner and SQLite adapter. |
| 5. Continuity/compaction | **GO for exercised scenarios** | Pi runtime, compaction, pruning, and question-tool tests passed; Stop now reconciles queued prompts with the local orphan-run path after the upstream merge. |
| 6. Real quality comparison | **HOLD** | V2 repair/recall runners and offline checks are implemented. No provider/model was selected; actual repair, recall, latency, and usage are unknown. |
| 7. THX source inventory | **GO inventory / HOLD integration and utility** | Source ref and pins/evidence are attributable. Secure bootstrap denies launch; no Pi/Meta Controller observer exists on that ref. See [THX inventory](thx-shadow-source-inventory.md). |
| Payment → billing period association (A15) | **HOLD** | No authoritative link was established by this work; no billing changes were made. |

## Overall assessment

The offline Harness contracts and targeted regression suites are qualified on
this Linux VPS. The work does not demonstrate that the Modus made better
decisions: that requires live, comparable inference with a user-selected
provider/model and review of the nine-case v2 corpus separately from the original
seven. THX remains unavailable to the Harness, and real macOS signing remains a
platform-specific gate.

No PR, push, release, or remote CI run was performed.
