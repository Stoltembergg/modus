# A01–A25 remediation status

This is the rolling implementation record for the authorized remediation on
`work/windows-guardian-task4`. The consolidated audit in
[`auditoria-pos-fase19.md`](./auditoria-pos-fase19.md) remains the source for
the original evidence and finding definitions. A status of “mitigated” does
not mean that a security boundary has been certified; validation that requires
blocked hostile-plugin or enforcement scenarios remains explicitly pending.

## Baseline

- Starting commit: `684dd198e9e3d425ab99a87eeac89581c9b01652`.
- The PR branch was clean at that commit and the PR was Draft.
- A16, A17, A21.1–A21.6, A06, and A25 had relevant prior changes at the
  baseline. They are preserved and will not be reimplemented without evidence
  of a regression.
- No hostile plugin, root-resume, adversarial probe, or Guardian enforcement
  scenario is authorized by this remediation.

## Milestone 1 — A01/A02 in-process facade

**Status: implemented and locally checked; full boundary proof remains open.**

`PluginIsolationHost.executeIsolated()` and `executeWasm()` now always return a
structured denial and record it in the security audit log. They do not invoke
the supplied JavaScript callback, compile or instantiate the supplied WASM,
or accept a caller-provided trust label as execution authority. The lifecycle
service no longer exposes its in-process `WasmCapabilityHost` instance. This
prevents callers of these facades from mistaking same-process execution or a
`Promise.race` timeout for isolation or preemption.

The implementation does **not** add an OS process boundary, preemptible
execution, memory/CPU quotas, or prove that every code path is isolated. The
capability registry still dispatches its registered implementation directly;
the runtime currently constructs its loader with the host catalog. Separate
extension auto-loading and every capability ingress remain under review. A01
and A02 therefore remain **partially mitigated, not proven**. External plugin
execution remains unavailable through the changed facade.

### Evidence

- RED: before the guard, the community callback ran successfully; a forged
  `trustLevel: "core"` also caused the callback to run; and the lifecycle
  service exposed `getWasmHost()`.
- GREEN: focused tests assert the callback is never invoked, forged trust does
  not change the denial, WASM is denied and audited, and the lifecycle service
  does not expose the WASM executor.
- `plugin-isolation.test.ts` + `plugin-lifecycle.test.ts`: **57 tests passed**.
- An extended run of the three plugin/WASM test files completed **80/80**.
  This included a repository-authored synthetic WASM fuel fixture; it did not
  load external plugin code. That fixture will not be rerun under the current
  execution restrictions.
- Desktop typecheck: passed, exit 0.
- Targeted Biome: exit 0; reported existing warnings/infos in the inspected
  files. No rule was disabled and no bulk formatting was applied.
- `git diff --check`: passed.
- Independent read-only review: no blocking issue in this bounded patch. It
  confirmed there are no productive callsites of the isolation facade, built-in
  providers remain on their existing host-catalog path, and the current Pi
  `DefaultResourceLoader` sets `noExtensions: true`. The review also confirmed
  that `WasmCapabilityHost` remains exported and can execute arbitrary bytes if
  called directly by future host code; this patch does not certify or remove
  that utility.

## Current matrix

| Finding | Current status | Implementation state / next evidence |
|---|---|---|
| A01 | Partially mitigated | Facade fails closed; process isolation is absent. Audit every ingress; hostile execution proof remains blocked. |
| A02 | Partially mitigated | Facade no longer claims a timeout is containment; preemption/budgets remain absent. Do not run blocked loop probes. |
| A03 | Partially mitigated | Loader requires exact host-catalog manifests and the Pi loader sets `noExtensions: true`; registry authority still shares the host process, so provenance is not fully proven. |
| A04 | Pending validation | Registry and lifecycle invoke callbacks directly, but the productive loader uses the internal host catalog; keep external origins blocked and verify remaining provider-ingress calls. |
| A05 | Pending | WASM memory accounting and aggregate limits. |
| A06 | Prior fix preserved | Deny ungranted WASI imports; recheck static contracts without running enforcement probes. |
| A07 | Pending | Filesystem broker junction/TOCTOU handling. |
| A08 | Pending | Network resolution, rebinding, redirects, and IP policy. |
| A09 | Pending | Shell argv and Git deny-default grants. |
| A10 | Pending | Restart state versus executable artifact identity. |
| A11 | Pending | Atomic lifecycle rollback and runtime/database consistency. |
| A12 | Pending | Serialization and concurrent lifecycle operations. |
| A13 | Pending | Safe Mode independence and startup failure handling. |
| A14 | Pending | Dependency graph cycles, constraints, and dependent state. |
| A15 | Pending | Cancellation and child-resource cleanup. |
| A16 | Prior fix preserved | Explicit user-selected model identity and provider. |
| A17 | Prior fix preserved | Verification evidence integrity. |
| A18 | Pending | Group mailbox replay/ack consistency; keep distinct from the active group runtime. |
| A19 | Prior A21.4 implementation preserved | Spill authorization, persistence, quotas, and recovery. |
| A20 | Pending | Audit record integrity, bounds, and durability. |
| A21 | Prior A21.1–A21.6 implementation preserved | Harness integrations and lifecycle; no broad reimplementation. |
| A22 | Pending | Bounded event-history reads. |
| A23 | Pending | Synthetic built-in plugin services and their production claims. |
| A24 | Pending | WASM cache/resource bounds and truthful failure metrics. |
| A25 | Prior fix preserved | Workspace-scoped permissions. |

This matrix will be updated as each independent remediation is completed and
checked. No Checkpoint 2/3 or Guardian Task 5–7 status is changed here.
