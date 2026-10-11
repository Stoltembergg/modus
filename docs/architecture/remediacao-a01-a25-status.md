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

## A01–A04 — shared process protocol foundation

**Status: shared protocol and opaque admission prerequisite implemented; no
productive executor integration or security proof.** The new
`modus-plugin-execution-protocol` workspace crate defines the length-prefixed
JSON worker envelope, strict message schemas, a per-worker handshake/sequence
dispatcher, host-owned provenance, exact capability grants, bounded results,
and close-on-protocol-error behavior. Its dedicated CI job executes only this
crate’s safe unit fixtures.

- RED: CI run `38077266288`, job `114286746069`, showed the baseline decoder
  accepted both a frame above 256 KiB and a guest-supplied `plugin_id` field.
- Independent review found that escaped control characters could make a
  failure response exceed the 64 KiB serialized-result limit while its source
  string remained under the limit. A fixed synthetic newline fixture
  reproduced this before the correction; completion now rejects the encoded
  result and closes the generation, and host-frame decoding enforces the same
  serialized-byte limit. Review also found that outbound serialization could
  allocate an oversized temporary buffer before applying the frame/result cap;
  the shared serializer now writes into a byte-limited buffer and stops when
  the configured ceiling is reached.
- GREEN: local `cargo test --locked -p modus-plugin-execution-protocol` on
  Rust 1.85.1 passed **14/14** synthetic protocol and fixed-policy tests.
  Follow-up RED runs caught missing 100 ms cooperative-cancel and 2 s
  kill/reap ceilings, and showed the prior encoder/decoder could accept a
  256 KiB payload plus a four-byte header. The shared policy now records both
  cleanup limits, and the frame ceiling counts the header in the 256 KiB cap.
  Rustfmt 1.85.1 and `git diff --check` passed. Remote CI for this follow-up is
  recorded below for commit `f3102af`.
- Independent static review found no further protocol-schema or handshake
  blocker. It explicitly confirmed that `close()` cannot revoke an invocation
  already returned to a future asynchronous caller; any real dispatcher must
  recheck cancellation and run generation before side effects. No such caller
  is integrated yet.

The shared `resource_policy` module now records the existing approved ceilings
for artifacts, IPC/results, output, WASM memory, helper RSS, aggregate memory,
fuel, one-core CPU, timeouts, cancellation grace, reap deadline, hostcalls,
pending requests, helper concurrency, guest children, and handles/file
descriptors. The IPC-related values reuse the codec constants so they cannot
drift, and `MAX_IPC_FRAME_BYTES` includes the length prefix. Fixed-value tests
failed RED when the artifact cap was zero and when cancel/reap limits were
missing; both now match the approved values. The protocol plus policy crate
tests pass **14/14** locally. This is a policy contract, not enforcement: no
platform adapter or runtime gate consumes it yet. In particular the Linux cgroup
memory ceiling is not the required RSS ceiling, and the reviewed Windows
mechanisms do not enforce the required general handle cap or strict RSS; no
macOS adapter is present. All three platforms therefore remain blocked for
external execution.

Platform split for the next executor tranche:

| Platform | Existing component | Verified gap | Admission state |
|---|---|---|---|
| Linux | `plugin-sandbox-probe/src/platform/linux.rs` performs read-only cgroup/namespace preflight. | No child process is placed into a configured policy; `memory.max` is not treated as proof of the approved RSS-only ceiling; no installed and verified seccomp/Landlock policy or bounded reap path. | External worker denied. A production adapter must require delegated cgroup v2 controls, install the complete policy before exec, and fail closed when any controller or reap guarantee is missing. |
| Windows | `plugin-sandbox-probe/src/platform/windows.rs` reports diagnostic Job Object and process-tree evidence. | Job memory limits constrain commit rather than strict RSS; no tamper-resistant general kernel-handle cap of 64; diagnostic tree handling is not an integrated worker lifecycle supervisor. | External worker denied. A production adapter must enforce the exact RSS and handle ceilings, own the process tree, and meet the termination/reap deadline before admission. |
| macOS | No process-isolation adapter is present. | No supported mechanism has been implemented and reviewed against the full shared policy. | External worker denied. The adapter must meet every shared limit and preemptible process-tree cleanup before admission. |

The shared protocol and dispatcher remain platform-neutral and testable with
synthetic frames. The platform rows above are separate from the trusted
in-process HostPluginCatalog path; they do not disable built-in Harness
plugins, Pi-owned extension factories, or existing trusted providers.

No external-plugin child process is launched and no plugin/WASM bytes are
handled by an executor; no OS adapter or Pi SDK callsite was added. The worker
message has no `plugin_id` field; the dispatcher copies identity from the
host-bound session. Windows, Linux, and macOS enforcement of the shared policy
and preemptible process-tree termination remain unimplemented. External plugin
execution stays blocked, while built-in Harness execution remains on the
existing trusted host-catalog path.

#### Current A01–A04 source-only recheck

The current desktop dependency graph still does not include
`modus-plugin-execution-protocol`; the dispatcher and resource policy remain
library contracts. `PluginIsolationHost` denies external JavaScript/WASM
execution but is not the executor for trusted built-ins. Trusted catalogued
providers and lifecycle callbacks still execute in the host process, so the
existing Harness path must remain available during migration. Linux remains a
read-only preflight, Windows diagnostics do not establish the approved RSS and
handle limits, and no macOS adapter exists. No process probes or enforcement
tests were run. The platform source work can proceed independently, but the
external-worker admission gate remains closed everywhere until each adapter
implements and proves the complete policy. This is an implementation and
evidence gap, not a claim that unavailable hostile tests alone block an
otherwise complete executor.

The next A03 increment extends host-only provenance with exact plugin version,
artifact origin, catalog-resolved trust level, session id, and workspace id in
addition to digest, run, and generation. All remain absent from guest frames;
the constructor rejects empty or oversized scope/identity values. RED/GREEN:
the strict-frame regression failed when `deny_unknown_fields` was temporarily
removed, and the provenance test failed when session validation was removed;
the full protocol crate then passed **15/15**. Independent read-only review
found no concrete bypass or regression. Repository search found no production
constructor or dispatcher caller, so this is a host-side contract only and not
productive provenance wiring.

The next A01/A02 increment adds bounded length-prefixed ingress through
`Dispatcher::receive_from_until`: the parser validates the four-byte size
before reserving at most one protocol frame, consumes one frame per call,
rejects truncation, and closes the worker generation on invalid input, EOF,
deadline, or cancellation. The public raw worker decoder was removed, and the
outbound `WorkerFrame` schema no longer implements `Deserialize`; only the
dispatcher can produce an `AuthorizedInvocation`. RED was the missing stream
and revocation API compile failure. Synthetic tests prove oversize rejection
after four bytes, timeout/cancel closure, and per-invocation revocation on
completion or dispatcher close without affecting another invocation/session.
GREEN: the protocol and fixed-policy crate passed **23/23** locally, including a
compile-fail doctest that prevents external deserialization into `WorkerFrame`;
Rustfmt, targeted crate formatting check, and `git diff --check` passed.
Independent review had identified the public decoder bypass, unbounded read,
and stale invocation concerns; the API and tests now address those codec-level
gaps. Independent follow-up review found no additional protocol defect, and
confirmed these residual limits: the `DeadlineReader` trait cannot force an
adapter to honor its deadline; a read deadline does not itself expire an
already-returned invocation; and consumers can retain copied arguments or
race a current-token check against a side effect. This remains a library
contract only: no process adapter or production caller implements
`DeadlineReader`, so actual OS-enforced read cancellation, per-call host
cancellation, process supervision, policy enforcement, and process-tree reap
remain pending. A future host must revoke on timeout/cancel and recheck the
invocation immediately before each permission-dispatched side effect.

### IPC v2 cancellation compatibility follow-up

The shared contract now uses protocol version 2 because cancellation has a
distinct `InvocationCancelled` host response. The dispatcher rejects a v1
worker during handshake; public `decode_host_frame` also rejects v1 responses
for every host-frame variant. It revokes only the matching pending invocation
when cancellation completes. This is message-level cancellation: it does not
terminate a process or prove that an in-flight OS operation was preempted.

- RED: a fixed v1 hello was incorrectly accepted as `Ready`; after the version
  bump, a fixed v1 `HostFrame::Ready` was also returned by the public response
  decoder. Both regressions failed before their corresponding version checks.
- GREEN: Rust 1.85.1 formatting checks and
  `cargo test --locked -p modus-plugin-execution-protocol` passed **26/26 unit
  tests plus 1 compile-fail doctest**. The cancellation fixture confirms that
  only the canceled sequence loses its authority while another pending
  sequence remains current.
- Independent review approved the v2 negotiation and cancellation semantics,
  found the v1 host-response decoder gap, and then confirmed the decoder fix
  rejects v1 on all response variants. No production caller or OS process
  supervisor exists, so runtime wiring, deadline enforcement, preemption, and
  reap remain unproven.

### One-use platform assessment prerequisite for the dispatcher

`Dispatcher::new` now consumes a non-cloneable `AdmissionAssessmentToken`;
host provenance alone cannot create a protocol dispatcher. The token is bound
to the exact `HostProvenance` and records only the frozen
`APPROVED_RESOURCE_POLICY`. An assessment with any changed field is rejected:
the codec still enforces fixed limits, so accepting a smaller recorded policy
would misstate what the dispatcher actually applies. The token and assessment
have no wire/deserialization form. Synthetic construction exists only under
`cfg(test)` for protocol fixtures. No production platform adapter implements
the sealed `PlatformAssessmentSource`, so there is currently no production way
to mint a token; this intentionally keeps external-worker dispatch unavailable
and does not change the trusted Harness/plugin path.

- RED: CI run `38109021619`, job `114380499499`, executed 26 existing protocol
  unit tests successfully, then failed the new `compile_fail` doctest because
  constructing a dispatcher from provenance alone **compiled successfully**.
  This directly demonstrated the missing admission prerequisite.
- GREEN tests now cover a complete synthetic assessment; omission of each
  required control; one-above changes to each of the 25 frozen policy fields,
  one-below changes to each positive field; and evidence from another
  session, workspace, or run. The approved zero-child-process limit has no
  representable lower value and is covered by the equality and one-above
  cases. A
  single macro defines the required control enum and list. Compile-fail
  doctests ensure the token cannot be cloned or consumed by two dispatchers.
  Until dynamic limits are wired throughout the codec, only the exact
  approved policy is accepted.
- The independent review rejected the earlier claims that this token was a
  confinement proof or generation-bound: it was not tied to a process handle
  or IPC stream, and the sealed adapter trait cannot be implemented in the
  separate `plugin-sandbox-probe` crate. The API is now named and documented
  as an assessment prerequisite, not OS evidence. This leaves a material
  architectural gap: future platform adapters must live behind a reviewed
  bridge in the protocol crate, and must own the process/stream binding before
  artifacts are sent. The current `Dispatcher` still accepts caller-provided
  frame bytes/readers and host-provided grants; this library API alone does
  not prove those are from the assessed process or bound to the correct host
  authorization.
- A second independent static review approved this narrowed assessment-token
  change, while explicitly rejecting any claim that it proves production
  confinement. It confirmed the exact-policy check, non-cloneable/consumed
  token, compile-fail coverage, test-derived required-control list, and the
  documented process/stream/grant gaps. No hostile, process-launch, or
  enforcement test was run.
- No Windows/Linux/macOS adapter implementation, artifact-transfer callsite,
  process supervisor, or productive desktop dependency exists. This source
  contract neither proves OS policy enforcement nor closes A01–A04. The
  external-worker path remains unavailable; the trusted Harness/plugin path is
  unchanged. The first remote run `38109817444` on `da9e2b3` stopped at the
  Rust formatting check; the protocol tests were skipped. The formatting-only
  differences were corrected, and the full remote validation for the revised
  API is pending.

## Mission CI prerequisite — Free monthly renewal calendar

**Status: implemented, locally verified, independently reviewed, and CI-green.** This is the
incremental Supabase quality-gate fix requested for the mission, outside the
A01–A25 finding matrix. Its pgTAP suite passed in CI run `38088870451` and in
the earlier green Supabase run `38076843678`; Windows and macOS packaging for
the completed PR head `7e9e835` also passed.

The failure was a real month-end drift. Renewal used an already-clipped monthly
boundary as the next anchor; for a Jan 31 grant, February clips to Feb 28/29,
and adding another month from that clipped boundary can move the anniversary
away from the 31st. The new private `free_renewal_period` derives each window
from a stable anchor. Free-only wallets use the original grant timestamp;
wallets still paid use their paid period end. For a wallet already returned to
Free, Mercado Pago can retain the prior paid boundary only when a credited
payment is linked to that exact preapproval. Stripe ledger rows do not retain a
subscription id, so the migration does not attribute an invoice to a canceled
subscription; when a paid Stripe invoice exists, it preserves the wallet's
current deadline as the stable migration anchor. A canceled but uncredited
preapproval does not change a Free-only wallet's anchor. Legacy Free deadlines
shifted by the old calculation are moved forward to the next canonical
boundary when their anchor is known, without editing balances, transactions,
or ledger keys. `renew_free_credits_for_user` keeps the existing due gate, row
lock, idempotency key, grant amount rules, and atomic wallet/ledger behavior.
The schedule and inference helpers are not executable by `PUBLIC`, `anon`,
`authenticated`, or `service_role`.

RED/GREEN evidence:

- RED: the remote run `38054966410` failed pgTAP test 22 with `2026-10-30`
  received and `2026-10-31` expected. The new anchor-backfill regression tests
  also failed before implementation because the inference helper was absent.
  The independent review found and drove fixes for an already-Free former-paid
  wallet being reset to its signup cadence, old shifted deadlines receiving a
  second renewal soon after rollout, canceled-but-unpaid preapprovals being
  mistaken for a paid cycle, and an invoice being attributed to an unrelated
  Stripe subscription. A RED run of the uncredited case selected Feb 28 from
  an uncredited canceled row instead of the Free-only Jan 31 grant anchor.
- GREEN: on a disposable Postgres 17 container with the repository shim and
  all migrations applied, `17_free_monthly_renewal.test.sql` passed **91/91**.
  Fixed fixtures cover Jan 31 → leap-day → Mar 31, Dec 31 → Jan 31 in leap
  year, Jan 31 → Feb 28 → Mar 31 in a non-leap year, former-paid cadence, and
  existing Free-only cadence; provider fixtures cover a Stripe invoice with
  unknown subscription attribution, linked Mercado Pago credit, and an
  uncredited canceled preapproval. Existing renewal, idempotency, ledger,
  grace, and batch tests also passed. The independent review was static; it
  found no remaining security finding in helper privileges/search paths,
  trigger qualification, or Mercado Pago attribution.

Remote CI follow-up: run `38076269061` applied the migration and the renewal
suite passed **113/113**, but failed `01_rpc_privileges.test.sql` tests 28–30.
The new migration adds four private helpers: total private-function inventory
is now 37; 35 are `SECURITY DEFINER`, while the two pure calendar helpers are
`SECURITY INVOKER`, both with `search_path=""`. The old inventory asserted 33
functions and required every private helper to be `SECURITY DEFINER`. The
inventory test now records the actual set and separately asserts empty
`search_path` for all invoker helpers. The two affected pgTAP files pass
locally after all migrations: **127/127**. The independent static review found
no new issue. CI run `38076843678` on commit `c3b423e3` is green: pgTAP passed
**1,041/1,041** across 20 files, Deno database integrations passed **13/13**,
and typecheck, Biome, Vitest, verifier-first, containment, PTY, and compile-only
Rust jobs all passed. The compile-only sandbox job did not execute probes.

The renewal fix was revalidated on the current PR head `8c9a0a8` in CI run
`38107531336`: the Supabase pgTAP/integration job passed **20 files / 1,041
tests**, including `17_free_monthly_renewal.test.sql` test 22 and its fixed
month-end/leap-year fixtures. The same workflow's global Vitest job had one
separate failure in the unchanged `FastVectorDistance` timing assertion
(`0.127588 ms` against `<0.1 ms`; 4,679 passed, 1 failed, 8 skipped across
415 files). No base-branch comparison was performed, so that failure remains
unclassified. The Windows and macOS packaging workflows on `8c9a0a8` passed.

Known legacy limitation: Stripe's historical credit ledger stores invoice
ids but not their subscription ids. For former Stripe subscribers already on
Free, the migration preserves the currently stored `period_end` rather than
guessing which canceled subscription set the schedule. This protects the
current due date and stops future repeated month clipping, but cannot restore
the original day-of-month for a legacy Stripe wallet whose deadline had
already drifted. A future transaction-to-subscription relation can improve
provenance for cycles recorded after that schema change.

## Remote CI on IPC protocol commit `f0e41d3`

Workflow `38078478316` completed its `typecheck · test · biome` job
successfully. Global Vitest passed **4,608 tests** across **408 files**, with
**8 skipped** (**131.66 s**). The safe protocol job passed formatting and its
then-current **11/11** synthetic tests. Supabase pgTAP/integration,
Verifier-First runtime regressions, PTY cancellation, and Windows/macOS plugin
containment passed; the sandbox job only compiled and did not launch probes.
Ubuntu plugin containment failed the `FastVectorDistance` assertion at
**0.102602 ms** against `<0.1 ms` (**279 passed, 1 failed, 7 skipped** in that
subset). No base-branch comparison was performed, so this is recorded without
a baseline or instability classification. Windows and macOS packaging runs
`38078478287` and `38078478240` were still running at this update. The resource
policy follow-up is not part of this run.

## Remote CI on resource-policy commit `f3102af`

Run `38078980190` passed Biome and desktop typecheck, the safe IPC protocol
job (**14/14** at that commit), Verifier-First/A21.2 regressions, PTY
cancellation, Supabase, compile-only sandbox, and Ubuntu/Windows containment
jobs. The full Vitest step reported **4,606 passed, 8 skipped, 2 failed**;
both failures were in `qa-evidence.test.ts` and expected
`recognizeCheckInvocation(...).checkName === "tests"` but received `undefined`
at lines 143 and 209. That file is unchanged since `f0e41d3`, whose full Vitest
run passed; the focused file also passed locally (**105/105**). This is not a
base-branch comparison and does not establish an instability-only cause, so
the CI discrepancy remains unresolved pending another identical safe run.

macOS containment failed its unchanged `FastVectorDistance` timing assertion
at **0.143916 ms** against `<0.1 ms` (**279 passed, 7 skipped, 1 failed** in
that subset). Ubuntu passed the same containment job on this run. No benchmark
or threshold was changed; the timing failure is not classified as preexisting
or solely environmental. Windows x64 packaging and artifact upload passed;
macOS x64 and arm64 packaging and artifact uploads also passed. The safe
protocol job, sandbox job, and CI filters did not execute guest plugins or
enforcement probes.

