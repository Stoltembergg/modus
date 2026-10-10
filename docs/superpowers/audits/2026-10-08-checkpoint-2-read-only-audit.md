# Checkpoint 2 Read-Only Audit

**Date:** 2026-10-08

## Disposition

**Checkpoint 2 remains HOLD.** Tasks 3 and 4 PASS only narrowly; those results do not prove enforcement. Tasks 5–7, scenario execution, external plugin execution, root resume, and production integration remain unauthorized. Windows, Linux, and macOS remain **NO_GO** wherever the required evidence is absent.

This document is a read-only audit of the findings listed below. It is **not operational Guardian evidence** and is **not evidence of Windows enforcement across the eight scenarios**. No audit finding below should be read as authorization to execute scenarios or plugins.

## Scope

This audit records the supplied read-only findings for the desktop/harness and sandbox/CI, along with stated PR-preparation verification. It does not inspect or reconcile other scopes, alter plans or trackers, or run tests, scenarios, probes, or workflows.

## Findings

### Desktop and harness

- **P1 — Read-only intent is dropped for subagents.** `apps/desktop/src/main/agent/pi-sdk-runtime.ts:956–965` hard-codes `readOnly: false` instead of forwarding `SubagentSpawnInput.readOnly` (`harness/subagents/subagent-provider.ts:19`). Native dispatch may create writable worktrees (`pi-sdk-runtime.ts:4001–4017`).
- **P1 — Built-in plugin state may not persist across restart.** Built-ins are unconditionally loaded/enabled (`harness/plugin/bootstrap.ts:43–47`); startup synchronization processes only durable records in the enabled state (`pi-sdk-runtime.ts:886–890`; `plugin-lifecycle-service.ts:492–493`). Disabled, errored, or quarantined built-ins may therefore be re-enabled after restart.
- **P1/P2 — Group routing substitutes tool names for capability metadata.** `apps/desktop/src/main/groups/group-capability-router.ts:79–94` can accept a research member without network tools and reject custom tools with read/write capabilities unless their names are `read`, `edit`, or `write`. The existing policy/helper/tests were removed.
- **P1 — Permission checks have canonicalization and symlink-parent risks.** In `harness/plugin/permission-brokers.ts:33–38,50–74,136–152,190–192`, credential checks precede canonicalization, permitting aliases; lexical fallback for a nonexistent target may permit writes through a symlink parent.
- **P1/P2 — Group mailbox permits cross-group operations and has bounded/in-memory state.** `harness/groups/group-mailbox.ts:108–109,146,268–276,303–309,419–432` and `tools/group-mailbox-tools.ts:102–107,235–243` allow group-crossing broadcasts/arbitrary group overrides; acknowledgements and evictions are memory-only; hydration caps at the oldest 20k.
- **P2 — Hook composition can discard or overwrite state.** `harness/kernel/harness-kernel.ts:86`; prompt output `finalSystemPrompt` is discarded when response reads `basePrompt` (`kernel/prompt-hook.ts:96–103`; `response/response-hooks.ts:34–45,62–75`); group hooks read `requestedTools` and lose prior tools (`groups/group-hooks.ts:111–130`); observability/response hooks can overwrite continuation (`observability/observability-hooks.ts:24–30`; `response/response-hooks.ts:106–108,144`). These hooks are not wired into the actual runtime; the current E2E test uses synthetic pass-through hooks.
- **P2 — Lifecycle/health signals are incomplete.** The lifecycle graph is not rebuilt at startup (`plugin-lifecycle-service.ts:48,488–545`); instrumentation is constructed but not attached (`pi-sdk-runtime.ts:870–874`; `capability-registry.ts:355–356`); health may report healthy with no traces (`plugin-health-monitor.ts:23–33`); recovery managers lack a monitor (`plugin-lifecycle-service.ts:98–113`).
- **P2 — Spill-storage limits and retrieval checks are not enforced.** An oversized entry can exceed the budget, and retrieval does not validate session or expiry (`harness/tools/tool-result-storage.ts:143–167,182–207`; `tools/spill-tools.ts:42–48`). Spill tools are not currently registered.
- **Dormant/non-blocking until exposed — Isolation does not establish hostile-code containment.** The plugin isolation host executes callbacks in the Electron host (`harness/plugin/plugin-isolation-host.ts:127–144`); same-thread timeout cannot interrupt a synchronous loop and async work persists. WASM fuel is cooperative and module-defined memory is not limited (`wasm-instance.ts:63–66`; `wasm-capability-host.ts:128–138,171–182`). Existing tests do not prove hostile containment.

