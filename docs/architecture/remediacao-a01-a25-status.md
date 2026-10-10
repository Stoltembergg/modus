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
- During the earlier A01/A02 local validation, an unfiltered plugin test run
  also executed the repository's synthetic symlink/junction test. It created a
  temporary junction and read only a synthetic fixture; it did not execute
  plugin code or access outside data. The CI workflow excludes the entire
  `adversarial bypass hardening` group, and the junction test was absent from
  its test output. That test will not be rerun under this authorization.

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

## Milestone 2 — A07–A09 broker fail-closed tightening

**Status: partial broker hardening implemented and locally checked; productive
authorization wiring and OS-level enforcement remain open.**

- A07 now resolves a path through its nearest existing ancestor before scope
  comparison, rejects missing targets below existing redirected or dangling
  symlink parents, and no longer falls back to lexical resolution for those
  cases. The canonicalization regressions use mocked filesystem metadata; they
  do not establish race-free enforcement against real path replacement. Since
  Node's current broker has no race-free, handle-relative filesystem backend,
  `readFile` and `writeFile` now fail closed after permission evaluation. No
  production consumer was found, and usable scoped filesystem I/O remains
  unavailable.
- A08 no longer accepts a caller-supplied `trustLevel: "core"` as network
  authority. The predicate canonicalizes bracketed and IPv4-mapped IPv6
  literals, identifies the IPv4 loopback range, blocks unspecified IPv4 and
  link-local IPv4 ranges, and retains explicit localhost/domain grants. Other
  private ranges and IPv6 metadata destinations are not comprehensively
  classified. These are predicate-only checks. DNS resolution/pinning, redirect
  validation, connection-level enforcement, and production wiring are absent;
  A08 remains open.
- A09 shell checks reject the tested shell-composition metacharacters and no
  longer accept caller-supplied core trust. When the shell allow-list includes
  `git`, direct recognized Git commands also require the matching explicit Git
  grant, including `.exe` names. Common shell interpreters and launchers such
  as `sh`, `bash`, `cmd`, `powershell`, `node`, and `python` are denied; this
  cannot identify arbitrary user-defined wrappers or aliases. An allowed
  executable may itself launch child processes or evaluate project scripts,
  so the launcher list is not a general execution boundary. The brokers have
  no production callsites; the shell API still accepts a command string, does
  not parse structured argv, and does not constrain the Git repository/resource.
  A09 is partially mitigated, not complete.

### Evidence

- RED: twelve regression tests reproduced missing-parent and dangling-link scope
  escapes, unsafe filesystem I/O availability, bracketed/mapped IPv6 loopback
  bypass, the rest of IPv4 loopback/unspecified/link-local ranges, shell
  composition and forged trust, interpreter/Git executable wrapper bypass,
  Git grant bypass through shell, and missing/forged Git operation grants.
- GREEN: thirteen selected tests passed (the twelve regressions plus the existing
  shell whitelist behavior check); only exact safe test names were selected,
  and the `adversarial bypass hardening` group was not executed.
- Desktop typecheck: passed, exit 0.
- Targeted Biome: passed with existing warnings/infos; no rules were disabled
  and no bulk formatting was applied.
- `git diff --check`: passed.
- Static callsite search found no production use of `FilesystemBroker`,
  `NetworkBroker`, `ShellBroker`, or `GitBroker` outside their definitions.

## A03/A04 boundary check — host-catalog ingress

**Status: partially mitigated; no safe boundary implementation is available in
this scope without disabling shipped Harness behavior.**

The productive `PiSdkRuntime` constructs its `PluginLoader` with the built-in
host catalog. The catalog authorizes the exact manifest object and the loader
derives trust from the catalog entry, so a cloned or self-declared `core`
manifest is rejected before provider registration or lifecycle hooks. A new
runtime-level regression test exercises that exact loader and confirms the
forged manifest's hook is never called. Existing capability-registry tests
cover unauthenticated same-ID replacement attempts, non-replaceable
capabilities, and provider-switch denial. The Pi SDK resource loader also uses
`noExtensions: true`; the extension-containment check passed in the remote CI
run for `ac8b50f`.

