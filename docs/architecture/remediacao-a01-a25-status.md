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

## Milestone 4 — A05 WASM memory accounting

**Status: host-side limits and accounting implemented; the external-plugin
execution boundary remains unavailable and adversarial enforcement proof is
blocked.**

`WasmCapabilityHost` now parses memory declarations from the already compiled
module bytes and rejects modules with no maximum, multiple memories, hidden
module-defined memory, unsupported memory64/shared memory, or an imported
memory outside the host-managed `env.memory` path. A defined memory's declared
maximum must fit the per-instance policy. Imported memory is created by the
host at the lesser of the configured cap and the module import maximum. The
host reserves the maximum possible page count before instantiation and enforces
an aggregate limit across live instances (defaults: 256 pages / 16 MiB per
instance and 1024 pages / 64 MiB aggregate). This is capacity reservation, not
an estimate of current resident memory.

`WasmPluginInstance` reports the actual currently allocated pages/bytes from
the tracked module memory. It no longer exposes the raw `WebAssembly.Instance`
or `WebAssembly.Memory`; runtime-private fields keep those references and the
reservation callback inaccessible even to JavaScript reflection. `dispose()`
clears the private references, disables wrapper operations and releases its
reservation. `executeWasm()` disposes in `finally`, and the CLI benchmark
releases its instance after use. Callers that use `createInstance()` directly
must call `dispose()` when done. The host currently has no production
external-plugin execution callsite: the isolation facade continues to deny
external execution, while the CLI uses the host for inspection/benchmarking.
The change therefore repairs the host's limits and metrics without claiming an
external execution boundary.

The input bytes are copied synchronously before the first await. Compilation,
memory inspection and policy checks therefore use one stable snapshot even if
the caller later mutates its original buffer. Failed calls report the live
instance's measured memory and fuel before `finally` disposes it. When a start
function traps before a module-defined memory can be observed, the result marks
`memoryUsageAvailable=false` instead of presenting zero as a measured value;
host-imported memory remains measurable after a failed start.

### Evidence

- RED: a synthetic module with one page of module-defined memory was paired
  with a two-page configured host memory. The test failed because the instance
  reported a different memory object than the module actually used.
- Independent review found that caller mutation between async compilation and
  inspection could make the checked bytes differ from the compiled module, and
  that failed calls lost real memory metrics. Both regressions were reproduced
  RED and fixed; a delayed compile fixture changes the original input after
  compilation starts and confirms the host still rejects the over-cap module.
- A second review found runtime-accessible TypeScript-private references could
  release a reservation early, and start-function traps lost imported-memory
  measurements. Memory, instance and release callback now use JavaScript
  private fields; a bounded synthetic start fixture reproduces the missing
  measurement RED and passes after the failure metric is carried to the result.
- GREEN: the regression now observes the module's actual one-page initial
  footprint and growth to two pages. Additional tests cover per-module cap
  rejection, missing maximum rejection, imported memory, aggregate reservation,
  disposal, snapshot integrity, failure metrics, and `executeWasm()` release
  after an invocation failure.
- Safe targeted Vitest: **1 file, 15 passed, 16 skipped** using the `19.1`,
  `19.2`, and `Linear Memory Bounds & Isolation` name filter. The skipped tests
  include the explicit fuel-enforcement cases; no blocked probe ran.
- Desktop TypeScript typecheck: passed, exit 0.
- Targeted Biome: exit 0 with **5 warnings**, all at existing diagnostics in
  `plugin-cli.ts`, `wasm-capability-host.ts`, and the legacy sandbox test import;
  no new errors. No rule was disabled.
- `git diff --check`: passed.
- Independent review: three read-only passes found the mutable-buffer
  mismatch, failed-call metrics, runtime-accessible references, failed-start
  metrics, and a retained reservation callback after disposal. These were
  fixed before the final pass, which found no blocking defect and confirmed
  direct test instances and the CLI benchmark release their reservations.