The same full-suite command was run locally with the same safe exclusions. It
passed `qa-evidence.test.ts` (the focused file passed **105/105**) but overall
reported **4,586 passed, 8 failed, 8 skipped across 407 files** in **403.37s**.
The eight local failures were two OAuth-provider requests (`ECONNREFUSED` to
GitHub/Google), one Composio connectivity-probe test timeout, one packaged
glass headless-Chrome verifier error (`undefined` parsed as JSON), and four
computed-style headless-Chrome measurements returning undefined. These are
recorded as environment/test failures without baseline or instability claims;
the local run does not explain the two remote QA assertions.

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

The separate Pi SDK code-review path was also found to auto-discover project
and user extension directories. That path now sets `noExtensions: true` before
`reload()`. This closes that specific external-extension ingress; it does not
add an OS boundary or change the direct built-in Harness dispatcher.

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
  link-local IPv4 ranges, and retains explicit localhost/domain grants. It now
  also blocks selected RFC1918, carrier-grade NAT, reserved/documentation IPv4,
  IPv6 ULA, link-local, multicast, documentation/tunnel ranges, mapped private
  IPv4 literals, and the well-known NAT64 prefix when it embeds a non-public
  IPv4 address, even when an explicit domain list contains `*`. Globally
  reachable `192.0.0.9` and `.10` remain usable with exact grants. This is not
  an exhaustive special-purpose address registry. The checks remain
  predicate-only: DNS resolution/pinning, redirect validation,
  connection-level enforcement, and production wiring are absent; A08 remains
  open.
- A09 shell checks reject the tested shell-composition metacharacters and no
  longer accept caller-supplied core trust. When the shell allow-list includes
  `git`, direct recognized Git commands also require the matching explicit Git
  grant, including `.exe` names. Common shell interpreters, package managers,
  and selected command wrappers are denied even when their full command is
  allow-listed. The finite list cannot identify arbitrary wrappers or aliases;
  allowed executables may launch children or evaluate project scripts. The
  brokers have no production callsites; the shell API accepts a command string,
  does not parse structured argv, and does not constrain the Git
  repository/resource. Its conservative syntax gate also rejects quotes,
  backslashes, and `=`, denying some legitimate quoted arguments, Windows
  paths, and `--option=value` forms. A09 is partially mitigated, not complete.

### Evidence

- RED: twelve regression tests reproduced missing-parent and dangling-link scope
  escapes, unsafe filesystem I/O availability, bracketed/mapped IPv6 loopback
  bypass, the rest of IPv4 loopback/unspecified/link-local ranges, shell
  composition and forged trust, interpreter/Git executable wrapper bypass,
  Git grant bypass through shell, and missing/forged Git operation grants.
- GREEN: thirteen selected tests passed (the twelve regressions plus the existing
  shell whitelist behavior check); exact test names were selected and the full
  `adversarial bypass hardening` describe group was not run. A later A08
  follow-up selected its pure in-memory `blocks obfuscated loopback IPs`
  predicate test by exact name; it called no network and ran no plugin,
  filesystem, shell, or process code. The group was not run as a suite.
- Desktop typecheck: passed, exit 0.
- Targeted Biome: passed with existing warnings/infos; no rules were disabled
  and no bulk formatting was applied.
- `git diff --check`: passed.
- Static callsite search found no production use of `FilesystemBroker`,
  `NetworkBroker`, `ShellBroker`, or `GitBroker` outside their definitions.
- A08 follow-up RED/GREEN: synthetic address tests failed before the change
  (`10.20.30.40`, `[fc00::1]`, NAT64-encoded `169.254.169.254`, and exact
  grants for `192.0.0.9/.10`) and passed after it. The selected network-policy
  regressions passed **10/10**; they called only `canConnect` on in-memory
  strings and made no network connection. DNS rebinding, redirects, other
  translation prefixes, and productive connection enforcement remain
  untested and unimplemented. Independent review flagged NAT64 and anycast;
  those two gaps were covered before the reviewer was asked to re-review.

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
`noExtensions: true`; the review-service loader now sets the same option before
`reload()`. A runtime-path test reaches `startAgentReview`, asserts extension
discovery is disabled, preserves the explicitly selected model, and checks the
read-only review tool profile. The SDK containment test also confirms that the
option prevents project and agent-directory extension discovery. No external
extension code is executed by these tests.

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
- Review ingress RED/GREEN: the new `review-service-runtime.test.ts` failed
  before the fix because the loader options omitted `noExtensions`; it passes
  after the fix. It exercises `startAgentReview` with a non-empty synthetic
  diff, verifies `loader.reload()`, preserves the chosen model, and checks the
  `review` tool profile. The focused review-service and Pi SDK containment
  suites passed **6/6**. Containment uses only synthetic inert test fixtures.
- Independent read-only review: no blocker. It confirmed Pi SDK 0.80.6 honors
  `noExtensions` on the productive review path and noted the need to protect
  the read-only tool profile; the runtime regression now asserts that profile.
- Follow-up review for host-catalog provenance found that exact manifest
  identity alone did not prevent its owner from mutating nested permissions,
  provisions, configuration, or lifecycle hooks after catalog construction.
  `HostPluginCatalog` now recursively freezes the trusted manifest data graph
  and stores its index in `#entries`. A fresh local fixture creates its own
  mutable implementation object; with the freeze removed, the regression is
  RED (`Object.isFrozen(manifest)` false), and with the implementation present
  it is GREEN. The final focused catalog/lifecycle/plugin/runtime Vitest passed
  **312/312** after the review-driven fixture and cleanup refinements. The test
  also proves replacement of the
  fresh implementation callback throws and authorization returns the original
  function. Review found no production blocker and noted that the earlier
  fixture accidentally reused an implementation already frozen by the global
  built-in catalog; that weakness is corrected. Runtime test setup and cleanup
  now run under `try/finally` so the prototype spies and filesystem fixture
  are restored even if runtime close rejects. The final independent read-only
  review confirmed those changes and found no blocker; it noted accessors are
  not traversed, and none exist in the current built-in manifests. This narrows
  A03 provenance mutation but is not an OS isolation boundary; external plugin
  execution remains disabled.
- Desktop typecheck passed, exit 0. Targeted Biome passed with **11 warnings**
  in the selected files and no errors; no fixes or rule changes were applied.
  `git diff --check` passed.
- Remote CI for commit `7475429`: Biome/typecheck, the global test job,
  Verifier-First regressions, sandbox compile-only, PTY cancellation, and
  macOS/Windows containment passed; global Vitest recorded **4,606 passed,
  8 skipped**. The Linux containment subset failed only `FastVectorDistance`
  at **0.104524 ms** against `<0.1 ms` (280 passed, 7 skipped). On the
  follow-up docs-only commit `0462dc3`, the global Vitest recorded **4,605
  passed, 8 skipped, 1 failed**: the same benchmark measured **0.100859 ms**;
  all three containment jobs passed. A local isolated run measured the same
  benchmark at **0.182188 ms**, and the exact plugin containment command also
  measured `FastContextCompactor` at **0.348714 ms** against `<0.1 ms`. These
  measurements show repeatable threshold exceedances in this environment, but
  no base comparison establishes that the tests are pre-existing or solely
  unstable. The benchmark and threshold were not changed. Both CI runs failed
  the recurring pgTAP test 22 (`2026-10-30` received, `2026-10-31` expected).
  Windows and macOS packaging for both `7475429` and `0462dc3` subsequently
  completed successfully (runs `38052909500`, `38052909590`, `38053077890`, and
  `38053077940`).
- The full CI-filtered desktop Vitest run completed **401 files passed, 4
  failed; 4,564 tests passed, 8 failed, 8 skipped**. Failures observed were
  two external OAuth fetches (`ECONNREFUSED`), four headless-Chrome style
  measurements without values, the packaged-glass headless verifier receiving
  `undefined`, and `FastVectorDistance` measuring 0.400156 ms against its
  0.1 ms assertion. These failures were not compared against `main`; they are
  unresolved and are not classified as pre-existing. The authorized adversarial
  and runaway-test filters remained in place.
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

**Status: lifecycle service paths are implemented and locally checked. The
latest published run on `126c99c` passed Biome/typecheck and has one unresolved
Vitest benchmark timing failure, one Windows containment timing failure, and
the recurring pgTAP date failure; Linux/macOS containment passed and Windows
x64 plus macOS x64/arm64 packaging completed successfully. The documented
host-process boundary limitations remain.**

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
  The service derives trust policy from the selected level, rejects upgrade or
  downgrade candidates outside the persisted level before hot reload, and will
  not release quarantine for a disallowed plugin during restoration.
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
  and fresh-loader dependency restoration order. Additional A13 regressions
  reproduced a forged service-level trust allow-list, disallowed
  upgrade/downgrade candidates being hot-reloaded, and restoration clearing
  quarantine during Safe Mode. The service now derives the allow-list itself,
  rejects those transitions before loading candidate code, and retains
  quarantine (RED/GREEN).
- Startup RED/GREEN: with lifecycle enabled, the previous deferred bootstrap
  loaded built-ins and ran `onLoad` before durable disabled/tombstone state was
  reconciled. A failed user-data path also fell back to `:memory:` and could
  activate built-ins without persistent decisions. Lifecycle-enabled startup
  now opens the existing SQLite store first, leaves built-ins unloaded during
  bootstrap, then seeds first-install defaults durably and restores only the
  resulting enabled records. Store initialization failure leaves the plugin
  loader empty while the rest of the runtime remains constructible. The
  runtime regression uses a regular file as the user-data directory so SQLite
  store initialization itself fails; it does not only mock `app.getPath()`.
- The lifecycle-off configuration remains an explicit legacy opt-out: when
  `MODUS_PLUGINS=true` and `MODUS_PLUGIN_LIFECYCLE=false`, ordinary built-in
  bootstrap does not consult durable plugin state. The independent review
  flagged this conditional path; the feature flag is currently treated as
  disabling lifecycle persistence/reconciliation, and the matrix does not
  claim tombstone or disabled-state enforcement in that mode. External plugin
  execution remains unavailable.
- Targeted Vitest: **4 files, 137 tests passed** (`plugin.test.ts`,
  `plugin-lifecycle.test.ts`, `plugin-dependency.test.ts`, and
  `plugin-rollback.test.ts`). Tests use only synthetic in-process fixtures; no
  external plugin or adversarial probe ran.
- The updated rollback/Safe Mode suite passes **39/39**; its three new
  upgrade, downgrade, and restore regressions first ran RED (3 failures) and
  then GREEN. Desktop typecheck passes. Targeted Biome passes with two existing
  warnings and no errors; `git diff --check` passes.
- Desktop TypeScript typecheck: passed, exit 0.
- Startup patch focused Vitest: **3 files, 308 tests passed** across
  `plugin-lifecycle.test.ts`, `plugin-rollback.test.ts`, and
  `pi-sdk-runtime.test.ts`. This includes the store-initialization failure
  regression and deferred-bootstrap lifecycle assertions; fixtures use only
  host-catalog built-ins and synthetic state.
- Startup patch desktop TypeScript typecheck: passed, exit 0. Targeted Biome
  on the six changed TypeScript files: exit 0 with 14 warnings and no errors;
  warning origins were not baseline-classified. `git diff --check` passed.
- Targeted Biome on 11 changed TypeScript files: exit 0 with 57 warnings and 1
  info, and no errors after correcting one formatting diagnostic. Warning
  origins were not baseline-classified; no lint rule was disabled and no bulk
  formatting was applied.
- `git diff --check`: passed.
- Independent review: the initial pass identified startup dependency-order
  gaps and a forced-removal dead end for persisted cycles. The startup ordering
  and cycle-recovery fixes were reviewed again; the reviewer found no remaining
  concrete blocker. A13 re-review confirmed the new service-level checks and
  tests. It also noted same-process runtime accessors to internal loader/service
  objects; there are no in-repository production callers, external plugin
  execution remains denied, and that accessor surface remains a residual API
  concern. Review was static and did not execute tests.
- Remote CI for `47889cb` completed: the global TypeScript/Biome/Vitest job,
  Linux/macOS/Windows plugin-containment jobs, and Windows x64 plus macOS
  arm64/x64 packaging all passed. Supabase pgTAP failed one assertion in
  `17_free_monthly_renewal.test.sql` (test 22: have `2026-10-30`, want
  `2026-10-31`). Earlier CI on `d77cf0e` also failed the WASM
  `FastVectorDistance` timing assertion (`0.161752 ms` and `0.104707 ms`,
  required `<0.1 ms`); on `47889cb` that benchmark passed. These outcomes are
  recorded without classifying either failure as pre-existing. The current
  startup patch still needs a CI run after publication.
- Remaining limits: this does not create an OS execution boundary, prove
  crash-consistent external artifact deployment, or enable external plugins.
  Safe Mode is persisted in the existing plugin state database; full corruption
  and power-loss behavior beyond the injected restart fixtures is not proven.

### A13 runtime API hardening follow-up

The audit found that `PiSdkRuntime` returned its mutable capability registry,
plugin loader, lifecycle store/service, dependency graph, and plugin manager
objects through ordinary getters. Repository search found no production caller
outside the runtime, while tests used those getters to inspect state and close
SQLite handles. The fields themselves were also TypeScript-only `private`, so
they remained ordinary JavaScript properties.

The runtime now stores the registry, loader, lifecycle service/store, and the
bootstrap/synchronization promises in ECMAScript `#private` fields. The manager
getters were removed. A narrow `closePluginLifecycleStore()` waits for startup
and sync before closing the runtime-owned DB handle; it does not mutate
durable plugin records. `MODUS_PLUGIN_TRACING` now installs its instrumenter on
the private capability registry rather than exposing tracing managers. Tests
use a separately owned store or prototype instrumentation to verify startup
without receiving the runtime's mutable managers. The built-in bootstrap test
also observes the six host-catalog loads through the loader prototype.

- RED: before changing the runtime, the new reflective-surface regression
  listed the exposed mutable plugin APIs; GREEN: the regression now finds none.
- RED/GREEN runtime coverage: the off/on tracing test checks that the disabled
  flag makes no registry instrumentation call and the enabled flag installs
  exactly one; startup waits and closes each store before recreating the next
  runtime. The existing productive bootstrap test observes the six host
  catalog plugins being loaded and verifies their durable enabled records.
- Focused Vitest: runtime and plugin tracing **253/253 passed**; four
  selected capability-registry, dependency, isolation-facade, and productive
  built-in-bootstrap tests passed (**4 passed, 134 skipped**). No external
  plugin code, adversarial test group, or enforcement probe ran.
- Desktop typecheck: passed locally, exit 0. Targeted Biome passed with
  **40 warnings and 5 infos** in the selected files; no errors, rule changes,
  or bulk formatting. Diagnostic origins were not baseline-classified.
  `git diff --check` passed.
- Independent read-only review: no direct regression in plugin internals or
  feature-flag wiring. It identified test cleanup and a race between two test
  runtimes using one `plugins.db`; both were corrected. It also identified a
  reduced bootstrap assertion set, which is now supplemented by observing the
  runtime's six actual `PluginLoader.load` results.
- A13 follow-up: `harnessKernel` was also converted from TypeScript `private`
  to ECMAScript `#harnessKernel`. A new RED check found the reflected property;
  after the change, the focused Pi runtime file passed **233/233** tests.
  Desktop typecheck passed locally and targeted Biome exited 0 with nine
  warnings and no errors or fixes. Independent review found no blocker. Its
  test helper captures the actual kernel while the runtime registers hooks and
  restores the prototype spy in `finally`; one low-risk maintenance caveat is
  that a future constructor-created kernel registering first could change which
  instance the helper captures.
- A13 lifecycle follow-up: the lifecycle service, SQLite state store, and
  dependency graph also used erased TypeScript `private` declarations for
  store/graph/manager references, the per-store transition queue, unlocked
  transition helpers, the SQLite handle/transaction flag, and graph maps.
  The manager getters also returned Version, Safe Mode, Recovery, and
  AutoRollback instances whose own fields exposed the service/store/registry,
  graph, version manager, health monitor, backup cache, and in-memory Safe
  Mode state; Recovery's recommendation helper was reflectable as well. RED
  first reproduced the service `store` property and then a manager's `service`
  property. These service, store, graph, and manager-owned slots/helpers now
  use ECMAScript-private syntax. The lifecycle, dependency, and rollback
  suites passed **110/110**, and desktop typecheck passed. Targeted Biome exited
  0 with **8 warnings and 2 infos** in the eight selected files; no fixes or
  rule changes were applied. `git diff --check` passed. Public compatibility
  getters for the store, graph, database, and four managers remained in commit
  `3f9a3ed` and were asserted to preserve identity where relevant. The manager
  instances retain their operational public APIs. A follow-up below removes
  the raw database getter and detaches graph read results. The store, graph,
  and manager APIs that remain are still callable by same-process code holding
  those references; the graph getter retains its explicit public mutation
  methods.
  Independent review found no behavior/API blocker and confirmed
  the manager field chain is closed; it did not execute tests or probes. The
  change creates neither an in-process trust boundary nor an OS boundary.
  Remote CI for the expanded follow-up is pending.
- A13 dependency-graph reader follow-up: review noted that `getPlugin()` and
  `getAllPlugins()` returned live internal nodes and arrays, so an ordinary
  read could mutate dependency edges outside `addPlugin()`/`removePlugin()`/
  `rebuild()`. A synthetic RED test mutated returned dependency arrays and a
  dependent list, then observed those writes in the graph. Both readers now
  return detached node snapshots; explicit graph mutation methods and result
  shapes are unchanged. A second RED test showed that `addPlugin()` and
  `rebuild()` retained the caller-owned `requires.plugins` array; both now copy
  that array before storing it. A separate RED reflection assertion showed
  `PluginStateStore.getDatabase()` exposed the mutable SQLite handle, with no
  production callers. The getter was removed, and the rollback fixture now
  retains and injects its own test database handle. The combined
  lifecycle/dependency/rollback suite passed **112/112** after the final
  snapshot assertions covered all five array fields. Independent review then
  found two stale `getDatabase()` uses in the phase-19 audit fixture. Its
  setup now creates and retains its own `DatabaseSync` connection and passes
  that connection into `PluginStateStore`; both fixture mutations use the
  retained handle. This fixes the documented runner's static API mismatch,
  but the runner and its modes were not executed. Compile-only esbuild
  bundling of `probes.ts` passed. Targeted Biome exited 0 with **19 warnings
  and 6 infos** when including the audit fixture; no fixes or rule changes
  were applied. `git diff --check` and desktop typecheck passed. The
  independent static review found no blocker after the
  runner fixture adaptation; it did not execute tests or modes. Remote CI for
  this follow-up is pending.
- Residual: ECMAScript-private fields narrow accidental same-process access,
  but do not establish a same-process trust boundary. Plugin trace snapshots remain private when
  `MODUS_OBSERVABILITY=false`. External consumers that depended on removed
  getters will need to use supported host operations; no in-repository
  production caller was found.