The remaining dispatcher and lifecycle calls are direct, same-process calls
for shipped catalogued built-ins. `PluginIsolationHost` now denies execution
and is not an OS executor, so routing the built-ins through it would stop core
Harness functionality without providing containment. Third-party manifests
remain unavailable through the production catalog. This does not prove
isolation against code already executing in the host process; A03/A04 remain
partially mitigated until a real external execution boundary and one authorized
dispatcher can be introduced and safely validated.

### Evidence

- Runtime path test: **1 passed**, **219 skipped** by the exact test-name
  filter. The synthetic forged manifest was rejected before its hook or
  provider implementation was invoked.
- Desktop typecheck: passed, exit 0. Targeted Biome: no errors; eight existing
  warnings remain in the large runtime test file. `git diff --check`: passed.
- Remote CI on `ac8b50f`: `typecheck · test · biome`, Verifier-First runtime
  regressions, plugin containment on Linux/macOS/Windows, and compile-only
  sandbox targets all passed; no probe was executed. The Supabase pgTAP job
  failed test 22 in `17_free_monthly_renewal.test.sql`: at 2026-10-10 it
  expected `2026-10-31` but received `2026-10-30` for the second monthly
  period end. The same failure was observed on the prior CI run at `fdefe34`;
  the test is outside the changed files and is not classified as pre-existing
  or unrelated without further evidence. On the subsequent `7cf22eb` run,
  Windows and macOS packaging passed, as did `typecheck · test · biome`,
  Verifier-First regressions, plugin containment on all three OSes, and the
  compile-only sandbox job. The Supabase pgTAP test 22 failed again with the
  same expected/actual dates. No blocked probe was run.

## Milestone 3 — A10–A14 lifecycle and dependency integrity

**Status: implemented and locally checked; independent review and remote CI
for this patch are pending.**

- A10 startup reconciliation now resolves the exact installed version from
  the host catalog, includes exact authorized preloaded manifests in the
  dependency graph, applies persisted non-enabled decisions before enabling
  plugins, and restores enabled records in dependency order. It validates
  dependencies even for an already active exact manifest and does not rerun
  `onEnable`. Missing or mismatched catalog artifacts are not silently treated
  as the installed executable version.
- A11 durable disable updates are serialized. If the database transaction
  fails after runtime deactivation, the old runtime is restored; if that
  restoration fails, the provider remains quarantined instead of appearing
  available with inconsistent durable state.
- A12 lifecycle operations share a queue keyed by their state-store instance,
  preventing concurrent updates to different plugin IDs from racing shared
  SQLite and dependency-graph state.
- A13 Safe Mode level and restore baseline are persisted. The gate is written
  before provider shutdown; disallowed providers are quarantined and disabled
  without invoking plugin callbacks. Manual disable removes a plugin from the
  restore baseline. Exit retains per-plugin pending restoration state, and
  startup resumes it in dependency order after interrupted restoration.
- A14 plugin and capability versions/ranges are validated with SemVer. Invalid
  ranges and unavailable providers fail closed. Install/upgrade preflight
  dependency graph cycles and direct dependent compatibility before changing
  durable state. Forced provider removal suspends transitive dependents before
  deleting the provider; a forced removal of a persisted cycle participant
  quarantines the cycle and preserves the remaining participants as errors.
  Re-enable remains blocked until an active compatible provider exists.

### Evidence

- RED/GREEN: regressions first failed for incompatible provider changes after
  restart, cycle-forming installs, malformed capability constraints, repeated
  `onEnable`, manual disable being undone by Safe Mode exit, interrupted Safe
  Mode entry/restore, competing lifecycle updates, and forced provider removal
  leaving active dependents. Startup regressions also reproduced preloaded
  disabled plugins remaining enabled and runtime-only dependency edges
  disappearing after graph rebuild. A restart test also reproduced an
  explicitly uninstalled built-in being recreated as enabled; adding the
  tombstone guard changed that test from failing to passing. Independent review
  then identified that force removal could not break an already persisted
  dependency cycle; the new synthetic restart test failed with that rejection
  and now passes after cycle-wide quarantine and explicit forced removal.
  Targeted fixes also cover disabled-provider/preloaded-dependent reconciliation
  and fresh-loader dependency restoration order.