- A later read-only review identified a returned callable WASM function
  reference that could outlive `dispose()` after reservation release, and
  function references that custom host imports could retain. Returned
  references now receive the same 10-unit invocation charge as direct calls;
  `dispose()` clears their targets before releasing the reservation. Custom
  host-import wrappers reject callable arguments and object-valued callback
  results. Host imports reject tables, exception tags, and nullable or
  object/function-valued globals because those reference containers cannot
  otherwise be safely revoked. Brand checks use built-in internal-slot
  accessors so values from a different JavaScript realm are also recognized.
  Custom `env` imports cannot replace the host's fuel-meter functions.
- RED/GREEN: the returned-reference test first failed because the wrappers did
  not charge fuel. Host-boundary tests first failed because callbacks received
  function references or reference containers were accepted, including an
  exception tag configured to carry a function reference. All pass after the
  fixes, while a numeric host import remains usable. The returned-reference
  fixture uses a synthetic `WebAssembly.Instance` shape; boundary fixtures are
  internally generated and compile-only where they exercise exception tags.
  Cross-realm cases use `node:vm`-created memory, table, global, and tag
  objects. No external plugin code or adversarial probe was run.
- A re-review found two additional lifecycle gaps: `dispose()` could release a
  reservation while a reentrant export was still on the stack, and the JSON
  adapter called `alloc`/`dealloc` exports directly without the shared fuel
  accounting. Active export frames now defer resource cleanup until they unwind
  and discard any result produced after reentrant disposal; JSON allocation and
  cleanup exports now use the common metered invocation path. Both regression
  tests failed before their fixes and pass afterward.
- The final independent review found that an object-valued `externref` global
  could expose a host `WebAssembly.Memory` through a guest return, and a custom
  host import could return an object reference through an export. Generated
  finite modules reproduced both paths. The host now rejects nullable and
  object/function-valued imported globals and object-valued callback results;
  the instance wrapper also rejects object-valued results recursively while
  retaining scalar values and guarded function references. The regressions
  failed before the guards and pass afterward.
- Safe targeted Vitest follow-up: **21 passed, 22 skipped** across bounded
  memory, snapshot, invocation-failure, disposal, callable-reference fuel and
  host-import boundary cases, including reentrant disposal, metered JSON helpers
  and object-valued externref rejection. It excluded start-trap, runaway
  fuel-enforcement and adversarial tests; the finite fuel-accounting test passed.
- Targeted Biome and `git diff --check` pass. Biome reports one unchanged
  warning for the unused `TIn` parameter in `executeWasm`; the same line exists
  in the HEAD before this follow-up. No rule was disabled.
- Full `npm run check`: exit 0. Biome scanned 1,136 files with 363 warnings and
  49 infos, and no errors; the desktop TypeScript typecheck completed without
  diagnostics.
- Remote CI on `ed00347` passed `typecheck · test · biome`, Verifier-First
  runtime regressions, compile-only sandbox targets, plugin containment on
  Linux/macOS/Windows, Windows x64 packaging, and macOS x64/arm64 packaging.
  Supabase pgTAP again failed test 22 with expected `2026-10-31` and actual
  `2026-10-30`.
- Residual limits: only core 32-bit, non-shared memories with a maximum and an
  observable export are accepted; object-valued `externref` imports/exports are
  intentionally unsupported, and no non-test host-import callsite uses them.
  Current memory metrics do not report process RSS. No external plugin,
  enforcement probe, or blocked hostile scenario was run, so A05 is not a proof
  of isolation or whole-process memory containment.

## Milestone 5 — A15 run cancellation and managed-process cleanup

**Status: cooperative cancellation and run-scoped cleanup implemented; hard
preemption of non-cooperative in-process work remains unproven.**