- Remote run `38051942548` on `126c99c`: CI Biome/typecheck passed; the complete
  Vitest job recorded **4,604 passed, 8 skipped, 1 failed across 408 files**.
  The failure was the `FastVectorDistance` latency assertion
  (`0.115167 ms` against `<0.1 ms`). The dedicated Verifier-First job,
  compile-only sandbox, and Linux/macOS containment passed; Windows containment
  hit the same timing assertion at `0.188600 ms`. pgTAP test 22 received
  `2026-10-30` where it expected `2026-10-31`. These failures are not
  classified as pre-existing or solely unstable. Windows x64 and macOS
  x64/arm64 packaging later completed successfully.

### A10 startup gate follow-up

- Root cause: `MODUS_PLUGINS=true` with `MODUS_PLUGIN_LIFECYCLE=false` selected
  the legacy direct bootstrap. That path loaded host built-ins without reading
  persisted disabled/tombstone state and could revive a plugin after a restart.
- The effective plugin flag now requires both capability registration and
  lifecycle reconciliation. The runtime no longer performs legacy activation
  if lifecycle reconciliation is absent. Startup's existing flag validator
  reports the invalid combination, and effective flags keep the plugin
  inactive. Defaults are unchanged: both plugin flags remain off by default.
- RED: the new feature-flag test found no validation error for the invalid
  combination, and the runtime test found all six built-ins loaded via the
  legacy path. GREEN: exact-name runtime/flag regressions pass, including
  enabled lifecycle startup preserving bootstrap-before-sync order. No sandbox
  probe or adversarial group ran.
- Final targeted Vitest after removing the unreachable branch: **2 files, 3
  passed, 235 skipped**. Targeted Biome checked seven changed TypeScript files
  with no errors (14 existing warnings and 6 infos); no formatter was run.
  Desktop typecheck and `git diff --check` passed. Independent read-only review
  found no blocker and confirmed the compatibility impact: configurations that
  enable plugins without lifecycle reconciliation now leave them unloaded.
- Remote CI on `132745d`: Biome/typecheck, Verifier-First regressions,
  containment on Windows/macOS, and compile-only sandbox targets passed.
  Vitest reported **4,593 passed, 8 skipped, 1 failed across 406 files**; the
  unchanged `FastVectorDistance` assertion measured **0.107641 ms** against
  `<0.1 ms`. Ubuntu plugin containment ran 277 passed/7 skipped/1 failed with
  the same assertion at **0.103904 ms**. pgTAP test 22 again expected
  `2026-10-31` but got `2026-10-30`. Windows x64 and macOS x64/arm64 packaging
  passed. These failures are recorded without attributing them to the A10
  change or calling the timing failure solely unstable.

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

### A06 grantless WASI import gate

The host rejects any module importing WASI before instantiation because there
is no host-owned grant policy for WASI imports, environment variables, or
preopens. A caller-supplied `enabled: false`, `enabled: true`, environment, or
preopen map does not override that decision. The standalone `WasiSandbox`
helper remains available to host tests, but static callsite search found no
production consumer of it; this is not a grant-backed productive WASI path.

- Safe targeted Vitest: the four exact `rejects WASI imports from` cases passed
  (**4 passed, 43 skipped**). Each generated module was compiled for inspection;
  `WebAssembly.instantiate` was spied and asserted not to run, so no module code
  executed. No probe, external plugin, preopen, filesystem operation, or WASI
  entry point was run.
- Status: the no-grant import path is fail-closed. Grant-backed imports,
  environment/preopen derivation, start-trap behavior, and process isolation
  remain unavailable or unproven; A06 stays partially mitigated.

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
- Current A15 revalidation: the synthetic PTY cancellation test passed **1/1**;
  the exact Pi runtime ownership test passed **1/1** (229 name-filtered cases
  skipped). Both use mocked process spawns/process registries and execute no
  command or external plugin code.
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
  The latest packaging jobs later completed successfully for Windows x64 and
  macOS x64/arm64.

- Latest published CI at `126c99cadd5e944bcc2f05dd9f5b457b8e375d78`:
  the dedicated PTY cancellation regression passed **1/1**; Verifier-First,
  Linux/macOS plugin containment, and compile-only sandbox passed. Windows
  containment failed only the `FastVectorDistance` timing assertion at
  `0.188600 ms` against `<0.1 ms`; the same assertion failed in the global
  Vitest job at `0.115167 ms` (4,604 passed, 8 skipped) and had also appeared
  in prior runs with different timings. No baseline comparison was run for
  this check, so it is not classified as pre-existing or solely unstable.
  Supabase pgTAP test 22 expected `2026-10-31` but received `2026-10-30`.
  Windows x64 and macOS x64/arm64 packaging later completed successfully. No
  blocked probe was rerun.

#### Managed-app process identity follow-up

The current incremental fix keeps the original `ChildProcess` record for each
tracked app. Cancellation and `killApp` refuse to signal its numeric PID after
Node reports that leader exited; app listing also keeps an exited leader from
appearing live merely because the OS reused its PID. Cancellation cleanup
errors remain attached to `AbortError` with `cleanupConfirmed: false` instead
of being swallowed.

- RED/GREEN: a synthetic tracked-process test first resolved `killApp` and
  called the termination backend after setting the original child's `exitCode`;
  after the guard it rejects with `ProcessIdentityUnavailableError` without
  signaling. The cancellation regression likewise failed because cancellation
  called the backend for an exited leader; it now returns `AbortError` with
  `cleanupConfirmed: false` and the identity error as its cause, without a kill.
- Safe tests: process operations, app cancellation, and existing benign Node
  timer launch/cleanup tests passed **17/17**. These tests use synthetic process
  objects and a benign local timer only; they do not execute plugin code.
- A second independent review found that a stale UI click rejected through IPC,
  the renderer dropped process-stop promises, and the `terminal_kill` tool
  reported success when the original app leader was already gone. The service
  now makes that already-exited case an idempotent `false` without signaling;
  the tool reports that descendant cleanup is unconfirmed, and the renderer
  reports rejected and `false` stop results in session-scoped notices keyed by
  process id. A result for one process cannot clear another process's notice;
  the renderer clears that id's notice only after an affirmative stop result.
  For terminals this means the host accepted the kill request, not that exit
  was observed. Fake timers are restored after cancellation tests.
- RED/GREEN: the new stop-request test first failed because a resolved `false`
  produced no visible report. It now reports that termination was not
  confirmed. Additional tests confirm that a prior notice is cleared only
  after a resolved `true`, and concurrent outcomes stay keyed to their own
  process ids. A terminal-tool regression test also failed against the old
  behavior, which reported success after `killApp` resolved `false`; the tool
  now returns an explicit error explaining that descendant cleanup was not
  confirmed. The stop UI suppresses duplicate in-flight requests and keeps
  notices scoped to the current workspace/session and process id. Current
  A15's targeted tests pass **33/33 across seven files**; the combined A15/A09
  set passes **36/36 across eight files**. Desktop typecheck passed. Biome
  passed for the combined 15-file source/test set with four existing info
  diagnostics in `permission-brokers.ts`; `git diff --check` passed. No hostile
  process or plugin code was executed.
- Independent review identified Windows leader-only confirmation, stale app
  IDs, and POSIX descendants that escape the original process group. The
  stale-ID case is guarded when Node has delivered the original leader's exit
  status. Platform API documentation now limits its confirmation scope to the
  original POSIX process group or Windows leader PID; it does not claim proof
  that escaped descendants are absent.
- Follow-up independent review found that an unconfirmed-stop notice could
  outlive its process row without a dismissal action. `ProcessStopNotices`
  now exposes an accessible per-process Dismiss button; this removes only the
  current session's local UI notice, not any durable audit or process record.
  RED: the UI regression failed when the button was removed because no
  accessible dismissal action existed. GREEN: the dismissal component test
  passes. Independent re-review found no blocker and verified that the
  workspace/session scope is retained; it noted that the added test exercises
  the component with a local state harness rather than switching scopes in a
  full `ChatPane` integration test. PID reuse and escaped-descendant risks
  remain unchanged.

Remaining limits: without retained OS process handles/Windows Job Objects or a
containment boundary, a narrow exit/reuse race cannot be eliminated between
the identity check and signal; Windows does not independently verify
descendants; and POSIX cannot observe descendants that create a new process
group/session. These are not proven hard-preemption or whole-tree-reap
guarantees. A15 remains partially mitigated.

#### Remote CI on `2629044`

Workflow `38091496656` passed Biome/typecheck, Supabase pgTAP/integration,
PTY cancellation, Verifier-First, safe IPC fixtures, sandbox compile-only,
and Windows/macOS plugin-containment. The global Vitest job reported **4,630
passed, 8 skipped, 1 failed across 412 files**; only
`FastVectorDistance` exceeded its unchanged `<0.1 ms` assertion at
`0.104275 ms`. Safe-filtered Ubuntu containment failed the same assertion at
`0.105949 ms` (289 passed, 7 skipped); Windows and macOS containment passed.
The threshold and tests were not changed. Similar failures have appeared on
earlier PR runs, but no main-base comparison was performed, so this is not
classified as pre-existing or solely environmental. Windows/macOS package
workflows were still running at the time of this record.

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

The append check now also detects writes made through the logger's own SQLite
connection. `PRAGMA data_version` only reports commits from other connections;
the database schema now tracks audit-row insert/update/delete revisions with
triggers, and append verifies the retained chain if that revision changes. It
also compares the durable checkpoint hash with the in-memory checkpoint before
accepting an append. Existing databases gain the revision column additively.

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
- RED/GREEN: two tests using the logger's own connection initially showed that
  changing a retained payload or `anchor_hash` still allowed a later append.
  Revision triggers now cause payload changes to be verified and rejected;
  checkpoint changes fail closed before append. A legacy-schema fixture also
  verifies additive migration retains and validates an existing synthetic
  chain.
- Targeted Vitest: the complete cryptographic audit logger test group passed
  **12 tests** (39 unrelated tests skipped). Desktop typecheck passed. Targeted
  Biome passed with **1 existing warning and 5 infos**, all outside the changed
  hunk; `git diff --check` passed. Independent read-only review found no blocker
  and confirmed the migration and append transaction ordering. It also noted
  that external commits anywhere in the shared database can trigger a retained
  chain recheck, and retention updates the revision per deleted row. Remote CI
  for this follow-up remains pending.
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
  remaining blocker. On commit `ff57f72`, workflow `38046697377` passed Biome
  and typecheck but the global Vitest job failed only the `FastVectorDistance`
  timing assertion (`0.113352 ms` against `<0.1 ms`): **4,596 passed, 8
  skipped, 1 failed** across 406 files. macOS plugin-containment also failed
  only that assertion (`0.167249 ms`; 280 passed, 7 skipped); Ubuntu and
  Windows containment passed. Verifier-First regressions and the compile-only
  sandbox job passed. pgTAP test 22 still expected `2026-10-31` and received
  `2026-10-30`. Windows x64, macOS x64 and arm64 packaging passed. These timing
  failures are not classified as pre-existing or solely unstable without a
  successful base comparison.

### Limits

The logger verifies the persisted chain on startup and explicit verification;
before append it rechecks the chain when either SQLite's cross-connection
`data_version` or its same-database audit-row revision changes. Triggers do not
provide a separate trust boundary: a process with write access to the database
can alter the events and checkpoint consistently or disable the triggers. The
hash chain is not a signature or separate trust anchor. The current isolation
facade still denies untrusted plugin execution, and this patch does not claim
tamper resistance against host-process compromise or establish an OS boundary.

## Milestone 7 — A24 WASM cache bounds and measurement truthfulness

**Status: cache retention and WASM source admission are bounded; native compiled
memory and WASI output capture remain unavailable while the host denies WASI
imports.**

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

Caller-provided cache namespaces up to 256 UTF-16 code units are SHA-256 hashed
before entering the map. Longer namespaces bypass cache lookup and retention,
while compilation for the current call remains available; oversized names are
also omitted from compilation errors. This caps work spent hashing namespace
input and avoids retaining that input in either cache keys or error objects.

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
  assertion and threshold match the initial reference commit; this remains an
  unresolved timing failure and is not attributed to A24.
  The separate pgTAP run reported **1,021 passed and 1 failed** of 1,022: test
  22 expected `2026-10-31` and received `2026-10-30`. That billing test is
  outside A24 and was not modified. macOS x64/arm64 and Windows x64 packaging,
  plugin-containment on Linux/macOS/Windows, Verifier-First regressions, and
  compile-only sandbox targets passed on that earlier commit.
- CI run `38026077119` on A24 commit `177d01d`: Biome/typecheck passed; Vitest
  reported **4,509 passed, 8 skipped, 1 failed** across 402 files. The only
  failure was the same `FastVectorDistance` assertion, measuring
  `0.10673900000000458ms` against `< 0.1ms`. The Linux plugin-containment job
  also failed only on that benchmark after **268 passed, 7 skipped, 1 failed**;
  Windows and macOS plugin-containment, Verifier-First regressions, and
  compile-only sandbox targets passed. The pgTAP job again had **1,021/1,022**
  pass with test 22 expecting `2026-10-31` and receiving `2026-10-30`. On the
  packaging workflows, macOS x64 and arm64 package jobs passed; Windows x64
  package creation passed and artifact upload was still running at the last
  status check.
- The post-namespace-hash `npm run check` completed successfully: Biome checked
  1,136 files with **0 errors, 363 warnings, and 50 informational diagnostics**,
  then all configured workspace TypeScript checks exited 0. No diagnostics were
  auto-fixed. The focused Vitest selection passed **4/4** (43 unrelated tests
  skipped).
- Independent review found that an unbounded caller-supplied namespace string
  could remain in a cache key. A 64 KiB synthetic namespace test failed first;
  hashing the namespace made it pass. The final independent review found no
  blocker in the bounded cache change. A residual remained because hashing a
  very long namespace still takes transient time proportional to its input,
  and a compilation error retained the original name. RED reproduced both
  behaviors with a 64 KiB synthetic namespace. The follow-up now bypasses cache
  lookup/retention above 256 UTF-16 code units and omits oversized names from
  compilation errors; targeted compile-only tests passed **10/10**. Desktop
  typecheck passed. Biome passed with one existing `noUnusedVariables` warning
  for `executeWasm<TIn>`; no unrelated code was changed. Independent static
  review of the follow-up found no blocker. It confirmed that the oversized
  namespace is not hashed or stored, the bounded diagnostic name is computed
  before the compile await, and both cache counters remain zero. Runtime GC may
  retain caller values transiently at its discretion, and this does not bound
  WASM input/compile memory. Remote CI for this follow-up is pending.

- The host now enforces the already-approved 32 MiB artifact ceiling before
  copying or compiling WASM. It reads typed-array length, backing buffer, and
  offset through captured intrinsic getters, so an own-property `byteLength`
  cannot understate the input. It copies exactly the checked span into a fixed
  snapshot and uses that same snapshot for hashing and compilation; a
  length-tracking view over a growable `SharedArrayBuffer` cannot expand the
  bytes passed downstream. The internal compile helper uses a JavaScript
  `#private` method so callers cannot bypass the admission snapshot at runtime.
- RED: the 32 MiB + 1 array with an own `byteLength = 1` failed to hit the
  intended limit check; the growable shared-buffer test observed the compile
  input grow from 41 bytes to 33,554,433 bytes; and a runtime-reflection test
  found the TypeScript-only `private` compile helper callable. Each regression
  failed before its corresponding correction. GREEN: the focused compilation,
  module-inspection and cache group passed **12/12** tests, including artifact
  rejection and fixed-snapshot behavior. Tests only compile bounded generated
  bytes and do not instantiate or invoke the WASM fixture.
- The fresh `npm run check` completed with exit code 0: Biome checked 1,152
  files with **0 errors, 318 warnings, and 46 infos**, and desktop TypeScript
  typecheck passed. The modified-file Biome check also exited 0 with one
  existing `noUnusedVariables` warning for `executeWasm<TIn>`. No unrelated
  diagnostics were changed.
- CI run `38108914588` on `7ea59b6` passed Biome/typecheck and the safe protocol,
  A17/A21.2, Supabase, PTY, and compile-only jobs. All three plugin-containment
  lanes exposed a test integration regression: `createInstance` now compiles
  through its private snapshot helper, while the existing snapshot-integrity
  test intercepted the public `compileModule` method and waited forever. This
  left the pending instance rejection unobserved and caused a timeout; it did
  not indicate a failed artifact-cap check. The test now pauses the actual
  `WebAssembly.compile` call, retains the mutation-and-rejection assertions,
  and restores the spy on all paths. The affected test and combined safe 19.1
  selection pass **13/13** locally. Remote confirmation of the corrected test
  is pending. The same CI run had one separate `FastVectorDistance` Vitest
  failure at **0.127588 ms** against `<0.1 ms`; no base comparison was run, so
  it remains unclassified. Windows and macOS packaging status for the run is
  recorded separately below. On follow-up run `38109347484` at `e277fd6`, the
  corrected A24 snapshot-integrity test passed in the Linux, macOS, and Windows
  containment lanes, and global Vitest reported **4,682 passed, 8 skipped, 0
  failed across 415 files**. Biome/typecheck and pgTAP also passed. The protocol
  job failed only on its intentional A01 compile-fail RED test; Windows/macOS
  package jobs were still pending at the time of this status update.

### Limits

The cache entry count and source-byte accounting bound retained module count
and the sum of source sizes represented by those entries, not the compiled
machine-code memory V8 retains. Source inputs larger than 32 MiB are rejected;
inputs at or below that limit are copied for stable hashing and compilation,
but this does not bound native compiler overhead or retained compiled memory.
WASI output is not captured or made available; the grantless host denial
remains intact. This cap does not enable the in-process host for external
plugins; productive isolated execution remains unavailable.

## Milestone 8 — A18 durable, paged and group-scoped mailbox

**Status: implementation and independent review pass; integrated desktop CI passes.**

The mailbox previously treated SQLite as a best-effort mirror. Direct ACKs
updated memory before ignoring persistence failure, broadcast ACKs existed only
in a process-local map, writes reported success after database errors, and the
restart hydration query silently omitted all but 20,000 rows. Broadcast inbox
reads also lacked a host-derived group filter, while the send tool accepted a
model-provided group override.

SQLite is now the mailbox source of truth. Sends insert and apply FIFO capacity
in one immediate transaction before reporting success. Direct-message capacity
is per `(group, recipient)` and broadcast capacity is per group. Read, dedupe,
ACK, and expiration failures surface as errors to the tool handlers. Before
scoped reads or counts, one immediate transaction removes expired entries and
normalizes legacy inboxes to the configured FIFO capacity; this prevents
expired data from being delivered before the scheduled settle cleanup and
brings pre-existing over-cap storage under the same bound. Unused
turn-start and tools-register hooks were removed; explicit receive is the
consumer, while retention cleanup runs from PiSdkRuntime's turn-settle phase
after ResponsePolicy and Observer. Direct ACKs are only reported after the
durable row update, and a new
`harness_group_message_acks` table stores each broadcast recipient's ACK
independently. Inbox reads query the requested recipient and required group
directly with a bounded page size instead of hydrating a global 20,000-row
cache. Pending counts use SQL `count(*)`, remain independent of the receive
page size, and reflect the enforced per-recipient capacity.
Persistence statements are prepared once per database handle, and the
production schema indexes `(group_id, recipient, sent_at)` for capacity
enforcement.