### Sandbox and CI

- **P1 — Unconditional worker joins can prevent reaper exercise.** `crates/plugin-sandbox-probe/tests/windows_runtime_native.rs:2660–2662` joins after bounded receive and before independent reap; another direct join precedes reap at `:2884–2888`. Either can hang the lifecycle test.
- **P1 — Probe gating changed during PR preparation; it is not lifecycle acceptance.** In the earlier reviewed workflow state, `.github/workflows/plugin-sandbox-probe-windows.yml:31–43` had an `if: always()` metadata-plus-live-probe sequence. A separately authorized safe-draft preparation subsequently placed the only `--probe` call at line 48 behind the step condition `github.event_name == 'workflow_dispatch' && success()` at line 45. Metadata remains `always()` at line 32 and upload remains `always()` at line 68. Static YAML parsing and gate checking passed. No workflow or probe was executed. This is a PR-preparation safeguard, not lifecycle acceptance.
- **P2 — Guardian protocol allows impossible pre-root failure stages.** `tests/windows_runtime_native/guardian.rs:476–485` permits these stages with root-created, although setup stages precede root (`native.rs:1467–1618`; adoption at `:1659–1662`).
- **P2 — Process-limit status overstates evidence.** `src/platform/windows.rs:60–67` reports the process limit as Configured despite no launch/runtime and no process-limit Job configuration evidence. Overall result remains NO_GO.
- **P2 — Guardian/platform evidence and enforcement remain incomplete.** Guardian runtime is absent; Tasks 5–7 are planned (`docs/superpowers/plans/2026-10-08-windows-test-guardian-implementation.md:200–238`). Metadata records `Windows_NT` and architecture, not product/build. Dedicated workflows are path-filtered, not unconditional PR gates. Linux performs no worker execution (`linux.rs:5–15,37–41`); macOS is unsupported/NO_GO. Strict RSS/general handle quotas are unsupported and CPU is deferred (`windows.rs:45–57`). There is no production plugin/WASM ingestion; report serialization enforces NO_GO/no plugin bytes (`report.rs:657–659`).
- **Planning records are inconsistent; not reconciled here.** The main isolation plan allows Task 3 to begin (`docs/superpowers/plans/2026-10-07-plugin-execution-isolation.md:96`), while the tracker lags with Task 3 HOLD/Task 4 blocked (`.slim/deepwork/plugin-execution-isolation.md:148`) despite a newer tracker table recording narrow passes (`:104`). Plans and tracker were not edited.

## Evidence and limitations

- The findings above are supplied read-only static findings and are not a fresh validation, runtime demonstration, or proof that a reported risk has been fixed.
- Tasks 3 and 4 pass narrowly only; they do not establish enforcement. Tasks 5–7, scenario execution, external plugin execution, root resume, and production integration are unauthorized. No platform should be treated as GO without the absent evidence.
- The workflow probe-gating change is the sole stated change. Its static YAML parse/gate check passed; no workflow or probe ran. It does not establish lifecycle acceptance.
- No tests, scenarios, probes, or additional inspections were run for this audit.

## PR-preparation notes

Reported separately from this read-only audit: `npm run test` observed 71 failures and 4,089 passes; `npm run check` observed 1,129 diagnostics; desktop build passed; `npm --workspace @modus/desktop run typecheck` passed; `cargo check --locked --workspace --all-targets` passed with warnings. These results are not Checkpoint 2 authorization or evidence.

The personal-data test `apps/desktop/src/main/agent/real-sessions-baseline.test.ts` and derived report `docs/architecture/modus-real-sessions-baseline-analysis.md` are explicitly excluded from the public PR but remain local.