The root cause was split across the runtime and process APIs: `PiSdkRuntime.abort`
aborted the Pi session and descendant sessions but did not clean root-run
processes; process records had session identity but no owning run identity; the
process facade requires a session scope when listing agent processes; and
`terminal_run` omitted the Pi cancellation signal for background launches.
`launch_app` and capability instrumentation also did not accept the signal;
after those APIs accepted it, the immutable provider wrapper in the capability
registry still discarded it.

The runtime now queries and terminates managed agent processes with both the
active `sessionId` and `runId`, leaving older runs, other sessions, and user
processes untouched. Terminal and app records carry the creating `runId` into
the existing managed-process facade. Terminal foreground/background readiness,
port/HTTP waits, and app launch verification observe the tool signal; cancellation
requests termination of only the process owned by that call and avoids recording
an app launch as successful. Pi's signal now reaches these productive tool
paths. Capability implementations receive the cooperative `AbortSignal` through
the registry wrapper; a timeout aborts and drains cooperative work before
returning, and traces record cancelled separately from failure. Observer events
and aggregates now retain a separate cancellation event/count instead of
counting cancellation as a plugin failure.

### Evidence

- RED: the runtime abort regression failed because its process query omitted
  `sessionId`; the process map's scope rule would therefore return no agent
  processes. Adding the session to the regression made the missing scope
  observable before changing the cleanup query. GREEN: it now requests the
  exact session/run pair and terminates only the matching agent process.
- RED: the tool registration regression observed no `AbortSignal` in
  `runAgentCommand` for a background call. GREEN: the Pi tool now passes the
  signal and run identity; a synthetic PTY-host protocol test confirms an
  aborted background call sends `kill` and records the terminal as exited.
- RED/GREEN: the app launch cancellation fixture first returned a live detached
  process after abort; it now rejects with `AbortError` and leaves no app record.
  This test runs only a benign local Node timer fixture and cleans it in `finally`.
- RED/GREEN: cooperative capability timeout tests show the callback receives
  an aborted signal and settles before timeout returns. The registry-wrapper
  regression first reproduced that an explicitly supplied signal arrived as
  `undefined`; forwarding it through the immutable wrapper made the test pass.
  A separate cancellation regression initially recorded
  `harness.plugin.failed`; it now emits `harness.plugin.cancelled`, increments
  `cancellationCount`, and leaves `failureCount` unchanged.
- Targeted Vitest: runtime cancellation and replacement-run race **2 passed**
  (220 name-filtered tests skipped); terminal tools **7 passed**; synthetic
  terminal service **1 passed**; plugin tracing **20 passed**; observer metrics
  **27 passed**; app-process cancellation/cleanup **3 passed** (1 skipped);
  process-map tests **16 passed**; registry signal propagation **1 passed**
  (23 name-filtered tests skipped). No adversarial probe or external plugin
  code was run.
- Desktop TypeScript typecheck: passed, exit 0. Targeted Biome on the original
  A15 patch exited 0 with **19 warnings and 1 info**; the follow-up registry
  files exited 0 with **14 warnings and 1 info**; no errors, rules disabled, or
  indiscriminate formatting. `git diff --check`: passed.
- Independent review first identified the run replacement race, early detached
  app cancellation path, and non-cooperative timeout limitation. The first two
  were fixed with RED/GREEN regressions; a second pass found no remaining
  concrete blocker. The reviewer confirmed that non-cooperative in-process
  callbacks remain a limitation, as documented above. A separate read-only
  review of the registry signal follow-up found no blocker. CI run `38021481027`
  on `881b974` and run `38021720040` on `6f59b7e` passed
  `verifier-first runtime regressions`, plugin containment on Linux/macOS/Windows,
  sandbox compile-only, and the main typecheck/Biome/Test job. The Supabase SQL
  job failed test 22 in `17_free_monthly_renewal.test.sql` (expected 2026-10-31,
  got 2026-10-30); the same failure appeared at `ed00347` and remains unresolved.
  Windows and macOS packaging for `6f59b7e` are still running.

### Limits