Production send/receive/ACK tools use session identity from the host's
AsyncLocalStorage context and re-check that the session remains in the same
group at each operation. Direct recipients must be current group members;
broadcasts remain group scoped. The public send schema no longer offers an
override, revision checks ignore model-supplied group IDs, and receive/ACK SQL
requires the host group. Runtime registration activates tools only behind
`MODUS_GROUPS_MAILBOX`; non-members cannot activate them, and
send/ACK are unavailable in Plan Mode. This prevents mailbox reads, broadcasts,
and acknowledgements from crossing Agent Groups. The migration stores
per-recipient broadcast ACKs with the existing database; no new service or
in-memory mirror was added.

### Evidence

- RED: the initial SQLite regressions failed before implementation: a broadcast
  ACK replayed after mailbox reconstruction, a direct ACK returned success
  after the database rejected its write, a mailbox with 20,005 rows reported
  only 20,000 pending messages, and a send reported success with no database.
- RED: later review regressions reproduced cross-group reads for a session
  without group identity, unbounded broadcasts, partial batch ACKs, a model
  overriding the group for revision checks, and mailbox tools missing from the
  runtime/Pi SDK session. A Plan Mode regression also reproduced send/ACK write
  tools being exposed in a read-only profile.
- RED: review tests reproduced expired persisted entries being returned before
  settle cleanup and legacy inboxes exceeding configured capacity. Reads and
  counts now expire old entries and normalize FIFO capacity atomically first.
- RED: a late ACK also changed an expired unacknowledged message into a newly
  acknowledged one, extending its retention; clean scoped reads also opened a
  write transaction and normalized the entire table. ACK now checks retention
  under its write lock, while scoped reads preflight only their group's indexed
  expiration/capacity and open a transaction only when cleanup is needed.
- RED: the per-turn global settle sweep also opened a write transaction and
  normalized all groups when no entry had expired. It now uses indexed global
  TTL preflight and returns without a write transaction on a clean store;
  capacity normalization remains scoped to a group's read/count.
- GREEN: the complete synthetic group-mailbox suite passed **46/46**. It covers
  restart hydration, recipient-specific broadcast ACKs, SQLite ACK failure,
  legacy 20,005-row capacity normalization, expiry before reads, per-recipient
  capacity, storage failure, host
  group mismatch, host-owned revision scoping, cross-group rejection, bounded
  broadcast retention, and atomic batch ACK rollback. Pi runtime tests also
  passed the send → receive → ACK flow through the offline Pi SDK stream,
  runtime tool registration/session assembly, feature-flag handling,
  non-member filtering, and Plan Mode read-only filtering. Independent review
  regressions also reproduced an ambiguous dedupe tuple (RED) and stale
  membership allowing reads after removal (RED); the tuple now uses canonical
  JSON serialization, and the runtime rechecks membership for send, receive,
  and ACK (GREEN targeted regressions). Direct messages to a non-member now
  fail before storage. The settle cleanup hook now returns the phase contract's
  valid completion shape even after ResponsePolicy/Observer project their
  outputs; an integrated HarnessKernel test had reproduced `settled: undefined`
  before this correction.
- The full Pi runtime suite initially exposed five A21.6 response/observer
  failures because the cleanup hook replaced the turn-settle input. Moving
  cleanup after those consumers made all five targeted regressions pass; the
  complete runtime suite previously passed **226/226** and is being rerun after
  the final performance/type fixes. The complete Pi runtime suite now passes
  **228/228**, including removal of membership during an active turn and
  attempted send/receive/ACK after revocation. The original 100 ms mailbox benchmark
  regressed to 115–143 ms after durable transactions; the threshold is
  unchanged. Cached statements and a production-equivalent compound index
  restore the exact benchmark and complete group suite to green. Targeted
  Biome exits successfully with 18 warnings and no errors; Typecheck
  passes. Independent re-review found no blocker. The integrated workflow on
  `effa4ee` passed the full filtered desktop suite and all three plugin-
  containment jobs; no blocked probes ran.
- No external plugin, network, process, or enforcement scenario ran.

### Limits

The database schema and existing group membership are trusted host state; this
does not add new authorization for creating groups or selecting members.
Direct recipients are checked against current group membership before a send;
historical rows remain scoped to their persisted group and are subject to the
same expiration and FIFO normalization before reads.
Cross-process simultaneous writes are serialized by SQLite's immediate
transaction for sends, but no multi-process stress test was run. Broadcasts use
the existing 30-day unacknowledged retention because the mailbox has no
durable recipient roster with which to determine when every group member has
acknowledged.

## Milestone 9 — A23 truthful built-in capability availability

**Status: implementation and focused regressions pass; independent review passed; desktop CI and packaging passed; the global workflow still has an unresolved pgTAP failure.**

Several built-in capability adapters returned plausible success-shaped values
without performing their advertised work: an in-memory sample was presented as
project memory, context resolution returned a fabricated workspace item,
failure intelligence returned heuristic classifications, group coordination
claimed to be coordinated, and model routing invented a target. The generic
core provider also returned `status: "ok"` for capabilities with no productive
provider. Those outputs could mislead callers even though the Pi runtime has
separate session-owned memory, context, failure, group, and model-selection
services.

The adapters now throw a typed `CapabilityUnavailableError` with a
capability-specific reason when there is no productive implementation. The
pure context filtering utility remains available. Model selection continues to
preserve only the user's explicit selection; the unconnected route-target
capability cannot select a model or provider. Verifier-First's existing
session/run evidence path and the Pi runtime's productive services were not
replaced. The verifier plugin's run adapter continues to return explicit
`unavailable` outcomes and does not execute caller-supplied commands. These
adapters no longer request filesystem, network, memory, or command permissions
they do not use, and no longer declare capability dependencies their handlers
do not consume. The generic core fallback also declares no filesystem or
memory permissions.

For existing installations, startup reconciliation now refreshes the stored
declared-permission metadata only when plugin ID and version match the exact
host built-in catalog entry. The update is transactional and emits a
`permissions_reconciled` event with the version, but no permission contents.
Enabled/disabled state, configuration, external plugins, and version history
are unchanged.

### Evidence

- RED: before changing implementations, seven assertions across the plugin and
  core capability suites failed because the adapters still returned the
  synthetic success values. The previous runtime test also lacked the
  temporary Electron user-data setup required by A10's fail-closed startup;
  the integration fixture now supplies an isolated temporary directory and
  closes the durable store. Independent review also added a manifest
  regression: before removing stale grants, it failed on the memory adapter's
  blanket filesystem and memory permissions. Lifecycle and core-provider RED
  fixtures also proved that old SQLite permission metadata remained stale and
  the fallback provider retained broad grants.
- GREEN: four focused suites pass **329/329**: 99 plugin/capability/lifecycle
  tests and 230 Pi runtime tests. They cover unavailable results through the
  `PiSdkRuntime` registry, A16 model-selection checks, core-provider fallback,
  each affected adapter, and the absence of unused permission grants and
  dependency declarations. The SQLite migration test preserves a durably
  disabled state while replacing only the exact built-in permission metadata,
  and retains the saved user configuration.
  Desktop TypeScript typecheck passed. Targeted Biome check exits 0 with
  **36 warnings** and no errors; warnings in the checked files predate this
  patch. Two formatting corrections were limited to the changed test and
  lifecycle code. No rule suppression or broad formatting was applied.
- Independent review found no blocker in fail-closed adapters, manifest
  permission/dependency cleanup, or exact-version startup metadata
  reconciliation. It noted that there are no production callers of the core
  fallback's `customImplementations` parameter; such a consumer now receives
  no implicit broker permission metadata and would need an explicit permission
  API if that extension point becomes productive.
- Product callsite search found no non-test execution callsites for these
  capability IDs; the real runtime services remain separate and intact. This
  is source evidence, not proof that every downstream consumer avoids direct
  registry use.
- Remote workflow `38033646784` on commit `4fa6894` passed
  `typecheck · test · biome` (**402/402 files, 4,545 passed, 8 skipped of
  4,553 tests**), plugin-containment on Ubuntu/macOS/Windows, Verifier-First
  runtime regressions, and compile-only sandbox checks. Biome reported 325
  warnings and 50 infos, with no errors; TypeScript passed. Windows x64
  packaging (`38033646769`) and macOS x64/arm64 packaging (`38033646794`)
  passed. No probes or enforcement scenarios ran.
- The global workflow remains red because Supabase pgTAP test 22 in
  `17_free_monthly_renewal.test.sql` expected `2026-10-31` and received
  `2026-10-30` for the second monthly period. This remains unresolved and is
  not classified as pre-existing.

### Limits

These built-in capability IDs now report their unavailable state honestly; this
milestone does not create new implementations for them. A caller that directly
uses a capability plugin must handle `CapabilityUnavailableError`. The focused
runtime test proves that the productive runtime registry returns that error.
Permission metadata reconciliation requires exact host plugin ID
and version identity; unsupported persisted versions remain quarantined under
the existing startup rules and are not rewritten from a different manifest.

## Milestone 10 — A22 durable event cursor, bounded reads and renderer paging

**Status: partially mitigated; page APIs now drive timeline/history/source reads. Individual payloads and some compatibility/runtime consumers remain unbounded.**

The `agent_events` table now has a monotonic `INTEGER PRIMARY KEY AUTOINCREMENT`
cursor while retaining the existing public event identity. Existing databases
are migrated transactionally by copying rowids and all payload fields, then
recreating the session foreign key. A session index supports keyset reads.
`listAgentEventPage` validates cursor inputs, captures a fixed upper cursor on
the first read, and returns at most 256 base rows in cursor order. This keeps
each base SQLite result allocation and JSON parse batch bounded and prevents
timestamps that move backward from reordering replay. The complete-list
compatibility API folds page results through one accumulator, so deltas that
cross page boundaries still fold correctly. Pages expand matching message,
thinking, and tool-result streams when their lifecycle or completion event is
visible, so a page boundary does not turn a complete answer/output into a
suffix or hide it entirely. Expansion preserves the raw page cursor, but can
add companion events beyond the base row cap.

The main activity timeline and transcript now consume cursor pages. The
activity view loads older pages on demand, fences late page completions across
session changes, and preserves a fixed snapshot. The transcript starts from
the newest page and can load earlier history without replacing the selected
session's state. Prompt backfill, pending questions, group summaries and source
references use scoped page queries. Main-chat sources load the full run through
run-scoped pages; partial page-local references are suppressed while lookup is
pending or unavailable, and the UI reports that state.

The Pi runtime's last-assistant and run-assistant output readers now use the
bounded page APIs instead of materializing `listAgentEvents`. Past-chat context
uses raw cursor pages so each persisted delta is consumed once; the ordinary
expanded page API can repeat a complete stream when that stream crosses a page
boundary. Transcript assembly retains only the configured 60 KiB output cap
while preserving legacy prompt backfill and message trimming.

### Evidence

- RED: four focused regressions failed before the change: page API missing,
  session index absent from the query plan, page-size bound unavailable, and
  SQLite reused rowid 8 after deleting the prior maximum rowid 12. During
  integration, four existing event-store checks also caught Node SQLite's
  result-column name behavior for `rowid`; aliasing those selected columns
  restored the rowid consumers. The A17 runtime test that reads a `run.started`
  row also now guards the corrected alias.
- Earlier store GREEN: `agent-event-store.test.ts` plus `agent-events.test.ts`:
  **55/55**.
  Coverage includes inverted timestamps, fixed-snapshot paging, inserts after
  page one, a session-index query plan, deltas folded across a page boundary,
  maximum page size, sanitized malformed-payload errors, row/payload/timestamp
  preservation, foreign-key integrity, and cursor non-reuse after deletion.
  The exact A17 runtime restore test passed (**1 passed, 229 skipped by exact
  name filter**). Related context, rollback and group runtime suites passed
  **40/40** in the same validation cycle.
- Desktop typecheck passed (exit 0). Targeted Biome passed (exit 0), with eight
  warnings in the large runtime test file and no formatting errors; their
  origins were not baseline-classified. `git diff --check` passed.
- Independent static review found no concrete migration or foreign-key
  blocker. It confirmed bounded SQL batches and preservation of A17 fields,
  while identifying the remaining unbounded aggregate response below. Review
  did not execute tests.
- Additional RED/GREEN regressions reproduced and fixed a newest-page read
  returning only the last message delta, completion-only pages omitting a full
  assistant/tool result, and a thinking completion marker omitted at a page
  boundary. Source-hook tests now distinguish pending, failed, and successfully
  empty run lookups. The timeline suppresses page-local partial source sets
  while a full run-scoped lookup is pending or failed.
- Run association is restored with the assistant message only when the prior
  run boundary is unambiguous in the same session and before the fixed page
  snapshot. A late response after a terminal marker is not attributed to the
  old run. Run-scoped source paging fails closed for missing boundaries,
  overlapping runs, non-advancing cursors, or a changed snapshot; the renderer
  reports those lookups as unavailable instead of successful empty results.
- Latest local validation: **264/264 tests in 12 changed-area Vitest files**;
  desktop TypeScript typecheck passed; Biome passed for all 26 changed code
  files; `git diff --check` passed. This revision has not yet received PR CI.
- Source-page retention follow-up: `useRunSources.ts` previously retained each
  selected run's completed event array until a later load happened to sweep its
  expired cache entry. It now keeps only in-flight request deduplication and
  releases completed arrays after consumers finish. RED: the remount regression
  failed before the change (`listEventPage` was called once instead of twice).
  GREEN: with `Date.now()` held constant so the old cache would remain valid,
  the source hook passes **6/6 tests**; six source/chat/group UI files pass
  **83/83 tests**. Desktop typecheck, targeted Biome, and `git diff --check`
  pass. Independent review found no blocker and confirmed the pagination,
  snapshot guards, and in-flight deduplication remain. In-flight full-run
  accumulation is still unbounded.
- The EventHub retained folded history from active sessions after all views
  unsubscribed. RED: the new active-run regression expected release after the
  handoff timer but received the retained `run.started` event. GREEN: inactive
  buffers are released once the 16 ms pending window closes; other sessions
  remain isolated, and the existing prepared-handoff test still retains and
  delivers events across a flush. The persisted event store remains the source
  for later paged reload. The latest focused renderer integration run passed
  **30/30 tests** across the hub, activity timeline, and chat history; desktop
  typecheck passed, targeted Biome and `git diff --check` pass.
  Independent review found no blocker; it confirmed paged reload and
  pre-dispatch prepared-intent protection. A volatile `tool.delta` preview can
  disappear if a call is interrupted before durable `tool.started` while no
  pane is subscribed. A failed early prompt path without a persisted run event
  may retain a local-only optimistic item and remains a bounded follow-up risk.
- Independent review confirmed the main-chat source lookup is run-scoped and
  requested explicit pending/failure state and inclusion of `thinking.completed`
  in stream expansion. A later review found and drove two run-association fixes;
  final review found no blocker in the session/snapshot/terminal/overlap guards.
  The review did not run tests.
- Reader follow-up RED/GREEN: a focused past-chat regression first returned
  the same expanded `hello world` message twice when it appeared on both sides
  of a page boundary. A real SQLite fixture reproduces this behavior in
  `listAgentEventPage`; the raw-page API returns the persisted deltas once and
  retains legacy prompt backfill. A separate regression showed that
  `lastAssistantOutput` could append an expanded answer twice when the assistant
  start was the last row of a page. It now uses raw pages; an actual store-backed
  helper fixture places the start at cursor 256 and confirms the answer is
  exactly `complete answer`. Focused event-store/helper/context suites passed
  **89/89**, and the full offline Pi runtime test file passed **232/232** with
  no probe execution. Desktop typecheck passed. Targeted Biome exits 0 with one
  existing unused-import warning in `pi-sdk-runtime.ts`, unchanged from the
  parent revision. Independent re-review found no blocker and verified both
  duplicate-stream fixes. The raw-page API explicitly documents legacy prompt
  backfill; those synthetic prompt items still have no byte cap.
- Run-source accumulation follow-up: `useRunSources` and the main-chat group
  source loader previously retained every event from each selected run until
  extraction finished. They now feed each fixed-snapshot page directly into a
  collector, which retains active tool-call state and at most 24 extracted
  references rather than a run-wide event array. RED: the collector regression
  failed because the incremental API did not exist; the hook regression now
  splits a real source-producing call across two pages and asserts the pinned
  snapshot/cursor requests. GREEN: the two source test files passed **9/9**;
  the source/timeline/history/event-hub regression set passed **39/39**;
  desktop typecheck, targeted Biome and `git diff --check` passed. Independent
  review found no blocker and confirmed run-scoped snapshot paging, cancellation
  guards, and source compatibility. It identified the byte-cap gap below.
  Remote workflow `38048585232` on `f406ccd` passed Biome/typecheck and all
  **4,606 Vitest tests** (**8 skipped**, 408 files). The same workflow's Ubuntu
  containment job failed only the unchanged `FastVectorDistance` timing check
  at **0.121070 ms** against **<0.1 ms**; its 280 other tests passed. macOS and
  Windows containment, Verifier-First, and compile-only sandbox jobs passed.
  pgTAP test 22 again received **2026-10-30** where it expected **2026-10-31**.
  Windows x64 and macOS x64/arm64 packaging passed. These timing results are
  not classified as pre-existing or solely unstable.

### Limits

The store-level `listAgentEvents` compatibility helper still drains every
page into one array, but static callsite search found no production consumer.
The unbounded `agent:list-events` IPC handler and preload method have now been
removed; the app uses `agent:list-event-page` with fixed cursor snapshots.
Run-source loading no longer retains the full selected-run event array; while
a lookup is in flight, it retains active tool-call state and the bounded
source list. Active calls, their selected arguments, and output text from an
unfinished external-source tool still have no byte cap.
The final assistant-output helpers retain the complete selected message, and a
single raw event row can still contain an arbitrarily large payload. Inactive
EventHub buffers are released after the short subscriber handoff window; live
subscribers and prepared handoffs retain their events.
Base row count is capped, but companion stream expansion and individual
serialized payloads have no byte cap, so memory and IPC size can still be large
for unusually long results. A volatile partial `tool.delta` can be unavailable
after an inactive handoff buffer is released if the call never reaches a
durable `tool.started`; a failed early prompt can also retain local optimistic
events. These remain follow-up gaps; A22 is partial. Cursor
order is insertion order rather than
`created_at, rowid`; inverted timestamps and page continuity are covered, but
broader product ordering expectations remain a compatibility risk. Run IDs
are inferred from serialized event order because assistant lifecycle events do
not persist a run ID; malformed or missing terminal events intentionally make
source history unavailable, and simultaneous runs within one session are
rejected rather than mixed.

### Integrated remote validation on `effa4ee`

- Workflow `38034484183`: `typecheck · test · biome` passed. Biome checked
  **1,139 files** with **325 warnings, 50 infos, and no errors**; workspace
  TypeScript checks passed. Vitest passed **403/403 files, 4,551 tests**, with
  **8 skipped** of 4,559 in **91.34s**. The workflow's explicit test-name
  filter excluded the authorized blocked adversarial/runaway cases.