- Targeted Vitest: **4 files, 137 tests passed** (`plugin.test.ts`,
  `plugin-lifecycle.test.ts`, `plugin-dependency.test.ts`, and
  `plugin-rollback.test.ts`). Tests use only synthetic in-process fixtures; no
  external plugin or adversarial probe ran.
- Desktop TypeScript typecheck: passed, exit 0.
- Targeted Biome on 11 changed TypeScript files: exit 0 with 57 warnings and 1
  info, and no errors after correcting one formatting diagnostic. Warning
  origins were not baseline-classified; no lint rule was disabled and no bulk
  formatting was applied.
- `git diff --check`: passed.
- Independent review: the initial pass identified startup dependency-order
  gaps and a forced-removal dead end for persisted cycles. The startup ordering
  and cycle-recovery fixes were reviewed again; the reviewer found no remaining
  concrete blocker. This was a static review and did not execute tests.
- Remote CI for the preceding published `7cf22eb` does not include this local
  lifecycle patch. Its core job and Windows/macOS packaging passed, while the
  Supabase pgTAP job failed test 22 as described above. This patch needs its
  own CI run after publication.
- Remaining limits: this does not create an OS execution boundary, prove
  crash-consistent external artifact deployment, or enable external plugins.
  Safe Mode is persisted in the existing plugin state database; full corruption
  and power-loss behavior beyond the injected restart fixtures is not proven.

## Current matrix

| Finding | Current status | Implementation state / next evidence |
|---|---|---|
| A01 | Partially mitigated | Facade fails closed; process isolation is absent. Audit every ingress; hostile execution proof remains blocked. |
| A02 | Partially mitigated | Facade no longer claims a timeout is containment; preemption/budgets remain absent. Do not run blocked loop probes. |
| A03 | Partially mitigated | Production loader uses exact host-catalog identity and host-derived trust; runtime test rejects forged manifests before hooks. Same-process provenance is not an isolation boundary. |
| A04 | Partially mitigated | Direct dispatch and hooks remain for catalogued built-ins; production loader blocks external manifests. A single OS-backed dispatcher and lifecycle boundary remain open. |
| A05 | Pending | WASM memory accounting and aggregate limits. |
| A06 | Prior fix preserved | Deny ungranted WASI imports; recheck static contracts without running enforcement probes. |
| A07 | Partially mitigated | Missing-path parent and dangling-link predicates are canonicalized; filesystem I/O fails closed without a race-free backend. No production consumer; scoped safe I/O and race proof remain open. |
| A08 | Partially mitigated | Caller trust override removed; bracketed/mapped IPv6 and selected local ranges are normalized by a predicate. DNS pinning, redirects, connection enforcement, and production wiring remain open. |
| A09 | Partially mitigated | Tested shell composition, common interpreter wrappers, forged trust, and direct Git operation grant bypasses are rejected. Arbitrary wrappers, structured argv, resource scoping, and production wiring remain open. |
| A10 | Mitigated | Startup uses exact host-catalog versions, reconciles disabled state before activation, and orders dependency restoration; external artifact identity remains unavailable. |
| A11 | Mitigated | Disable transaction rollback restores runtime or leaves provider quarantined; broader crash atomicity remains unproven. |
| A12 | Mitigated | Per-store lifecycle queue serializes shared DB/graph operations; stress/fault injection beyond targeted tests remains open. |
| A13 | Mitigated | Safe Mode state and restoration are durable and restartable; storage corruption/power-loss proof remains open. |
| A14 | Mitigated | SemVer constraints, active-provider checks, cycle preflight/recovery, and dependent suspension are covered; an OS boundary remains absent. |
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