JavaScript cannot forcibly preempt a same-thread callback that ignores its
signal. Instrumentation waits for cancellation-aware work to settle, so a
non-cooperative callback can delay timeout completion. External/untrusted
plugin execution remains denied by the A01/A02 facade; no hostile callback or
enforcement test was run. Terminal-host termination is an asynchronous kill
request, and OS-level process-tree cleanup is only directly exercised for the
benign app process fixture. A15 therefore remains **partially mitigated**, not
a proof of hard preemption or a general containment boundary.

## Milestone 6 — A20 durable security audit records

**Status: bounded durable chain implemented; protection from a process with
direct access to the application database remains unproven.**

The root cause was that `SecurityAuditLogger` kept the chain only in a mutable
array. `getEntries()` returned references into that array, `clear()` erased the
chain, and runtime initialization constructed a separate logger instance rather
than reusing one durable host-owned service.

The logger now persists its ordered events and chain checkpoint in the
application's existing SQLite database. Restart hydrates the retained entries
and verifies the links, payload hashes, sequence numbers, and checkpoint. The
retained chain is bounded to at most 10,000 entries, each serialized input is
limited to 8 KiB, and old rows are pruned transactionally while their last hash
becomes the next retained chain's checkpoint. Append failures throw and do not
produce an in-memory success record. Returned entries are frozen snapshots;
the public `clear()` operation was removed. `PiSdkRuntime` now uses the existing
singleton logger when the isolation feature is enabled.

### Evidence

- RED/GREEN: the snapshot regression initially mutated a returned record and
  `verifyChain()` then failed. It now rejects mutation, preserves the original
  resource, and leaves the chain valid.
- SQLite fixtures verify restart hydration, bounded retention and checkpoint
  verification, no success when persistence is unavailable, rejection of
  oversize records, and detection of a persisted payload change followed by
  refusal to append. A separate RED/GREEN fixture changed a persisted event ID;
  IDs and sequence numbers are now included in each hash. Tamper fixtures use a
  temporary SQLite file and a second connection. The logger detects
  other-connection commits with `PRAGMA data_version` and verifies the chain
  before append; explicit verification reads a consistent SQLite snapshot. No
  plugin or enforcement scenario ran.
- A runtime integration fixture enables the existing isolation flag, invokes
  the production denial facade with a synthetic callback, confirms the callback
  is not called, then reconstructs the singleton and verifies its persisted
  record. This proves wiring through `PiSdkRuntime` without executing plugin
  code.
- Targeted Vitest: `plugin-isolation.test.ts` audit and runtime cases **10
  passed** (35 filtered); denied WASM facade audit integration **1 passed**
  (30 filtered).
- Desktop TypeScript typecheck: passed, exit 0. Targeted Biome check: exit 0
  with **4 warnings and 5 infos** in the selected files; all reported
  locations are outside the A20 hunks. No rules were disabled and no broad
  formatting ran. `git diff --check`: passed.
- Independent review caught reprocessing the retained chain on every append and
  missing record IDs in the hash; the implementation was bounded with SQLite
  `data_version`, the ID regression went RED/GREEN, and final follow-up found no
  remaining blocker. Remote CI remains pending publication.

### Limits

The logger verifies the persisted chain on startup and explicit verification;
before append it rechecks the chain when `PRAGMA data_version` shows a commit
from another SQLite connection. A direct writer using the logger's own
connection can bypass that version signal, and the hash chain is not a
signature or separate trust anchor: a process with write access to both the
SQLite events and checkpoint can rewrite them consistently. The current
isolation facade still denies untrusted plugin execution, and this patch does
not claim tamper resistance against host-process compromise or establish an OS
boundary.

## Milestone 7 — A24 WASM cache bounds and measurement truthfulness

**Status: cache retention is bounded and cache counters are explicit; WASI
output capture remains unavailable while the host denies WASI imports.**