- Verifier-First runtime regressions passed, including A17 evidence and A21.2
  lifecycle checks. Plugin-containment passed on Ubuntu, macOS, and Windows.
  The sandbox job only compiled probe targets; it did not run probes.
- Windows x64 packaging (`38034483781`) and macOS x64/arm64 packaging
  (`38034483855`) passed, including artifact uploads.
- The global workflow's only failure was Supabase pgTAP test 22 in
  `17_free_monthly_renewal.test.sql` (**1,021/1,022 passed**): expected
  `2026-10-31`, received `2026-10-30`. On the run date, the fixture's 40-day
  backdated signup lands on August 31; the function's `signup + 1 month` anchor
  clamps to September 30, then its next month-end becomes October 30, while the
  assertion computes `signup + 2 months` directly. The test and migration
  have zero diff against `origin/main`, and the same assertion failed on
  earlier PR runs. This billing issue is outside A01–A25 and was not changed.
- No enforcement or adversarial probes ran; `PR #191` remains open and Draft.

### Follow-up CI on `12f1dc6`

- Workflow `38041900481`: `typecheck · test · biome` passed. The complete
  Vitest job reported **406/406 tests passed**; typecheck and Biome passed.
  The manual-only probe-workflow guard passed. Verifier-First regressions and
  plugin-containment jobs passed on Ubuntu, macOS, and Windows. The sandbox
  target was compile-only; no probe target was executed by that workflow.
- macOS packaging run `38041900486` and Windows packaging run
  `38041900488` both passed.
- The only failed job in the workflow was Supabase pgTAP test 22 in
  `17_free_monthly_renewal.test.sql`: expected `2026-10-31`, received
  `2026-10-30`. It remains unresolved and is not treated as pre-existing
  without the base evidence documented above.
- A local verification command intended to select one file passed the
  package script's fixed full-suite paths. I cancelled it when its output
  showed the broad selection; `wasm-sandbox.test.ts` had started and reported
  a timing failure before cancellation. The interrupted run cannot establish
  which cases completed, so no assertion is made that restricted cases were
  skipped. It is not counted as validation and was not repeated. Subsequent
  A22 verification invoked only the six source/chat/group UI files, desktop
  typecheck, and targeted Biome.

### CI on `43485f6`

- Workflow `38042639514`: Biome and workspace typecheck passed. Vitest ran with
  the CI safety filter: **4,586 passed, 8 skipped, 1 failed** across 406 test
  files in **144.30s**. The sole test failure was
  `FastVectorDistance: computes cosine similarity and distances in < 0.1ms`;
  it measured **0.124834 ms**. The benchmark source and limit were not changed
  by this A22 patch. The previous CI on `12f1dc6` passed all **4,586 tests**;
  an earlier CI on `23cb8ed` also failed this timing assertion at **0.100758
  ms**. These observations do not establish root cause or justify calling the
  failure pre-existing or solely unstable.
- Plugin-containment passed on Ubuntu, macOS, and Windows; Verifier-First
  regressions passed; the sandbox job compiled probe targets only. No probe
  target was run in this workflow.
- Supabase pgTAP again failed only test 22 in
  `17_free_monthly_renewal.test.sql`: received `2026-10-30` and expected
  `2026-10-31`. This remains unresolved. Windows x64 packaging
  (`38042639515`) and macOS x64/arm64 packaging (`38042639512`) subsequently
  passed. The benchmark failure remains unresolved and is not classified as
  pre-existing or exclusively flaky.

### EventHub transient-history follow-up on `c63d53a`

- The first EventHub fix released terminal sessions on last unsubscribe; this
  follow-up also bounds inactive active-run history. RED: after the last
  subscriber left, the new regression still found `run.started` in memory after
  the 16 ms flush. GREEN: the hub releases that buffer once the handoff window
  closes and no subscriber or prepared dispatch exists. Prepared events are
  explicitly tested across a timer flush and delivered exactly once. A seed
  merge is not released mid-merge.
- Runtime UI integration passed **30/30 tests** across
  `agentEventHub.test.ts`, `ActivityTimeline.test.tsx`, and
  `ChatPane.history.test.tsx`; desktop typecheck, targeted Biome, and
  `git diff --check` passed.
- Independent review found no blocker. It verified the paged reload path and
  protection for a prepared pre-dispatch handoff. It noted that a volatile
  `tool.delta` preview can be lost if a call stops before durable `tool.started`
  while no pane is subscribed. A rejected early prompt without a durable run
  marker can still leave an optimistic renderer item; that residual does not
  create persisted audit evidence.
- Remote CI `38043797775` on `c63d53a`: Biome/typecheck passed; Vitest passed
  **4,589 tests with 8 skipped across 406 files**; plugin containment passed on
  Ubuntu/macOS/Windows; Verifier-First regressions passed; sandbox targets were
  compile-only. The sole failure was pgTAP test 22 in
  `17_free_monthly_renewal.test.sql` (expected 2026-10-31, got 2026-10-30).
  Windows packaging passed; macOS packaging was still running at the last
  status check.

### Run-scoped assistant-output paging follow-up

- Root cause: `PiSdkRuntime.runAssistantOutput(sessionId, runId)` called the
  compatibility `listAgentEvents(sessionId)` API, which folded every run in a
  session into memory before discarding events outside the target run. The
  output is used by ResponsePolicy and Verifier-First settlement, so reducing
  this read must keep all assistant deltas from the exact completed run.
- Added `listAgentRunMessagePage`, which validates the existing single-run
  boundary, pins a snapshot cursor, caps each read at the existing page limit,
  and returns only message lifecycle/delta events within that run. The runtime
  now concatenates those pages in cursor order; the streamed and persisted
  assistant text remains unchanged. A16/A17 and ResponsePolicy state contracts
  are unchanged.
- RED/GREEN: the store test failed before implementation because the run-scoped
  message-page reader did not exist. GREEN: tests cover prior/target/later run
  isolation, a delta split across pages, and 130 delta rows across the default
  128-row page boundary (128 + 4 rows; no delta loss or duplication). An
  offline Pi SDK integration streamed 130 assistant chunks through the
  production runtime; the exact transcript was preserved and ResponsePolicy
  evaluated all 130 paragraphs, crossing a threshold set at 129.
- Targeted Vitest: store paging **2 passed, 70 skipped**; productive Pi runtime
  multi-page response **1 passed, 230 skipped**. Desktop TypeScript typecheck
  passed. Targeted Biome passed with **9 warnings** at existing diagnostics in
  the runtime/test files and no errors; no formatter was run over unrelated
  files. `git diff --check` passed.
- Independent review found no blocker in the fixed snapshot, cursor ordering,
  boundary isolation, or response preservation. It reviewed the 130-delta
  fixture and confirmed it exercises the default-page continuation without
  synthetic concurrency. This follow-up later replaced the unbounded IPC with
  the existing page API; no production full-history caller remains. The
  internal store helper still aggregates for legacy test/internal compatibility.
- Parent commit `87e6466` remote CI (`38044280905`) passed typecheck/Biome,
  Verifier-First regressions, plugin-containment on Ubuntu/macOS/Windows, and
  compile-only sandbox targets. Vitest reported **4,588 passed, 8 skipped,
  1 failed across 406 files**: `FastVectorDistance` measured
  **0.13537399999995614 ms** against its **<0.1 ms** benchmark assertion.
  pgTAP test 22 again expected `2026-10-31` and received `2026-10-30`;
  neither failure is attributed to this A22 change. Windows x64 packaging
  (`38044280896`) and macOS x64/arm64 packaging (`38044280877`) passed. The
  current run-scoped paging change awaits its own remote CI after publication.

### Remote CI on `40de2ec`

- Workflow `38045043547`: Biome and desktop typecheck passed. Vitest completed
  **4,591 passed, 8 skipped, 1 failed across 406 files** in **147.65s**. The
  sole failure was `FastVectorDistance: computes cosine similarity and
  distances in < 0.1ms`, measured at **0.10037799999997787 ms** against the
  unchanged `<0.1 ms` assertion. The result is recorded without classifying the
  failure as pre-existing or solely unstable.
- Verifier-First runtime regressions, plugin containment on Ubuntu/macOS/
  Windows, and compile-only sandbox target checks passed. The sandbox workflow
  compiled targets only; no probe ran. pgTAP test 22 in
  `17_free_monthly_renewal.test.sql` again expected `2026-10-31` and received
  `2026-10-30`; it remains unresolved pending evidence-based comparison.
- Windows x64 packaging (`38045043549`) and macOS x64/arm64 packaging
  (`38045043554`) completed successfully.

### A22 legacy full-history IPC removal

The app still registered `agent:list-events`, which returned
`listAgentEvents(sessionId)` and accumulated every page into one full-session
array. Static search found no production renderer consumer; timeline, chat,
group, and source consumers use the bounded cursor-page API. The legacy IPC
handler and preload/type declaration are removed, while `listEventPage` and
the internal store helper remain.

- RED: the new IPC regression failed before the removal because the full-history
  handler was registered. GREEN: after removal it asserts the old handler is
  absent and the bounded page handler remains. Five focused IPC, source, and
  group-renderer files passed **87/87**. Targeted Biome passed for the nine
  changed files; desktop typecheck passed locally, exit 0. `git diff --check`
  passed.
- Independent read-only review found no blocker. It confirmed no production
  consumer remains and the app still uses the existing page API. The removed
  compatibility is limited to any external consumer of the internal preload
  bridge, for which no repository evidence exists.
- Remote CI run `38053374062` on `e1f175e`: Biome/typecheck passed; global
  Vitest reported **4,606 passed, 8 skipped, 1 failed across 408 files**. The
  failure was `FastVectorDistance` at **0.113051 ms** against `<0.1 ms`.
  All three containment jobs, Verifier-First regressions, sandbox compile-only,
  and PTY cancellation passed. Supabase pgTAP test 22 failed with
  `2026-10-30` received versus `2026-10-31` expected. Windows and macOS package
  jobs were still running at this update.
- Residual: the store-level `listAgentEvents` helper can still aggregate a full
  session when explicitly called by internal code/tests, but static search
  found no productive callsite. Individual persisted payloads and selected
  source-tool arguments/output still have no byte cap.

### A01/A04 review-session loader regression guard

`review-service.ts` already configured the productive `startAgentReview` path
with `noExtensions: true`; this follow-up adds a regression test for that
boundary and for A16 model preservation. A distinct selected model and default
model are injected, and the test verifies that `startAgentReview` passes the
selected object to `createAgentSession` while capturing the loader options
used by the real service callsite.

- RED: temporarily setting the review loader option to `noExtensions: false`
  made the new loader assertion fail. The production setting was restored
  before commit. GREEN: the synthetic `startAgentReview` path returns the
  expected result and asserts the selected model, no extension discovery paths,
  loader reload and session creation. The focused file passed **5/5**; desktop
  typecheck passed, targeted Biome passed with no diagnostics, and
  `git diff --check` passed.
- Independent review approved the regression guard and found no blocker. Its
  loader and session are mocked, so this test proves callsite wiring only; it
  cannot execute extension code. The separate Pi SDK containment fixture uses
  the real loader to cover the `noExtensions` behavior. No production code
  changed in this follow-up.
- Published as `5d002c7` on PR #191. Its remote CI and packaging runs are
  pending. This guard strengthens A01/A04 evidence but does not supply OS
  process isolation or justify execution of external plugins.

### Remote CI on `5d002c7`

- Workflow `38054388670`: Biome/typecheck passed. Global Vitest passed **4,608
  tests, 8 skipped across 408 files** in **145.68s**. The dedicated
  Verifier-First regression job, sandbox compile-only, PTY cancellation,
  Windows/macOS plugin-containment checks passed. The sandbox job compiled
  targets only; no probe ran.
- Ubuntu plugin-containment ran **279 passed, 7 skipped, 1 failed**. The sole
  failure was `FastVectorDistance` at **0.103282 ms** against its unchanged
  **<0.1 ms** assertion. This is recorded without classifying it as pre-existing
  or solely environmental. pgTAP ran 1,022 tests and failed test 22: actual
  `2026-10-30`, expected `2026-10-31`. No base comparison was performed, so
  neither failure is given a baseline classification.
- Windows and macOS package workflows for `5d002c7` remain in progress at this
  update. PR #191 remains open and Draft.

### Remote CI on documentation-only commit `8a47dbb`

This commit changes only the remediation report. Workflow `38054681114` again
passed Biome/typecheck and global Vitest (**4,608 passed, 8 skipped across 408
files**, **149.31s**). Verifier-First, sandbox compile-only, PTY cancellation,
and plugin containment on Ubuntu, macOS and Windows all passed. pgTAP test 22
again failed with `2026-10-30` received and `2026-10-31` expected. The
`FastVectorDistance` failure from the prior Ubuntu run did not recur in this
run; no baseline comparison or instability classification is claimed. Windows
and macOS packaging runs for this commit remain in progress at this update.

## Remote CI on IPC stream commit `54031ce`

On remote head `54031ce9`, Biome and desktop typecheck passed. Global Vitest
reported **4,607 passed, 8 skipped, 1 failed across 408 files**; the sole
failure was `FastVectorDistance` at **0.12641000000002123 ms** against the
unchanged `<0.1 ms` assertion in `wasm-sandbox.test.ts:989`. No base comparison
was performed, so the failure is not classified as pre-existing or solely
unstable. Supabase pgTAP/Deno, Verifier-First regressions, safe protocol tests,
PTY cancellation, sandbox compile-only, and containment on Ubuntu/macOS/Windows
passed; no probes ran. Windows x64 and macOS x64/arm64 packaging and artifact
uploads completed successfully. This run predates the local protocol-v2
cancellation follow-up above.

## Current matrix

| Finding | Current status | Implementation state / next evidence |
|---|---|---|
| A01 | Partially mitigated | Facade fails closed and Pi chat/review no longer auto-load project/user extensions. The shared protocol validates bounded frames and strict schemas; v2 adds distinct cancellation and rejects v1 on both worker handshake and host-response decode. `Dispatcher::new` now requires a non-cloneable assessment token, but the token is not bound to a process/stream, has no production adapter, and does not prove OS confinement. No productive executor exists; isolation and production wiring remain unproven. Hostile execution proof remains blocked. |
| A02 | Partially mitigated | The shared resource-policy contract records the approved CPU, memory, time, output, IPC, process, hostcall and concurrency ceilings. No platform adapter enforces them, and no process-tree preemption/reap path is integrated. Do not run blocked probes. |
| A03 | Partially mitigated | Chat/review auto-discovery remains blocked. Host catalog lookups, built-in catalog entries, loader results, and capability provider queries expose immutable metadata descriptors without lifecycle/implementation callbacks. `PluginLoader`, `PluginLifecycleService`, and `CapabilityRegistry` now keep trust/authorization maps, checkpoints, provenance state, source/executor references, and internal helpers in ECMAScript `#private` fields/methods; unused loader/service registry accessors were removed after full-repository callsite search found no consumers. Exact source references remain within trusted in-process wiring; this is reflective encapsulation, not process isolation. The v2 IPC contract carries host-only digest, origin, trust, session/workspace/run and generation provenance, but has no production caller and does not establish trust on its own. |
| A04 | Partially mitigated | External Pi extension ingress is disabled for chat and review; the review callsite guard covers loader flags and session creation. Registry provider execution remains dispatched through `CapabilityRegistry.execute`; rollback uses opaque registry-owned checkpoints. Public catalog/registry lookup APIs no longer return implementation references. The shared IPC dispatcher validates exact grants and cancellation in synthetic fixtures, but built-ins remain trusted in-process and no OS-backed dispatcher/lifecycle boundary is integrated. |
| A05 | Partially mitigated; unpreemptible WASM timeouts now fail closed | Both `WasmCapabilityHost.executeWasm` and its public `createInstance` factory reject positive `timeoutMs` before compilation/instantiation because synchronous in-process WASM cannot be preempted by a JavaScript timer. Trusted in-process calls without a timeout retain their behavior. Memory/callable/fuel-import protections remain; external plugin wiring and blocked enforcement proof remain unavailable. |
| A06 | Partially mitigated; no-grant WASI denial revalidated | All imported WASI modules are denied before instantiation; exact synthetic tests ran with instantiation asserted unused. Grant-backed env/preopens and host isolation remain unavailable. |
| A07 | Partially mitigated; FilesystemBroker now fails closed before metadata lookup | All path grants return denial before filesystem metadata or content I/O; `readFile`/`writeFile` audit and throw until a handle-bound executor exists. This is no longer a path-containment proof. No production consumer; scoped safe I/O and OS-handle binding remain open. |
| A08 | Partially mitigated; NetworkBroker now fails closed | Exact public-domain/IP grants no longer return allow without DNS-pinned connection enforcement. Audit reasons still distinguish protected ranges from ordinary public destinations denied for absent I/O. The broker has no production caller. DNS pinning, redirect enforcement, actual connection control, and production wiring remain open. |
| A09 | Partially mitigated; ShellBroker now fails closed | `ShellBroker.canExecute` always denies and audits until a platform-isolated executor is integrated, so exact grants cannot authorize known or unknown command strings. Static search found no production caller. `GitBroker` requires an exact operation grant in its contract, but it also has no production caller and therefore does not gate actual Git network operations. Trusted Harness and other built-in Git paths remain independent. A production dispatcher, scoped argv authority, Git network authorization, and OS execution boundary are still absent. |
| A10 | Mitigated for host-catalog plugins; legacy activation blocked | Startup uses exact host-catalog versions, opens the durable store before deferred activation, reconciles disabled/tombstoned state, and restores dependency order. `MODUS_PLUGINS` now requires `MODUS_PLUGIN_LIFECYCLE`; no direct bootstrap path remains. External artifact identity and crash-consistent package deployment remain unavailable. |
| A11 | Mitigated | Disable transaction rollback restores runtime or leaves provider quarantined; broader crash atomicity remains unproven. |
| A12 | Mitigated | Per-store lifecycle queue serializes shared DB/graph operations; stress/fault injection beyond targeted tests remains open. |
| A13 | Mitigated; reflective encapsulation and detached graph readers | Persisted Safe Mode policy is service-derived; transitions are validated before reload and restoration retains quarantine. Runtime registry, loader, lifecycle-owned state/unlocked helpers, manager-owned references/state, startup promises, and HarnessKernel use ECMAScript-private slots/methods. The raw SQLite getter was removed; store and manager operational APIs remain. Graph query methods return detached snapshots and copy caller-owned plugin requirement arrays, while the graph instance retains explicit public mutation methods. This does not create an in-process or OS boundary. Storage corruption/power-loss proof and a read-only diagnostics API remain open. |
| A14 | Mitigated | SemVer constraints, active-provider checks, cycle preflight/recovery, and dependent suspension are covered; an OS boundary remains absent. |
| A15 | Partially mitigated | Pi cancellation propagates to terminal/app launches and the trusted CodeGraph CLI; active root-run agent processes are selected by session+run and cancelled, and cancellation telemetry is distinct. App cancellation preserves cleanup errors and refuses to signal an exited tracked leader. UI reports unconfirmed stop outcomes in workspace/session/process scope with an explicit dismiss action. CodeGraph abort/timeout now waits for the shared process-ops result; Windows taskkill is time-bounded. POSIX confirms the original process group; Windows confirms the leader PID after a tree-termination request. Escaped descendants, PID/PGID reuse races without stable OS handles, non-cooperative in-process work, and hard OS preemption remain unproven. |
| A16 | Prior fix preserved | Explicit user-selected model identity and provider. |
| A17 | Prior fix preserved | Verification evidence integrity. |
| A18 | Implemented and independently reviewed; integrated checks pass | SQLite source of truth, durable per-recipient broadcast ACKs, bounded inbox queries, host-derived group scope, expiry-safe ACKs and lazy cleanup. Latest recorded workflow `38081920060` passed Biome/typecheck, Supabase pgTAP (20 files/1,041 tests), PTY/protocol/security regression jobs and platform packaging. Its global Vitest job had one `FastVectorDistance` timing failure; it is not classified as pre-existing or solely environmental. |
| A19 | Prior A21.4 implementation preserved | Spill authorization, persistence, quotas, and recovery. |
| A20 | Partially mitigated; same-connection mutation detection and reflective state encapsulation | Audit events and checkpoints persist in SQLite; immutable snapshots, transactional retention, append-time verification on audit revision changes, and checkpoint comparisons detect ordinary record changes through the same or another connection. The logger's database handle and chain state, plus the fail-closed facade's logger reference, now use ECMAScript `#private`; this prevents ordinary property reflection only. No independent signing key or database access boundary exists, and public logger APIs remain available to code holding a reference. |
| A21 | Prior A21.1–A21.6 implementation preserved | Harness integrations and lifecycle; no broad reimplementation. |
| A22 | Partially mitigated; productive event reads and renderer source lookups are paged, bounded, and fail closed | Cursor-page reads drive IPC, timeline/history, source lookup and Pi output; the old `agent:list-events` bridge endpoint is removed. Collector-local budgets cover active call identities, argument traversal/references, unfinished external-tool output, and retained source metadata; ambiguous active tool-call IDs across runs invalidate attribution. Overflow is sticky: complete lookup fails, the main-chat hook marks the run unavailable, the group hook exposes unavailable status, and synchronous timeline rendering preserves the answer while marking sources unavailable. Renderer lookups admit at most four active loads and 256 queued loads; releasing the last view stops pagination after any already in-flight page returns. Run-scoped tool-evidence and assistant-message pages preflight `payload_json` bytes under a SQLite savepoint. Pages are split at event boundaries to stay within 8 MiB when possible; an indivisible event larger than 8 MiB is returned alone to preserve complete content. The cap excludes IPC/page envelopes. This does not bound generic/non-run event pages, stream expansion, individual event allocations, aggregate requests, renderer heap/RSS, or the existing 24-source display cap, so A22 remains partial. RED/GREEN, review, local checks, and current remote CI are recorded below. The prior global run's benchmark timing failure and the current successful run are both recorded without assigning a definitive root cause. |
| A23 | Mitigated; integrated checks pass | Synthetic capability outputs and the generic core `status: ok` fallback now fail explicitly with `CapabilityUnavailableError`; stale declared grants are reconciled by exact host identity/version; separate Pi runtime services, A16 selection, and A17 evidence flows are preserved. Independent review found no blocker. Workflow `38081920060` passed the relevant feature jobs, Supabase pgTAP (20 files/1,041 tests), containment, compile-only sandbox and Windows/macOS packaging. The same run had one unrelated-to-A23 global Vitest timing failure, without a baseline classification. |
| A24 | Partially mitigated; artifact admission capped, isolated execution unproven | Cache has LRU entry/source-byte caps; namespaces are hashed up to 256 UTF-16 code units and longer ones bypass retention. WASM inputs over the existing 32 MiB limit are rejected using intrinsic view metadata, then hashed and compiled from one fixed snapshot. Cache counters do not measure native compiled memory or compiler overhead. A05 supplies measured failure metrics. WASI remains denied and stdio capture is unavailable; the in-process host is not an OS-isolated executor. |
| A25 | Mitigated; prior fix preserved and revalidated | `allow-workspace` requires workspace+tool identity and lookup keys include both plus action/target; the Pi runtime supplies persisted host workspace identity across worktree cwd changes. Unknown tools are blocked before permission prompting and are not read-only safe. Safe focused validation: 52 permission-store/permission-extension/tool-registry tests and one productive Pi runtime workspace-scope test passed. A two-workspace synthetic store test passes; external tool/plugin execution remains disabled. |

This matrix will be updated as each independent remediation is completed and
checked. No Checkpoint 2/3 or Guardian Task 5–7 status is changed here.

## A03/A04 incremental provider and catalog boundary

The public host catalog and capability registry no longer return executable
references through lookup APIs. Host catalog `authorize`/`resolve` methods and
the built-in entry list return metadata-only manifests; provider descriptors
are constructed from an explicit metadata allowlist, so extra callable fields
cannot escape. `PluginLoader` keeps the exact trusted source privately for
provider registration and lifecycle hooks. Internal plugins continue through
the existing registry dispatcher and lifecycle service.

- RED: focused regressions reproduced both review findings: direct catalog
  results contained lifecycle/provision callbacks, and a provider's extra
  `debugExecute` alias appeared in active/listed provider results.
- GREEN: after the changes, catalog descriptors omit lifecycle and
  implementation properties, and provider descriptors contain no callable
  alias. The combined catalog, registry, loader, lifecycle, rollback,
  dependency, and Pi SDK runtime rerun passed **7 files / 409 tests**. An
  intermediate lifecycle regression exposed non-identical descriptors in the
  test catalog; stable per-source descriptors fixed it, and the final lifecycle
  suite passed **40/40**.
- Independent read-only review found no other lifecycle, rollback or metadata
  regression, and identified the two RED routes above. Both are addressed in
  this patch. Review was source-only; it did not prove an OS process boundary.
- Biome passed the touched-file set with no errors (**38 warnings, 2 infos**);
  no mass formatting or rule suppression was used. Desktop typecheck passed and
  `git diff --check` passed.
- Workflow `38085364845` on `31f9d02`: Biome/typecheck, Supabase pgTAP/Deno
  (**20 files, 1,041 tests**), PTY cancellation, safe IPC protocol fixtures,
  Verifier-First, compile-only sandbox, and filtered containment on Ubuntu,
  macOS, and Windows passed; no probe ran. Windows x64 and macOS x64/arm64
  packaging also completed successfully in workflows `38085364862` and
  `38085364853`.
- The global Vitest job reported **4,611 passed, 8 skipped, 3 failed across 408
  files**. Two `qa-evidence.test.ts` ancestor/UID assertions expected `tests`
  but received `undefined`; the third was `FastVectorDistance` at **0.115946
  ms** against `<0.1 ms`. The targeted QA tests passed locally on the same
  commit, but the discrepancy has not been explained. No failure is classified
  as pre-existing or solely environmental.
- Residual: trusted built-in callback code still runs in the host process.
  External plugin execution remains disabled. The IPC v2 dispatcher still has
  no platform executor or productive caller, so A01–A04 process containment is
  not proven. This increment does not start Guardian Tasks 5–7 or change any
  checkpoint.

#### A03 host-registered catalog provenance follow-up

`PluginLoader.authorizedEntry` previously accepted an executable source when
an arbitrary `PluginManifestCatalog` returned a descriptor labeled `core` or
`official`, even when that exact catalog/source pair had never been registered
by host-owned catalog wiring. The loader now requires both catalog approval
and the matching private trusted-entry registration. The shipped built-in
catalog and `TestPluginCatalog` keep their registration path; arbitrary custom
catalog implementations can no longer turn their returned trust label into
execution authority.

- RED: the focused regression showed the unregistered catalog's `core` claim
  caused `PluginLoader.load` to resolve with status `loaded`; the stronger
  focused assertion observed `rejected: false`, `lifecycleHookCalled: true`,
  and active provider `@test/unregistered-trust-catalog`. This test ran only a
  synthetic manifest, its `execute` callback was not invoked, and its lifecycle
  callback was a `vi.fn()`.
- GREEN: the loader now rejects before the provider/lifecycle registration
  path. The same focused case passed; the catalog/loader/lifecycle/rollback
  suite passed **121/121** tests across four files. Desktop typecheck passed;
  targeted Biome exited successfully with 17 warnings on existing lines in the
  two files; `git diff --check` passed.
- Independent read-only review found no regression for `HostPluginCatalog` or
  `TestPluginCatalog`, and no alternate loader bypass. The reviewer confirmed
  the rejection precedes provider registration and lifecycle callbacks. This
  proves in-process catalog provenance only; it does not isolate hostile code
  from the host. The source fix is in `a47e00d`; the stronger observable
  regression assertion is in `7e9e835`. Workflow `38088870451` completed on
  that head; A03 regressions passed and both platform packaging jobs passed.
- Workflow `38088517162` on `a47e00d` completed with the safe IPC fixtures,
  compile-only sandbox, PTY cancellation, A17 regressions, Supabase integration,
  and Ubuntu/Windows containment passing. The global Vitest job failed two
  timing assertions in `wasm-sandbox.test.ts` (`FastVectorDistance` measured
  **0.116007 ms** and `FastContextCompactor` **0.316488 ms**, both against
  `<0.1 ms`); its summary was 4,616 passed, 8 skipped, 2 failed across 409
  files. The filtered macOS containment job also failed the existing
  `FastContextCompactor` assertion at **0.113 ms** (289 passed, 7 skipped, 1
  failed). No benchmark, threshold, filter, or plugin execution was changed.
  These results are not classified as pre-existing or solely environmental.
  Windows x64 packaging (`38088517239`) and macOS arm64/x64 packaging
  (`38088517146`) completed successfully.
- Workflow `38088870451` on `7e9e835` passed the safe IPC, compile-only
  sandbox, PTY cancellation, Verifier-First, A17, Supabase, macOS containment,
  and Windows containment jobs. Global Vitest reported **4,617 passed, 8
  skipped, 1 failed across 409 files**; the failure was `FastVectorDistance`
  at **0.107971 ms** against `<0.1 ms`. Safe-filtered Ubuntu containment failed
  the same assertion at **0.105688 ms** (289 passed, 7 skipped, 1 failed).
  The A03 regression itself passed in this run. The benchmark, threshold, and
  filters remain unchanged; no baseline or instability classification is
  claimed. Windows packaging `38088870260` and macOS packaging `38088870377`
  both completed successfully.

#### A01/A02 process-executor status at `a47e00d`

The shared IPC v2 dispatcher and `APPROVED_RESOURCE_POLICY` are contracts only:
the Electron application does not depend on the protocol crate, and the policy
is consumed only by that crate's tests. The registry invokes trusted provider
callbacks in-process, and `PluginLoader` invokes trusted lifecycle hooks in
process; both paths still lack an external worker supervisor. Preserve these
trusted built-ins, Pi-owned extension factories, and Harness hooks during any
future external-plugin migration.

Platform evidence remains insufficient for an external worker on every current
target. Linux performs read-only feasibility inspection and installs no
confinement; Windows probe code is diagnostic and does not satisfy the approved
RSS and handle ceilings; macOS currently reports unsupported. Therefore the
external-origin gate stays closed on all platforms. No process probe, hostile
plugin, or enforcement scenario ran. The next implementation tranche must add
one host-owned per-plugin/run supervisor that owns both capability and
lifecycle dispatch, with platform launchers default-deny until they satisfy
the complete approved policy; the protocol crate or a feature flag alone is
not an executor.

### A08 IPv6 destination classification follow-up

The static `NetworkBroker.canConnect` destination predicate now blocks IPv6
documentation addresses in `3fff::/20` and the local-use NAT64 prefix
`64:ff9b:1::/48`. Classification still does not perform or authorize a socket
connection, and the broker has no DNS pinning or redirect enforcement path.

- RED: the existing focused regression reproduced that `3fff::1` was allowed
  under a wildcard network grant. GREEN: after the classifier change, it and
  `64:ff9b:1::a00:1` are blocked. Boundary coverage checks that
  `3fff:0fff::1` remains inside the `/20`, `3fff:1000::1` is outside it, and
  local-use NAT64 stays blocked even when it encodes a public IPv4 address.
  Explicitly matched global IPv6 remains permitted. The tests invoke only
  `canConnect`; they do not create network connections.
- Focused Vitest passed **2/2**. Desktop typecheck passed. Biome identified one
  formatting issue in the new test, which was corrected; four existing
  informational diagnostics in the production file were left unchanged.
- Independent source review found no defect in the prefix matching and
  recommended the `/20` and public-payload boundary cases now present in the
  test. The follow-up review confirmed those boundaries and found no defect;
  both reviews were source-only and did not validate DNS or connection
  enforcement.
- Residual: this is a classification improvement only. A08 remains partial
  until production wiring, DNS pinning, redirect handling, and connection-time
  enforcement are implemented and safely validated. This predicate classifies
  literal IP hosts only; a hostname resolving into a reserved IPv6 range still
  requires enforcement in the unresolved connection path.

### CI follow-up on shared temporary-ancestor fixture commit `b12fd7b`

The fixture-only update in `qa-evidence.test.ts` stabilizes metadata for the
shared OS temporary directory in the simulated-root and unknown-UID cases;
the actual sandbox/container directory identities remain observed, and the
tests still require a fingerprint change after their local topology mutation.
It does not change QA recognition or acceptance logic.

- Workflow `38087277016` on `b12fd7bf`: the global `typecheck · test · biome`
  job passed. Biome and desktop typecheck passed; Vitest passed **4,616 tests**
  across **409 files**, with **8 skipped**, in **87.12 s**. The A17 QA file
  passed in the complete run. This confirms the current fixture passes in the
  global suite; it does not by itself prove the exact cause of the earlier
  CI-only assertion failures.
- The same workflow's safe-filtered Ubuntu plugin-containment job failed only
  the existing `FastVectorDistance` timing assertion: **0.103716 ms** against
  `<0.1 ms` (**287 passed, 7 skipped, 1 failed** across 10 files). Its
  macOS and Windows containment jobs passed. The benchmark and threshold were
  not changed, and the timing result is not classified as pre-existing or
  solely environmental. No enforcement probe ran.
- The Supabase pgTAP/integration job passed, including the corrected monthly
  renewal tests. The separate macOS packaging workflow passed for arm64 and
  x64; the Windows x64 packaging workflow also passed. These packaging results
  are for `b12fd7b`.
- The focused QA regression passed **105/105** locally; focused Biome and
  desktop typecheck also passed. An independent source review found the test
  fixture adjustment preserves the production fingerprint checks. The review
  was static and does not establish why the earlier global failures differed
  from isolated runs.
- Current state remains: A17 production integrity is preserved; the test
  fixture is stabilized, while the intermittent cross-suite discrepancy is
  not assigned a definitive root cause. A01–A04 still have no OS process
  executor or productive caller; external plugin execution remains blocked.

### A09 follow-up — nested command launchers

The shell broker previously accepted a broad exact grant such as `npm` or
`npm test`. Because package managers can dispatch project scripts, an allow
entry for a package-manager executable cannot be treated as authority for the
nested code. The predicate now denies package managers and selected common
wrappers/interpreters before evaluating allow entries. It also rejects quoted,
escaped, and environment-assignment syntax that its command-string parser
cannot safely classify. The earlier Fase 13 note that `npm test` passed records
the historical prefix-allow-list test; it is not evidence that the current
broker authorizes package-manager launches.

- RED: the regression first observed `npm test` as allowed under an exact
  `npm` grant. Subsequent variants exposed quoted `npm`, `command npm`, and
  Windows `call npm` forms as allowed. Those predicate-only cases required no
  child process or plugin execution.
- GREEN: the focused safe subset passed **48 tests, 5 skipped** across the
  broker and plugin-isolation files. Desktop TypeScript typecheck passed;
  Biome error-level checking passed on the three changed TypeScript files;
  `git diff --check` passed.
- Independent review found the listed wrappers blocked, but confirmed that
  finite enumeration does not cover arbitrary intermediaries such as `make`,
  `wsl`, `parallel`, or `runuser`. The new tests call only `canExecute`; no
  production broker callsite was found. This is a policy predicate
  improvement, not execution containment or an A09 closure.
- The conservative syntax gate rejects otherwise valid quoted arguments,
  backslash paths, and `--option=value`. No production callsite currently
  depends on this API, but compatibility is restricted if one is added. A
  structured argv contract and a real execution enforcement boundary remain
  required before enabling external plugin shell use.
- Workflow `38088161902` on `3a3aa69` passed Biome/typecheck, safe protocol,
  filtered plugin-containment, Verifier-First, PTY cancellation, sandbox
  compile-only, Supabase integration, and Windows/macOS packaging. Global
  Vitest reported **4,616 passed, 8 skipped, 1 failed across 409 files**; the
  failure was `FastVectorDistance` at **0.117430 ms** against `<0.1 ms`. The
  timing result is not classified as pre-existing or solely environmental.
  No probe ran and no benchmark or threshold was changed.

### A09 launcher-denylist history (superseded by fail-closed execution)

Independent source reviews identified exact grants for `make`, `wsl`,
`parallel`, `runuser`, `gmake`, `sem`, `doas`, `pkexec`, and `run0` as ways to
enter nested project commands or change execution context. These names now
join the shell broker's conservative launcher denylist before exact allow-list
matching.

- RED: `make test` was accepted under an exact `make test` grant. GREEN: the
  safe predicate tests deny `make`, `wsl`, `parallel`, and `runuser` while
  preserving existing explicit operation checks. The test uses `canExecute`
  with a synthetic audit logger only; no command, plugin, or network operation
  ran. Combined focused regression set: **36/36 tests across eight files**.
- Independent reviews found no defect in the listed additions and confirmed
  the tests do not launch processes. Follow-ups successively identified
  `gmake`/`sem`/`doas`, then `pkexec`/`run0`. RED reproduced both privileged
  launchers as allowed under exact grants; GREEN added both names to the
  denylist, and the synthetic predicate suite denies each command. The
  list remains finite and A09 remains a partial policy predicate, not a
  sandbox or execution boundary. Exact grants for newly denied names
  intentionally stop working if a future caller uses this API.
- The focused broker tests pass **5/5**; the combined safe A15/A09 regression
  set passes **38/38 across eight files**. Desktop typecheck passes after the
  final test additions. Targeted Biome passes with four existing
  informational diagnostics in `permission-brokers.ts`; `git diff --check`
  passes.

This intermediate finite list was not a complete execution boundary.
Independent review reproduced `gmake test`, `pkexec npm test`, and
`run0 npm test` under exact grants. Those predicate-only tests used a synthetic
audit logger and launched no commands. The list and its compatibility effect
are historical; current behavior is governed by the fail-closed follow-up
below.

### A09 fail-closed ShellBroker pending an OS executor