The compiled-module cache was an unbounded `Map`. `WasmCapabilityHost` now
maintains it as an LRU with a default cap of 64 compiled modules and 16 MiB of
aggregate source-WASM byte accounting. An individual source larger than the
configured byte budget is compiled for the current call but is not retained;
setting either cache limit to zero disables retention. `clearCache()` releases
all entries and resets the counters. The counters report cache entries and the
source byte sizes represented by those entries. They do not report V8's native
compiled-module footprint, which Node does not expose, and the byte accounting
is an admission/retention bound rather than a heap measurement.

A05's preceding memory work also corrected failure metrics: consumed fuel is
read from the live instance on invocation failures, measured memory is retained
when available, and unavailable memory is marked as unavailable instead of
being reported as measured zero.

Caller-provided cache namespaces are SHA-256 hashed before entering the map, so
long plugin identifiers do not bypass the fixed-length cache-key bound.

`WasiSandbox` still has output arrays that are not connected to WASI
`fd_write`. The production host rejects all WASI imports before instantiation
because there is no grant-backed policy for WASI capabilities, and no
non-test production callsite constructs `WasiSandbox`. I left this capability
disabled and did not present empty buffers as captured output. Integrating
stdio requires an authorized host policy and a bounded, verified descriptor
implementation; A24 remains partial until that work is safe to enable.

### Evidence

- RED: before the cache change, two bounded-cache tests failed because
  repeated compilation returned the same retained modules after the entry or
  byte limits should have prevented retention. A temporary mutation removing
  aggregate-byte eviction also failed with 136 represented bytes against a
  135-byte cap.
- GREEN: the targeted WASM Vitest selection passed **4/4** for LRU eviction,
  oversized module non-retention, aggregate byte eviction, hashed cache-key
  storage and their reported counters. These use the repository's small
  generated WASM fixtures; no external plugin, WASI module, enforcement probe,
  or adversarial fixture ran.
- At the pre-A24 commit `7645530`, remote CI Biome and TypeScript steps passed,
  while Vitest reported **4,505 passed, 8 skipped, 1 failed**: the unchanged
  `FastVectorDistance` `< 0.1ms` timing assertion measured
  `0.105466999999976ms`. Running that test alone locally measured
  `0.11810399999990295ms` and failed the same assertion. Its implementation,
  assertion and threshold match the initial reference commit; this is an
  unresolved test/implementation issue and is not attributed to A24.
  The separate pgTAP run reported **1,021 passed and 1 failed** of 1,022: test
  22 expected `2026-10-31` and received `2026-10-30`. That billing test is
  outside A24 and was not modified. macOS x64/arm64 and Windows x64 packaging,
  plugin-containment on Linux/macOS/Windows, Verifier-First regressions, and
  compile-only sandbox targets passed on that commit. CI for this A24 patch will
  be recorded after push.
- The post-namespace-hash `npm run check` completed successfully: Biome checked
  1,136 files with **0 errors, 363 warnings, and 50 informational diagnostics**,
  then all configured workspace TypeScript checks exited 0. No diagnostics were
  auto-fixed. The focused Vitest selection passed **4/4** (43 unrelated tests
  skipped).
- Independent review found that an unbounded caller-supplied namespace string
  could remain in a cache key. A 64 KiB synthetic namespace test failed first;
  hashing the namespace made it pass. The final independent review found no
  blocker in the bounded cache change. Hashing a very long namespace still
  takes transient time proportional to its input length, but that input is not
  retained by the cache.

### Limits

The cache entry count and source-byte accounting bound retained module count
and the sum of source sizes represented by those entries, not the compiled
machine-code memory V8 retains. A too-large input is still compiled once for
the current request, so this does not cap transient compile memory. WASI output
is not captured or made available; the grantless host denial remains intact.

## Current matrix