Static search found no production `ShellBroker` construction or `canExecute`
callsite; the broker is exercised only by tests. Because the raw command
predicate cannot prove that an allowed executable will not dispatch nested
code, a finite launcher list would leave the same authorization flaw for
unlisted wrappers. The broker now always emits an audited denial with an
explicit “platform-isolated executor” reason, regardless of shell/Git grants
or command text. This affects only the unused external-plugin shell broker;
the trusted Harness path and the separate `GitBroker` permission API are
unchanged. No process was launched.

- RED: `git status` with exact shell and Git status grants was accepted while
  there was no platform-isolated executor. GREEN: `canExecute` always denies;
  parameterized fixtures confirm exact grants for a benign command, Git,
  package manager, known privilege wrappers, and an unlisted launcher all
  remain denied. The broker and selected existing ShellBroker tests passed
  **16/16** across two files, with 44 other plugin-isolation tests filtered
  out. The filtered tests are string predicates only.
- Targeted Biome passed with pre-existing informational diagnostics in
  `permission-brokers.ts` and diagnostics in the broad
  `plugin-isolation.test.ts`; these diagnostics were not compared against the
  base, so they are not classified as pre-existing. `git diff --check` and
  `npm run typecheck --workspace @modus/desktop` passed. Independent
  read-only review found no concrete defect in this fail-closed policy and
  confirmed there are no production callsites; its architectural limitation
  remains that no process containment is provided.

This is policy denial, not a process sandbox. The separate `GitBroker` still
answers whether a Git operation grant exists, but has no production caller and
does not execute Git. A future OS executor must add a host-owned, scoped
dispatcher before either permission result can be used to authorize a child
process.

### A07/A08 broker fail-closed follow-up and remote CI

Static search found no productive constructors or callers for
`FilesystemBroker` or `NetworkBroker`; the only internal calls are the
filesystem class's own read/write wrappers. The filesystem broker now denies
before path canonicalization, metadata lookup, or content I/O, avoiding the
check/open race and avoiding metadata-dependent decisions altogether. It does
not prove which paths would be safe if I/O were re-enabled. The network
predicate can match an exact domain and port, but it cannot pin the resolved
address or enforce redirect policy. Both brokers therefore return an audited
denial even when metadata permissions match. Actual read, write, and network
operations remain unavailable. This does not change built-in Harness tools,
which use their existing trusted path, and no network request or file-content
I/O was performed.

- RED: synthetic exact grants for `package.json` and
  `https://api.example.com/v1` returned `true` without a safe backend.
- GREEN: the broker regressions now deny both grants and assert the audit
  reasons, and `canRead`/`canWrite` deny without calling `realpathSync` or
  `lstatSync`. `permission-brokers.test.ts` passed **12/12**; the filtered
  `FilesystemBroker|NetworkBroker` cases in `plugin-isolation.test.ts` passed
  **14/14**, with 35 unrelated cases skipped. The test-name filter excluded
  the former synthetic symlink/junction fixture, which was replaced with
  assertions that link-shaped paths are denied before metadata lookup. No
  probe or hostile code ran.
- Independent review of the adjusted diff found no productive bypass and
  confirmed there are no runtime callers. It noted that
  `scripts/audit-phase19/probes.ts` still uses the old two-argument broker
  constructor and expects successful file operations. This non-production
  probe was not executed and is not valid evidence for the new fail-closed
  contract; its `brokers` mode stops at the expected filesystem denial before
  reaching its network summary. It is outside the desktop typecheck. The fresh
  review also confirmed the no-content/no-socket paths and found no product
  regression.
- Desktop typecheck passed after the final no-metadata change. Targeted Biome
  exits 0 with 6 informational diagnostics (5 in
  `plugin-isolation.test.ts`, 1 in `permission-brokers.ts`); these lines were
  not compared against base and are not classified as pre-existing. No
  warnings or errors remain in the touched-file check. `git diff --check`
  passed.
- Remote workflow `38093868417` on `e86b2dc` completed with failure in the
  global `typecheck · test · biome` job. Biome and typecheck succeeded; Vitest
  reported **4,639 passed, 8 skipped, 1 failed** across 413 files. The sole
  failure was `FastVectorDistance` at **0.158736 ms** against `<0.1 ms`; no
  benchmark, threshold, filter, or productive code was changed. The same test
  failed on the previous head `9df3e23` at **0.118112 ms**. These repeated
  observations do not establish a baseline. An official rerun of only the
  failed job passed on the same `e86b2dc` head with **4,640 passed, 8 skipped,
  0 failed** across 413 files; the site test command then passed **5/5**.
  The cause of the differing benchmark outcomes remains unidentified. No
  benchmark, threshold, or filter was changed. The run's Supabase
  pgTAP/integration, safe IPC fixtures,
  safe-filtered containment on Ubuntu/macOS/Windows, A17/A21 regressions, PTY
  cancellation, and sandbox compile-only jobs all passed. The sandbox was
  compiled only; no probe executed. Windows x64 and macOS x64/arm64 packaging
  all passed.

The APIs remain exported, so future callers fail closed until they are
replaced by host-owned operations that bind permission evaluation to the
actual filesystem handle or network socket. This is not a certified
containment boundary.

### A05 watchdog timer cleanup

`WasmCapabilityHost.executeWasm` used a `Promise.race` deadline timer but did
not clear the timer when the invocation completed first. That retained one
host timer until the configured deadline after every successful bounded call.
The change clears the same timer from the race's `finally`, preserving the
deadline, error, fuel/memory behavior, and instance-disposal path.

- RED: a safe synthetic `buildAddModule()` call completed successfully while
  Vitest still reported one pending timer.
- GREEN: the same test now reports zero pending timers. The focused
  `wasm-sandbox.test.ts` run passed **43 tests**, with 5 filtered by name,
  including the blocked infinite-loop cases and the high-throughput benchmark
  group. Desktop typecheck passed. Targeted Biome exited 0 with no errors; it
  still reports one warning and one informational diagnostic on untouched
  lines, which have not been compared against base.
- Fresh independent review found no code regression. It observed that the
  runtime assertion directly exercises successful settlement; rejection and
  timeout cleanup share the same source `finally` but do not have separate
  new runtime assertions. Static call-site search found no productive callers
  of `executeWasm`/`executeAsPluginRpc`, and external plugin execution remains
  blocked.

### A05 in-process WASM timeout contract

The timer cleanup above did not make the timeout enforceable. `WasmPluginInstance`
invokes exports synchronously with `Reflect.apply`; while that call is running,
the Node event loop cannot run the `setTimeout` callback in the old
`Promise.race`. The race could report success after the requested deadline and
could not stop a non-terminating export. Module start work also runs during
instantiation, so checking only around the export would leave an unbounded path
before the race.

Both `executeWasm` and the public `createInstance` factory now reject positive
`timeoutMs` before compilation/instantiation, with an error directing callers
to a preemptible OS-isolated worker. The ineffective watchdog and timeout error
import were removed. A call with no positive timeout remains available for
trusted internal WASM; this does not authorize external plugin execution, and
there are no production callers of `executeWasm` or `executeAsPluginRpc` in the
repository. The public APIs may have external callers, which now receive
explicit failure instead of an ignored or false timeout guarantee.

- RED: the safe synthetic add-module regression returned `success: true` for a
  positive timeout before this change, despite invoking WASM synchronously.
- GREEN: the same request now returns `success: false` before `createInstance`,
  reserves no memory, and creates no timer. A paired no-timeout regression
  confirms the trusted add module still returns `5`.
- Review follow-up RED: the new direct-factory test observed that
  `createInstance({ timeoutMs: 1 })` resolved and compiled the safe add module.
  GREEN: the shared guard now rejects it before `WebAssembly.compile` and
  leaves no memory reservation.
- Targeted Vitest: **3 passed, 50 skipped** in `wasm-sandbox.test.ts`. The
  command selected only these finite synthetic-module cases; it did not execute
  loop/fuel probes, enforcement scenarios, or benchmarks.
- Final verification: targeted Vitest **3 passed, 50 skipped**; desktop
  TypeScript typecheck passed; targeted Biome exited 0 with no errors or
  formatting changes. The one `noUnusedVariables` warning for the existing
  `TIn` type parameter is unchanged in the pre-change file. Independent
  follow-up review approved both guard points; it found no blocker and noted
  that there are no productive positive-timeout callers. Remote workflow
  `38105345782` passed Biome/typecheck and global Vitest (**415 files passed;
  4,678 passed, 8 skipped; 125.34s**), as well as pgTAP/Deno, Verifier-First,
  safe-filtered containment on Ubuntu/Windows/macOS, synthetic IPC, sandbox
  compile-only, and PTY cancellation. The retry followed a separate run where
  the unchanged FastVectorDistance timing assertion failed; this later success
  establishes that this workflow passed, but does not classify the earlier
  failure as pre-existing or solely environmental. Windows x64 packaging run
  `38105345842` and macOS x64/arm64 packaging run `38105345926` completed
  successfully. A05 remains partial
  because non-cooperative in-process work is not
  preemptible, external plugin execution must stay blocked, and platform
  process containment/reap guarantees have not been proven.

#### Remote CI on `a1a4e35` before the `pkexec`/`run0` follow-up

Workflow `38091868511` completed its global `typecheck · test · biome` job
successfully: **4,632 Vitest tests passed and 8 were skipped**. Supabase
integration, Ubuntu and Windows safe-filtered plugin-containment, safe IPC
protocol fixtures, sandbox compile-only, Verifier-First, and PTY cancellation
jobs also passed. The macOS safe-filtered plugin-containment job failed only
at the unchanged `FastVectorDistance` assertion: **0.104750 ms** against
`<0.1 ms` (289 passed, 7 skipped). The benchmark and threshold were not
changed, and this result is not classified as pre-existing or solely
environmental. Windows packaging (`38091868609`) and macOS packaging
(`38091868537`) later completed successfully. This workflow ran the previous
commit, before `pkexec` and `run0` were added.

### A15 trusted CodeGraph runner cancellation follow-up

`runCodeGraphCli`, used by the trusted CodeGraph feature, previously sent only
`SIGTERM` on POSIX and launched Windows `taskkill /T /F` without awaiting it.
Cancellation or timeout could therefore return before the shared process
supervisor had observed cleanup, and an `error` event could race a pending
cleanup result. The runner now creates a dedicated POSIX process group, routes
abort/timeout through the existing `PlatformProcessOps.killTree`, waits for
that result before rejecting, preserves cleanup failures as
`ProcessTreeTerminationError`, and prevents child `error`/`close` events from
settling the request while termination is pending. The Windows taskkill
invocation now has a 2-second command timeout, in addition to the existing
bounded leader-exit observation. No process was launched by these tests; spawn
and process operations use synthetic mocks.

- RED/GREEN: four initial synthetic runner cases failed before wiring: abort,
  timeout, unconfirmed cleanup, and missing POSIX group isolation. The five
  runner cases now pass, including a race fixture where a child `error` cannot
  hide failed cleanup. The Windows taskkill-options test failed RED without
  its timeout. Independent review then found two false-confirmation cases: a
  taskkill timeout after the leader exits, and a leader already absent when
  cleanup begins. Each new fixture failed RED on the former behavior; errors
  are now preserved and an absent leader produces
  `ProcessTreeTerminationError`. The combined runner and process-ops suite
  passes **18/18**.
- Desktop TypeScript typecheck passed. Targeted Biome passed on the four
  changed source/test files; `git diff --check` passed.
- Independent review confirmed that `error` and `close` defer settlement to
  the shared termination promise, identified both Windows false-confirmation
  paths, and approved their RED/GREEN fixes on final review. The taskkill
  subprocess has a 2-second timeout and successful return is followed by up to
  2 seconds of leader-exit observation. Residual limits: process identity is
  numeric PID/PGID and has a reuse race; POSIX only observes the original
  process group and descendants can escape; Windows observes the leader after
  `/T` and does not independently prove every descendant exited. A missing
  Windows leader is conservatively reported as unconfirmed even if its entire
  tree happened to exit naturally. These changes improve cooperative
  cancellation for this trusted tool but do not establish plugin isolation or
  hard whole-tree preemption.

#### Remote CI evidence before the CodeGraph runner follow-up

Workflow `38094951293` on `1d41b208` passed the other recorded jobs, including
Verifier-First, PTY cancellation, safe IPC fixtures, compile-only sandbox,
Supabase renewal/pgTAP, and safe-filtered Windows/Ubuntu/macOS containment.
The global Vitest job reported **4,640 passed, 8 skipped, 1 failed across 413
files**; the sole failure was the unchanged `FastVectorDistance` benchmark at
`0.263551 ms` against `<0.1 ms`. The official rerun of only the failed job
(`114339590762`) again failed that same assertion at `0.104506 ms`, with the
same counts. The isolated local benchmark also failed at `0.136241 ms`. The
same benchmark failed on parent `e86b2dc` at `0.158736 ms`, while an official
rerun on that parent passed; earlier observations also differ. This evidence
does not establish the cause or justify classifying the failure as pre-existing
or solely environmental. The threshold, benchmark, filters, and production
benchmark implementation were not changed. Windows x64 packaging
(`38094951266`) and macOS x64/arm64 packaging (`38094951288`) passed. The
CodeGraph change was subsequently published in `c37495b`; its remote CI is
recorded below.

### A22 keyset index recheck

An attempted composite-index addition was reverted after the query plan showed
that the existing `idx_agent_events_session_id` already supports both forward
and backward keyset range scans: `event_cursor` is the table's
`INTEGER PRIMARY KEY` alias for `rowid`, and SQLite secondary indexes retain
rowid as the tie-breaker. Synthetic `EXPLAIN QUERY PLAN` output used the
existing index with the `rowid` range predicates in both directions. An
independent review confirmed the schema and plan reasoning. This is evidence
of index usability, not a benchmark across database sizes or SQLite versions;
the index is not covering for payload columns, and the conclusion depends on
the current rowid-table schema. No database or event-store code change was
retained.

### A09 broker callsite recheck

Static callsite search on `c37495b` found no non-test caller of
`GitBroker.canPerform`. The method correctly denies by default and allows only
the exact requested operation when its matching grant is true, but this is a
unit-tested contract rather than productive enforcement. `ShellBroker` also
has no production caller and remains deny-all. No Git operation was run or
changed. Do not treat either broker as an OS or network boundary; actual
built-in Git behavior continues through its separate user-facing tool path.

### Remote CI and official rerun on `c37495b`

Workflow `38096490604` ran on PR HEAD `c37495ba81c289cce53a8b5f14df636f55440643`.
Biome and TypeScript typecheck passed. Global Vitest reported **4,648 passed,
8 skipped, and 1 failed across 414 files**; the sole failure was the unchanged
`FastVectorDistance` latency assertion at `0.115616 ms` against `<0.1 ms`.
The official GitHub rerun of only `typecheck · test · biome` (job
`114344266471`) reproduced the same failure at `0.115616 ms`, with the same
test counts. The benchmark, threshold, test filters, and production code were
not changed. This does not establish a baseline or environment-only cause.

The same workflow passed PTY cancellation, safe-filtered containment on
Ubuntu/Windows/macOS, safe plugin execution protocol fixtures, compile-only
sandbox targets, Verifier-First runtime regressions, and Supabase pgTAP/integration
(20 files, **1,041 tests passed**). Windows packaging (`38096490570`) and macOS
packaging (`38096490615`, x64 and arm64) completed successfully. The PR remains
Draft; no enforcement probe was run.

### A03 loader and lifecycle reflection hardening

`PluginLoader` previously used TypeScript-only `private` fields for its
capability registry, host catalog, loaded-plugin map, and source-manifest
mapping. JavaScript reflection could read or mutate those own properties, and
the prototype exposed the authorization helper as a normal method. The
`PluginLifecycleService` likewise reflected its loader and mutable registry
through own properties and public getters. These references are part of the
trusted in-process implementation, and the runtime does not expose them to
external plugin code; the change narrows the reflective API and removes
unused escape hatches, but does not establish an external execution boundary.

- RED/GREEN: the new reflection tests failed on the old properties/getters and
  passed after conversion to ECMAScript `#private` fields/methods. The lifecycle
  reconciliation test no longer injects state by mutating the loader's private
  map; it now loads a host-catalog manifest and tests stale durable version
  reconciliation through the supported flow.
- Focused plugin loader/lifecycle/dependency/rollback Vitest passed **146/146**;
  focused catalog tests passed **6/6**. Desktop typecheck passed. Biome exited
  successfully on all four changed TypeScript files; it reported existing
  warnings (non-null assertions and explicit `any`) without errors. No
  unrelated warnings were changed.
- Full-repository callsite search found no `.getRegistry()` or `.getLoader()`
  consumers. Independent patch review found no blocker. It notes that the
  exported classes could have out-of-repository consumers and that unrelated
  service fields such as the store and dependency graph remain intentionally
  outside this encapsulation change. No external plugins, probes, or
  enforcement scenarios ran.
- Residual: reflective encapsulation only protects against ordinary property
  inspection/mutation. Trusted code already executing in the host process is
  outside this boundary. External plugin execution remains blocked pending the
  process executor, platform adapters, dispatcher wiring, and preemption proof.

### Remote CI and packaging for A03 commit `512c7b2`

CI workflow `38098027525` completed successfully on
`512c7b281183cb2bf41a86bb1029e72319b99e12`. Biome and desktop typecheck
passed; Vitest passed **4,651 tests**, skipped **8**, across **414 files**.
The safe protocol fixture job, compile-only sandbox build, Verifier-First
regressions, PTY cancellation regressions, safe-filtered plugin-containment
checks on Ubuntu/Windows/macOS, and Supabase pgTAP/integration (**20 files,
1,041 tests**) all passed. No probe or enforcement scenario ran.

Windows x64 packaging (`38098027506`) and macOS x64/arm64 packaging
(`38098027511`) also completed successfully. These results verify the A03
change builds and passes its integrated regression suite; they do not prove an
OS process boundary. PR #191 remains Draft.

### A03 CapabilityRegistry reflection hardening

The remaining registry-owned provider maps, active-provider selection,
quarantine set, implementation identity/executor WeakMaps, rollback
checkpoints, provenance tracker, and instrumentation reference were ordinary
TypeScript `private` own properties. The registry's internal clone/snapshot/
descriptor helpers were ordinary prototype methods. The registry is exported,
so callers holding its reference could read or mutate that state with
JavaScript reflection despite the TypeScript declarations. These fields and
helpers now use ECMAScript `#private`; public registration, execution,
discovery, and instrumentation APIs are unchanged.

- RED/GREEN: a reflection regression failed before the change because
  `Reflect.ownKeys(registry)` included `capabilities`; after conversion the
  registry suite passed **28/28**. The combined registry, loader, and lifecycle
  suites passed **107/107**. Desktop TypeScript typecheck passed. Targeted
  Biome exited 0 with **11 existing warnings and 1 info** in the two files;
  no rule was suppressed and no unrelated diagnostic was edited. `git diff
  --check` passed.
- Independent static review found no blocker, confirmed there are no
  in-repository subclasses or users of the former private names, and requested
  that the regression also name `immutableSnapshot`; that assertion was added.
  Review emphasized that this narrows reflection only. Public registry methods
  remain available to holders of the exported registry reference, and this
  does not establish an OS/process boundary.
- External plugin ingress remains blocked. The change does not alter the
  production call graph or claim that the IPC dispatcher has a process caller.

### A20 audit logger reflective state encapsulation

The audit logger's database handle, retained cache, chain anchor/head,
sequence/revision state, and integrity-failure flag were TypeScript `private`
properties. `PluginIsolationHost` also held its audit logger in a reflectable
property, and both classes' sensitive helper methods were ordinary prototype
methods. The logger and the facade now keep those members in ECMAScript
`#private` slots/methods; the existing public logging, verification, and
fail-closed execution APIs retain their signatures.

- RED/GREEN: a safe reflection-only fixture failed first on the logger's
  `database` property, and then a second fixture failed on the facade's
  `audit` property. After the conversions, the boundary fixtures and selected
  normal logger/facade regressions passed **5 tests**, with **94** unrelated
  tests filtered out. The selected set covered chained logging, returned-entry
  immutability, and the facade's existing fail-closed WASM response; no guest
  code, DB mutation, probe, or enforcement case ran. Desktop TypeScript
  typecheck passed. Targeted Biome passed on all three changed TypeScript files
  with no diagnostics; `git diff --check` passed.
- Independent review found no behavioral or syntax blocker and confirmed the
  tests only inspect names on a newly constructed in-memory logger/facade.
  Review explicitly limits the claim to reflective encapsulation: the logger
  still exposes public APIs, a caller can supply/hold the SQLite connection,
  the SHA-256 chain is unkeyed, and same-process code or a DB writer can alter
  audit history. This patch does not make A20 tamper-proof or establish a
  process/database boundary.

### Remote validation snapshot before A20

The official rerun of only the failed `typecheck · test · biome` job on the
documentation-only head `0e4cc576` failed again at the unchanged
`FastVectorDistance` assertion: **0.118321 ms** against `<0.1 ms`, with
**4,650 passed, 8 skipped, 1 failed across 414 files**. Its first attempt had
failed the same assertion at **0.103422 ms** with the same counts. Windows and
macOS packaging on `0e4cc576` passed. These observations show different
run-level outcomes but do not establish a baseline or cause, so the benchmark
is not classified as pre-existing or solely environmental.

The subsequent full CI run `38099164607` on code head `a46d6c63813a17103f1e8bae518d601f6ce9bd9b` passed all nine jobs. Biome and desktop typecheck
passed; global Vitest passed **4,652 tests**, skipped **8**, across **414
files**; Supabase pgTAP passed **1,041 tests** across 20 files. Safe-filtered
containment checks on Ubuntu/Windows/macOS, IPC protocol fixtures,
compile-only sandbox, Verifier-First, and PTY cancellation passed. The Windows
and macOS package workflows later completed successfully; no probes ran, and
the PR remained Draft.

The next full run `38099517953` on `c08e3ca8c13d849c0cec8626ea63eb6ebe60f04e`
passed Biome/typecheck and all non-timing feature jobs except the macOS
containment test group. Global Vitest recorded **4,653 passed, 8 skipped,
1 failed across 415 files**: `FastVectorDistance` measured **0.110467 ms**
against its unchanged `<0.1 ms` assertion. The macOS group recorded
**303 passed, 7 skipped, 1 failed** and hit the same assertion at **0.290708
ms**; Ubuntu and Windows containment groups passed. Supabase pgTAP passed
**1,041 tests across 20 files**; Verifier-First, safe IPC fixtures,
compile-only sandbox, and PTY cancellation passed. Windows and macOS package
jobs were still running at the time of this snapshot. This is additional
reproducibility evidence for the timing-sensitive assertion, but it does not
establish a baseline or an exclusively environmental cause; its code and
threshold remain untouched.

The separate Windows x64 and macOS x64/arm64 package workflows for `c08e3ca`
later completed successfully (`38099517992` and `38099517972`).

The last published commit `3f9a3ed` completed CI workflow `38100096634`
successfully across all nine jobs. Global Vitest passed **4,656 tests**,
skipped **8**, across **415 files**; pgTAP passed **1,041 tests** across 20
files. Safe-filtered containment on Ubuntu/Windows/macOS, IPC safe fixtures,
sandbox compile-only, Verifier-First, and PTY cancellation passed. The Windows
package run `38100096636` completed successfully; the macOS package run
`38100096627` was still running at this snapshot. This run validates the
published `3f9a3ed` commit, not the uncommitted A13 follow-up described above.

### A22 source collector bounds and failure attribution

The run-source collector now retains only the selected file paths and URLs from
arguments, rather than holding whole argument objects. It caps call identities,
argument traversal depth/nodes/bytes, active selected references, tracked
external-tool output, total scanned bytes, and stored source metadata. A
budget breach latches a generic collector error; `finish()` cannot return a
partial source set as complete.

- RED/GREEN: the first budget regressions failed for 257 unfinished calls,
  oversized argument data, and over-budget output. The paged lookup regression
  failed when the 257th unfinished call crossed the 256-event page boundary;
  another failed when retained output exceeded its budget across pages. The
  collector and paged hook suites then passed **14/14**. The existing
  snapshot-change rejection was preserved.
- Independent review found two further paths. The synchronous timeline fallback
  could throw during React render, and a repeated active `toolCallId` across
  runs could misattribute `tool.output` events because that event has no
  `runId`. New timeline and Agent Group UI tests failed RED on render failure
  and on the absence of an unavailable state; a collector fixture failed RED
  on active ID reuse. The fix latches both budget and attribution errors, keeps
  the timeline answer renderable with source status `unavailable`, and exposes
  the same unavailable state on Agent Group messages. Tool IDs are tracked
  across active runs so untagged output is consumed only for the exact target
  run; a duplicate active identity fails closed.
- GREEN: collector budget, paged lookup, the existing snapshot-change
  rejection, timeline fallback, and Agent Group overflow indication passed
  **86/86** across four targeted Vitest files. The new budget, attribution,
  timeline, and Agent Group cases had failed RED before their fixes. Desktop
  TypeScript typecheck passed. Targeted Biome passed on all nine changed
  source, hook, timeline, group-copy and test files without fixes;
  `git diff --check` passed. Independent second review confirmed that the
  render crash and cross-run attribution blockers are closed.
- Collector limits apply only after an event page has been materialized. They
  do not cap stored event payloads, IPC page bytes, JavaScript object overhead,
  or process RSS. The UI's existing 24-item source cap remains in place and can
  omit additional unique references. Independent review also found that
  completed-run source loading fans out one request per run and pagination
  already in flight is not aborted on unmount. These aggregate concurrency and
  cancellation gaps, plus event-page materialization, IPC page bytes, renderer
  heap and process RSS, remain outside this increment. A22 remains partial;
  this change does not claim complete memory bounding.


#### Remote CI baseline on `907fd92` before the source-collector follow-up

Workflow `38100554455` ran on the published A13 commit `907fd926` before these
A22 source-collector changes. Its global Vitest job failed one timing assertion
in `wasm-sandbox.test.ts:1003`: `FastVectorDistance` measured `0.109634 ms`
against `<0.1 ms`; **4,657 tests passed, 8 skipped, and 1 failed across 415
files**. The Ubuntu containment job independently hit that same assertion at
`0.104817 ms` (**307 passed, 7 skipped, 1 failed across 11 files**). The
benchmark, its threshold, filters, and production implementation were not
changed, and these observations do not establish a baseline or solely
environmental cause. The same workflow passed Biome/typecheck, pgTAP, safe IPC
fixtures, PTY cancellation, Verifier-First, sandbox compile-only, and safe
containment on macOS and Windows. Windows packaging run `38100554454` and macOS
packaging run `38100554439` both succeeded. A fresh CI run is required for the
A22 working-tree changes after publication.

The follow-up for the published source-collector commit `6dab9f0` completed CI
workflow `38102378227` successfully. The global Vitest job passed **4,666 tests
across 415 files, with 8 skipped**; Biome and desktop typecheck passed. Supabase
pgTAP passed **1,041 tests across 20 files**. Synthetic protocol fixtures,
compile-only sandbox checks, PTY cancellation, Verifier-First regressions, and
safe-filtered Ubuntu/macOS/Windows containment jobs passed. No probe ran. At
this status snapshot, Windows and macOS packaging workflows
`38102378241`/`38102378214` were still in progress. These checks validate
`6dab9f0`, not the uncommitted aggregate lookup follow-up below.

### A22 aggregate lookup and view-release follow-up

The renderer source loader now admits at most four active run lookups across
main-chat and Agent Group views, and bounds queued lookups at 256. A full queue
marks excess source history unavailable instead of creating more page work.
Each view subscribes to a deduplicated run lookup. Releasing its last subscriber
removes queued work immediately; if a page IPC request is already in flight,
the current response is discarded and no subsequent page is requested. The
bridge has no abort signal, so the one active page request itself cannot be
preempted from the renderer.

- RED: a synthetic two-hook fixture observed eight simultaneous page calls
  before the limit, against the required four, and an unmounted paged lookup
  requested a second page after its first page returned. GREEN: both targeted
  regressions pass; `useRunSources.test.tsx` passed **10/10**, and the full
  focused source/timeline/Agent Group suite passed **88/88** across four files.
  Desktop typecheck and Biome on the two changed files passed; `git diff
  --check` passed.
- Independent static review found no blocker in subscriber counting,
  deduplication, queue admission, or rejection handling. It confirmed three
  residuals: an in-flight IPC page cannot be aborted; replacing the requested
  run set can cause one duplicate page request while an older request drains;
  and the work budget is not cumulative across all runs/pages over time. The
  queue bound limits pending jobs, not the total size of the requested run-id
  set. This increment also does not bound main-process event-page
  materialization, a single IPC response size, JavaScript heap/RSS, or the UI's
  existing source display cap. A22 remains partial.

- Remote CI for `09dbdd3` completed the `typecheck · test · biome` job: **415
  files, 4,668 passed, 8 skipped**. The pgTAP/function job, safe protocol
  fixtures, compile-only sandbox job, PTY cancellation, Verifier-First
  regressions, and Windows/macOS containment jobs passed. The overall CI run
  failed only in Linux plugin-containment when the existing
  `FastVectorDistance` latency assertion measured **0.10624799999999368 ms**
  against `< 0.1 ms`; the benchmark and threshold were not changed, and this
  repeated result is not classified as pre-existing or solely environmental.
  Windows/macOS packaging for `09dbdd3` was still running at this status check;
  packaging for `6dab9f0` completed successfully on both platforms.

### A22 source-lookup cancellation and queue-bound test coverage

The source-loader tests now distinguish a genuinely queued lookup from an
immediate rejection, exercise the full four-active/256-queued admission bound,
and verify that a deduplicated lookup continues for the remaining subscriber
after another view unmounts. Deferred IPC pages are drained in `finally` blocks,
including pages started while the scheduler drains, so a failed assertion does
not leave scheduler slots or pending promises for later tests.

- RED: the prior tests did not prove that the fifth lookup had actually entered
  the queue, that all 256 queue slots were occupied before overflow, or that a
  shared lookup remained active until its last subscriber left. GREEN: the three
  focused new cases passed **3/3**; the full source/timeline/Agent Group focused
  suite passed **32/32** across four files. Biome and `git diff --check` passed.
  `npm run typecheck --workspace=apps/desktop` passed locally after the
  test-only change.
- Independent static review of the final test diff found no blocker. It
  confirmed the queue-capacity assertions and deferred cleanup; no tests were
  run by the reviewer. This coverage does not add an IPC abort signal or change
  A22's resource bounds.
- The official failed-job rerun for workflow `38103304287` completed. The
  global test job again failed only `FastVectorDistance`, measured at
  **0.10725999999999658 ms** against the unchanged `< 0.1 ms` assertion;
  **4,670 tests passed, 8 were skipped, and 1 failed across 415 files**.
  The previous run attempt measured **0.10811200000000554 ms**. We do not
  classify these measurements as pre-existing or solely environmental. The
  macOS containment rerun passed; Linux and Windows containment, pgTAP,
  synthetic protocol fixtures, compile-only sandbox, PTY cancellation, and
  Verifier-First jobs also passed. Windows packaging run `38103304300` and
  macOS packaging run `38103304292` both completed successfully. The A22 test
  follow-up itself has not yet been published, so this CI does not validate that
  test-only change.

### A22 run-scoped tool-evidence page payload cap

Run-scoped tool-evidence pages now preflight the exact `payload_json` byte sum
for the requested page before selecting payloads. The byte check, run-boundary
queries, metadata-only `hasMore` query, and payload selection run inside one
SQLite savepoint/read snapshot. The sentinel query selects only `1`; it does not
materialize a `limit + 1` payload. Pages above the shared **8 MiB** limit throw
and flow through the existing unavailable-source path. The event remains
unchanged in SQLite, and renderer source scanning uses the same shared limit.

- RED/GREEN: the oversized synthetic tool output initially returned instead of
  rejecting; after the limit was added it is rejected while the stored output
  length, prefix, and suffix remain intact. A new SQLite-authorizer regression
  then failed because payload reads were outside a read transaction; it passes
  after the savepoint wraps range discovery, preflight, pagination metadata,
  and page materialization. The final focused run passed **108/108 tests across
  five files** (`agent-event-store`, source collector, source lookup, timeline,
  and Agent Group working status). Desktop TypeScript typecheck passed; targeted
  Biome checked all four changed source/test files without fixes, and
  `git diff --check` passed.
- Independent static review found no blocker. It confirmed the savepoint spans
  run-boundary discovery, byte preflight, `hasMore`, and payload selection; error
  paths roll back and release it, while success releases it once. Query filters,
  ordering, and the last-returned-row cursor match. Pagination across separate
  requests still assumes append-only history; external edits/deletes during
  pagination are not frozen by a page-local snapshot. The page limit counts
  serialized `payload_json` bytes only; it does not include IPC envelope or
  JavaScript object overhead. SQLite still evaluates stored values to measure
  their byte lengths. This first cap covered run-scoped tool-evidence pages;
  assistant-message pagination and remaining gaps are recorded below.
- The last official CI run on published commit `e6ff0e28e49871226ace1f061564448d9cad19db`
  (`38103920154`) completed with its global Vitest job failing only the
  unchanged `FastVectorDistance` assertion at **0.10797100000002047 ms** against
  `< 0.1 ms`; **4,673 passed, 8 skipped, and 1 failed across 415 files**. We do
  not classify this as pre-existing or solely environmental. Supabase pgTAP,
  Biome/typecheck, the safe protocol and containment jobs, compile-only sandbox,
  PTY cancellation, and Verifier-First passed. Windows packaging run
  `38103920147` and macOS packaging run `38103920146` both succeeded. This CI
  predates the current uncommitted A22 page cap.
- The next remote CI on `0b326037fbb7e5816a9a3fef2b3ff6c697d15b5d`
  (`38104705079`) confirmed the incremental Supabase renewal migration and
  pgTAP divergence fix: the pgTAP integration job passed, including SQL and
  Deno function checks. Its global Vitest job had **4,675 passed, 8 skipped,
  1 failed across 415 files**; the sole failure was the unchanged
  `FastVectorDistance` benchmark at **0.10311200000001008 ms** against
  `< 0.1 ms`. The safe-filtered macOS containment job also ran that benchmark
  and failed at **0.50875 ms** (310 passed, 7 skipped). Ubuntu/Windows
  containment, synthetic IPC, compile-only sandbox, Verifier-First, PTY
  cancellation, typecheck/Biome, and the remaining jobs passed. macOS package
  `38104705086` and Windows package `38104705094` both succeeded. The benchmark
  and threshold remain unchanged; these failures are not classified as
  pre-existing or solely environmental.
- Workflow `38105345782` on `1a426f803b199158f73993041d7aaff48da4aee6` then
  passed the global suite (**415 files, 4,678 passed, 8 skipped; 125.34s**)
  and the Supabase pgTAP/Deno job, including renewal test 22. The unchanged
  FastVectorDistance timing assertion passed in this run. This records the
  successful workflow without attributing the earlier failures to baseline or
  environment. Safe-filtered containment, compile-only sandbox, synthetic IPC,
  PTY cancellation, Verifier-First, Biome, and typecheck jobs also passed. At
  this update, Windows x64 packaging `38105345842` and macOS x64/arm64
  packaging `38105345926` also completed successfully.

### A22 assistant-message page payload budgeting

`listAgentRunMessagePage` now preflights stored `payload_json` byte lengths
inside one SQLite savepoint, then materializes only an ordered prefix that fits
the 8 MiB run-page payload budget. If a later event would exceed the budget,
the cursor stops before it and the next page continues from there. A single
event larger than 8 MiB is returned alone to preserve the complete assistant
message; it is an explicit exception to the aggregate page ceiling. The API
continues to exclude IPC/page envelopes from the byte count. `runAssistantOutput`
uses this path and reconstructs the entire answer across pages.

- RED/GREEN: two safe synthetic 4 MiB deltas initially came back in one page;
  after the change they require two pages and both deltas, plus the final
  assistant text assembled by `runAssistantOutput`, are unchanged. The direct
  caller regression also verifies that a single oversized delta is returned
  intact and can be reconstructed rather than turning a completed prompt into
  a rejected result.
- Focused Vitest passed **3 targeted tests** in `agent-event-store.test.ts`;
  **78 other tests were skipped** by name, including security/path cases not
  needed for this change. The tests call the real `runAssistantOutput` helper
  against the SQLite event store. Desktop typecheck passed and targeted Biome
  checked the three modified source/test files without fixes. The first
  independent review found and drove the oversized-event compatibility change;
  its follow-up approved cursor order, run scoping, `hasMore`, savepoint scope,
  and `runAssistantOutput` behavior.
- This change does not cap generic/non-run event pages or stream-expansion
  reads. One indivisible large event can still exceed 8 MiB; envelope/object
  overhead, aggregate page requests, renderer heap/RSS and process RSS are not
  bounded. These are explicit A22 residuals, not a claim that all history
  reads are bounded.
- Remote CI `38106859302` on `5d80834` passed: the global Vitest job passed
  **4,680 tests across 415 files, with 8 skipped**, and Biome/typecheck passed.
  The same workflow passed pgTAP/integration, including all 91 assertions in
  `17_free_monthly_renewal.test.sql`, plus synthetic IPC protocol, compile-only
  sandbox, safe-filtered containment on Ubuntu/Windows/macOS, A17/A21.2,
  verifier-first and PTY cancellation jobs. No probe or enforcement scenario
  ran. Packaging workflow `38106859329` passed Windows x64; workflow
  `38106859331` passed macOS x64 and arm64.
- The immediately preceding global run `38105953909` passed Biome/typecheck
  but failed only the unchanged `FastVectorDistance` timing assertion at
  `0.115216 ms` against `<0.1 ms`; the current run passed all tests. The test,
  threshold, and filters were unchanged. This difference is evidence of
  differing outcomes across two commits, not enough to attribute a root cause
  to the environment, the benchmark, or this change.