| Finding | Current status | Implementation state / next evidence |
|---|---|---|
| A01 | Partially mitigated | Facade fails closed; process isolation is absent. Audit every ingress; hostile execution proof remains blocked. |
| A02 | Partially mitigated | Facade no longer claims a timeout is containment; preemption/budgets remain absent. Do not run blocked loop probes. |
| A03 | Partially mitigated | Production loader uses exact host-catalog identity and host-derived trust; runtime test rejects forged manifests before hooks. Same-process provenance is not an isolation boundary. |
| A04 | Partially mitigated | Direct dispatch and hooks remain for catalogued built-ins; production loader blocks external manifests. A single OS-backed dispatcher and lifecycle boundary remain open. |
| A05 | Partially mitigated | `WasmCapabilityHost` validates a single bounded memory, reserves per-instance/aggregate maximum capacity, reports actual live memory, charges returned callable and JSON helper calls, defers reservation release until active exports unwind, invalidates returned callables on disposal, recognizes cross-realm resources, rejects object-valued globals/callback returns/exports and blocks function-reference escape through host imports/tables/tags/globals, and keeps fuel imports host-owned; external plugin wiring and blocked enforcement proof remain unavailable. |
| A06 | Prior fix preserved | Deny ungranted WASI imports; recheck static contracts without running enforcement probes. |
| A07 | Partially mitigated | Missing-path parent and dangling-link predicates are canonicalized; filesystem I/O fails closed without a race-free backend. No production consumer; scoped safe I/O and race proof remain open. |
| A08 | Partially mitigated | Caller trust override removed; bracketed/mapped IPv6 and selected local ranges are normalized by a predicate. DNS pinning, redirects, connection enforcement, and production wiring remain open. |
| A09 | Partially mitigated | Tested shell composition, common interpreter wrappers, forged trust, and direct Git operation grant bypasses are rejected. Arbitrary wrappers, structured argv, resource scoping, and production wiring remain open. |
| A10 | Mitigated | Startup uses exact host-catalog versions, reconciles disabled state before activation, and orders dependency restoration; external artifact identity remains unavailable. |
| A11 | Mitigated | Disable transaction rollback restores runtime or leaves provider quarantined; broader crash atomicity remains unproven. |
| A12 | Mitigated | Per-store lifecycle queue serializes shared DB/graph operations; stress/fault injection beyond targeted tests remains open. |
| A13 | Mitigated | Safe Mode state and restoration are durable and restartable; storage corruption/power-loss proof remains open. |
| A14 | Mitigated | SemVer constraints, active-provider checks, cycle preflight/recovery, and dependent suspension are covered; an OS boundary remains absent. |
| A15 | Partially mitigated | Pi cancellation propagates to terminal/app launches; active root-run agent processes are selected by session+run and cancelled, and cancellation telemetry is distinct. Non-cooperative in-process work and hard OS preemption remain unproven. |
| A16 | Prior fix preserved | Explicit user-selected model identity and provider. |
| A17 | Prior fix preserved | Verification evidence integrity. |
| A18 | Pending | Group mailbox replay/ack consistency; keep distinct from the active group runtime. |
| A19 | Prior A21.4 implementation preserved | Spill authorization, persistence, quotas, and recovery. |
| A20 | Partially mitigated | Audit events and checkpoints persist in SQLite; immutable snapshots, transactional retention and verification detect ordinary record changes. No independent signing key or database access boundary exists. |
| A21 | Prior A21.1–A21.6 implementation preserved | Harness integrations and lifecycle; no broad reimplementation. |
| A22 | Pending | Bounded event-history reads. |
| A23 | Pending | Synthetic built-in plugin services and their production claims. |
| A24 | Partially mitigated | Compiled-module cache has LRU entry/source-byte caps and hashes caller namespaces; cache counters do not measure native compiled memory. A05 supplies measured failure metrics. WASI remains denied and stdio capture is unavailable. |
| A25 | Prior fix preserved | Workspace-scoped permissions. |

This matrix will be updated as each independent remediation is completed and
checked. No Checkpoint 2/3 or Guardian Task 5–7 status is changed here.
