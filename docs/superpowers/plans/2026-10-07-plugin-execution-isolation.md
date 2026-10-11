# Plugin execution isolation implementation plan

> **For agentic workers:** Implement only the current phase's bounded tasks. Use TDD and validation evidence at every gate; do not weaken the external-origin block.

**Goal:** Establish a real, fail-closed execution boundary for future WASM-only external plugins without running external code in Modus main or granting ambient host authority.

**Architecture:** Preserve the existing host-owned registry/lifecycle as the sole control plane. Shared protocol/runner code and per-platform adapter source may advance independently with safe synthetic tests. Admission and external dispatch stay gated per platform until that platform proves every approved resource control and process-tree reap. External plugin origins remain denied throughout.

**Tech Stack:** Rust workspace, native per-OS sandbox mechanisms, Wasmtime compile-only/shared source work while platform gates are closed, existing TypeScript/Electron host and CI matrix.

**Spec:** `docs/superpowers/specs/2026-10-07-plugin-execution-isolation-design.md`

## Current mission override — 2026-10-11

The current A01–A25 authorization permits safe implementation work on Windows,
Linux, and macOS independently; one platform's investigation no longer gates
source work on another. It does **not** authorize probes, enforcement
scenarios, root-resume, or execution of untrusted plugin code. Preserve the
approved resource ceilings. Each platform remains NO-GO for external execution
until its adapter can enforce and validate every applicable ceiling under an
authorization for any blocked runtime proof. Guardian Tasks 5–7 and
Checkpoints 2–3 remain blocked. This override replaces older sequencing and
task-authorization text below where they conflict.

## Global Constraints

- Keep the existing host-owned origin gate closed for `community`, `local`, and all non-host-authorized origins.
- Initial external format is WASM-only; no Node, Electron, `process.env`, ambient filesystem, sockets, child process, or arbitrary host handles in the guest.
- Fail closed when sandbox policy, quota enforcement, or tree reap cannot be established; never fall back to an ordinary child process.
- Reuse the existing CapabilityRegistry, PluginLoader, PluginLifecycleService, permissions, tracing, dependency graph, rollback, Safe Mode, and Pi runtime; do not create a second registry/lifecycle manager.
- No broker grants for filesystem, network, shell, Git, or credentials until A07–A09 are separately fixed and proven.
- Windows, macOS, and Linux require independent real runner evidence; one platform cannot stand in for another.
- Preserve unrelated local changes. Commits and publication to the existing
  Draft PR are authorized; do not merge to `main`.

---

## Historical Phase 1 — Windows-first feasibility probes (superseded; no production guest execution)

The phase gate below records an earlier plan and does not grant current
permission to run its probes. Platform implementation is now independent; safe
source and synthetic tests may advance on each lane, while external execution
remains disabled until that platform meets the unchanged resource policy.

The macOS mechanism question is a precondition to admitting external execution, not to independent safe source work. **Current finding: XPC-only is NO-GO** for the required hard CPU-rate, memory, process-count, wall-time, and launchd-service termination/reap contract. Do not build or run the signed-XPC canary probe until a documented supported mechanism can enforce each missing quota before guest bytes are handled. Do not infer that an ad-hoc Electron package grants a helper a narrower sandbox. A macOS adapter may be developed and tested with synthetic inputs while the external-dispatch gate remains closed.

### Task 1: Identify a supported macOS enforcement backend (blocked)

**Files and boundary:**
- Do not implement or enable a production launch path until research identifies a supported mechanism. Safe adapter source, policy validation, and synthetic tests may proceed independently, but they cannot claim enforcement or admit external plugin execution. Record the official API, quota it enforces, enforcement ordering, and termination/absence-of-execution evidence in this plan and `.slim/deepwork/plugin-execution-isolation.md`.

**Validation:** Official platform documentation and packaging inspection must identify a supported hard-enforcement mechanism for every required quota and confirmed process termination before production launch-path source is enabled or any XPC canary probe is built. Safe adapter/policy source and synthetic tests may proceed while that gate remains closed. XPC-only is NO-GO. Do not substitute telemetry, watchdog, guest fuel, guest memory bounds, or `RLIMIT_CPU` for whole-helper limits. If no supported mechanism exists, record macOS NO-GO for external execution and continue independent source work on other lanes.

### Task 2: Windows restricted-process and Job Object feasibility probe (historical; execution blocked)

**Files:**
- Create `crates/plugin-sandbox-probe/src/platform/windows.rs` and Windows-only integration tests in `crates/plugin-sandbox-probe/tests/`.
- Add only the native Windows dependencies required for restricted/AppContainer launch and Job Objects to `crates/plugin-sandbox-probe/Cargo.toml`.
- Add the Windows job to `.github/workflows/plugin-sandbox-probe-windows.yml`; keep the existing modified `.github/workflows/ci.yml` untouched.

**Known documented enforcement:** Job Object hard CPU rate control, committed-memory limit, active-process limit and kill-on-close; restricted token/AppContainer plus resource ACLs; suspended creation and explicit inherited-handle whitelist. **Known gaps:** no documented hard per-process/job handle-count quota; committed-memory and working-set controls are not a hard RSS cap. `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` constrains inheritance only, not the number the process can later create. Therefore the strict 64-handle and 256 MiB RSS requirements force this probe's full-contract verdict to NO-GO unless another supported API is demonstrated. `GetProcessMemoryInfo`/handle counts are telemetry, not enforcement.

**Validation:** On Windows, prove creation is suspended and token/AppContainer policy plus Job Object are applied before resume. Test canary file/network denial, zero-child `ActiveProcessLimit`, hard CPU-rate 25% control, committed-memory limit, kill-on-close and complete descendant termination. Exercise handle creation past 64 and classify the result; do not claim `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` is a cap. Report RSS and handle observations separately from hard enforcement. The probe can pass as a diagnostic run while reporting `NO_GO`; a successful workflow is not a platform security pass.

**Current evidence (limited):** The Windows adapter configures CPU hard-cap and process/kill-on-close limits on an empty Job Object, intentionally launches no worker because a restricted/AppContainer launch is not implemented, and reports those quotas `not_tested`. RSS/handle are `unsupported`; duration and ambient canaries are `not_tested`/`not_run`. Local Windows `cargo test --locked -p plugin-sandbox-probe --all-targets` passed (PTY 4/4, report 2/2, worker 6/6, Windows adapter 1/1; Linux-only test 0 filtered), and `cargo run --locked -p plugin-sandbox-probe -- --probe` emitted valid `NO_GO` JSON. This proves API configuration acceptance only, not sandbox behavior, quota enforcement, or a CI runner result.

### Task 2A: Windows real-enforcement diagnostic tranche (historical; execution blocked)

**Files:**
- Modify `crates/plugin-sandbox-probe/src/report.rs` and `tests/report_serialization.rs` for a versioned per-scenario evidence schema and fail-closed pass validation.
- Modify `crates/plugin-sandbox-probe/src/worker.rs` and `src/main.rs` for fixed, host-owned worker scenarios and bounded readiness/observation messages; do not accept plugin bytes or arbitrary scenario parameters.
- Preserve `crates/plugin-sandbox-probe/src/platform/windows_supervisor.rs` and its approved `child_process_tree` path; add a narrow forwarding entry point plus `windows_runtime.rs` and focused scenario modules for the remaining cases. Keep `windows.rs` as report orchestration; add focused tests under `tests/windows_probe.rs` and `tests/windows_runtime.rs`.
- Modify `.github/workflows/plugin-sandbox-probe-windows.yml` only to validate scenario completeness/pass invariants and upload the structured report. Do not modify `.github/workflows/ci.yml` or Linux sources/workflow.
- Update this plan and `.slim/deepwork/plugin-execution-isolation.md` with real local/hosted Windows results after verification.

**Interfaces:**
- Add a fixed `ProbeScenario` enum containing exactly `cpu_loop`, `memory_bomb`, `wall_clock_timeout`, `child_process_tree`, `hard_kill`, `reap_deadline`, `handle_limit`, and `process_limit`.
- Add `ScenarioStatus` (`passed`, `failed`, `not_tested`), `EnforcementState`, and a bounded `ScenarioResult` containing required policy, mechanism/configured/effective policy, raw OS errors, challenge and independent observations, exit reason/code, duration, stop-to-reap/kill-to-reap, and worker/tree wait evidence. Use `Option` for measurements not observed.
- Add `scenarios: Vec<ScenarioResult>` to the diagnostic report. Validation rejects duplicate/missing scenarios and any `passed` scenario without observed challenge, attributed enforcement, verified worker termination, empty Job/tree, completed waits, and timely reap. `memory_bomb` can pass only with RSS enforcement evidence; Job commit and working-set observations are supplemental. `platform_probe_status` is passed only if all eight pass; the release verdict and invariant fields stay NO_GO/open.
- Each scenario uses one fresh Job Object and disposable fixed worker. Create/configure/query the Job; create worker suspended; assign and verify membership before resume; on any error, kill/wait/close handles and report non-pass. Use bounded IPC and a monotonic deadline; abort later scenarios and mark them `not_tested` if tree reap is not confirmed.
- The worker is fixed, trusted diagnostic code. This tranche does not establish AppContainer/restricted-token, filesystem, network, or untrusted-code isolation and must not report those as proven.

**TDD and implementation steps:**

1. Add report unit tests first: reject missing/duplicate scenarios; reject an apparent pass with missing enforcement/challenge/reap fields; reject `memory_bomb` pass when only Job commit is recorded; accept bounded non-pass records for all eight cases. Run `cargo test --locked -p plugin-sandbox-probe --test report_serialization` and confirm the new assertions fail before implementing schema/validation.
2. Add worker tests first for the closed scenario enum, unknown/out-of-order/oversized request rejection, and bounded readiness/observation frames. Implement fixed modes only: sustained single-thread CPU work; controlled page-touch memory challenge; noncooperative wait/loop; a live child/grandchild chain; held native handles; and one attempted child under the process-limit case. Add no arbitrary command, path, environment, or artifact input. Run worker/input tests and show RED then GREEN.
2a. **Historical Gate 2 remediation (blocked; not a prerequisite for independent source work):** The old probe plan called for worker challenge observations before CPU or timeout/reap work, typed spawn-failure observations, bounded one-request IPC, and Windows subprocess tests that create suspended workers, resume them, and create child processes. Those tests require root-resume/enforcement activity and are not authorized by the current mission. Do not run or implement their execution fixtures now. Source-level protocol and supervisor work may proceed only with safe synthetic inputs; it remains unproven and cannot open external dispatch. The old requirement that these tests pass before Task 3/4 starts is superseded.
3. Add Windows supervisor tests for suspended creation, Job assignment before first worker readiness, effective policy query, immediate Win32 error capture, and cleanup on setup/assignment/resume failure. Implement RAII for Job/process/thread/pipe handles and one monotonic per-case deadline. Run the focused Windows test before adding quota cases.
4. Add one independent Windows case per scenario. `cpu_loop` stays `not_tested` until parent Job eligibility and denominator calibration are resolved. `memory_bomb` and `handle_limit` run their actual bounded challenge, report private-commit/working-set/handle telemetry, perform complete cleanup, and remain `failed` with `enforcement=unsupported`; neither telemetry can pass its hard quota. `wall_clock_timeout` uses a fixed noncooperative root through the 10-second work deadline and parent-triggered tree cleanup ≤2 seconds. `hard_kill` and `reap_deadline` use distinct fresh noncooperative root+child trees with scenario-matched bounded child readiness; require exact Job membership, retained process handles and liveness before termination, then check each wait, exit, zero members, checked closure and timing. Do not modify the already-approved `child_process_tree` execution path. `process_limit` uses one fresh limit-1 Job and one fixed attempt. A generic spawn failure, absent child marker, or root-only snapshot is insufficient. The scenario can pass only if the fresh Job's verified completion-port key yields the active-limit event for the exclusive attempt, pre-termination Job accounting corroborates a stabilized root-only result/limit termination, documented pre-execution denial semantics are applicable, and ancestor Job restrictions are resolved. Because notification delivery and implicit-child error details are not guaranteed, missing/ambiguous evidence remains `failed` and unattributed. No auxiliary limit-2 production control is allowed; the existing limit-2 worker test remains test-only containment evidence. For each case, assert complete cleanup before pass/fail assertions and never pass from API configuration or worker claims.
5. Run the complete Windows crate test command and the diagnostic binary; parse its JSON and assert eight distinct entries, global `NO_GO`, `audit_findings_closed=false`, and `plugin_bytes_received=false`. Run formatting and `git diff --check`; inspect that no production loader, Linux implementation/workflow, `.github/workflows/ci.yml`, or unrelated dirty file changed.
6. This workflow and its scenario runner are historical probe work and cannot be run under the current authorization. Keep any platform's independent source work separate; no Windows result gates safe Linux/macOS source work. No external execution is admitted by this task.

### Historical Phase 1C — remaining Windows diagnostic runners (execution blocked)

**Architecture and ownership:** keep `run_child_tree_case()` and its approved helper bodies unchanged. A small `windows_runtime.rs` owns a fresh Job, suspended root, explicit inherited pipe handles, bounded one-request IPC, strict ready/observation correlation, timing, independent process observations, termination/reap and checked closure. It returns factual evidence and whether continuing is safe; thin scenario functions own policy and pass predicates. `windows.rs` only orders the eight cases and aborts later launches after unconfirmed cleanup. Do not introduce a generic sandbox framework or broaden production helper visibility for tests.

**Deadline contract:** take one `Instant` origin before `CreateJobObjectW`. Use setup cutoff origin+3 s; handshake cutoff origin+13 s (10 s after the setup budget); for the wall-clock case, work cutoff is parent receipt of the matched challenge-start observation +10 s; stop origin is that scheduled cutoff, not a late watchdog wake. Give cleanup at most 2 s from scheduled stop, clipped by an overall origin+25 s ceiling. Check before and after each synchronous native operation; an expired setup is failure and the worker must not be resumed. Native API latency is not a hard real-time guarantee; use bounded pipe waits and an independent watchdog wherever a blocked supervisor call could prevent termination. Never claim this new total-launch budget retroactively for `child_process_tree`.

**Evidence schema before runners:** add optional, bounded typed case timing offsets/deadlines; typed initiating and cleanup operation errors (keep their error stages separate); resource telemetry (allocation/touched bytes, private commit, working set, opened/observed handles); and process-limit attribution (configured/query-verified limit, fresh Job completion-key match/event, one spawn attempt/result, accounting before parent kill, stable post-attempt membership, pre-execution-denial applicability, and ancestor-policy resolution). Preserve schema v2 if additions remain backward-compatible and no old pass record can bypass stricter validation; otherwise bump and test the schema version. Every new `passed` result needs scenario evidence, effective policy, attributed enforcement, termination/requested exits, zero Job members, all process/Job handles checked closed, and timing within the recorded case/cleanup deadlines. `memory_bomb` also requires hard RSS evidence; `handle_limit` requires a hard general-handle quota; `process_limit` requires the full attribution predicate above. Preserve the existing child-tree validation and its accepted result.

**Phase 1C-A — independent prerequisites, in parallel:**

1. `report.rs` + `tests/report_serialization.rs`: add the typed evidence fields and fail-closed predicates first. RED tests must reject generic passes with missing closure/timing, handle telemetry presented as a hard cap, process-limit passes lacking a correlated event/accounting/pre-execution proof, and errors that conflate initiating failure with cleanup. Preserve accepted child-tree pass fixtures and global NO_GO invariants. Run the focused report target, all-target crate tests and fmt. Validation owner: orchestrator.
2. `worker.rs`, `main.rs`, `tests/worker_input.rs`, and `tests/windows_worker_liveness.rs`: add fixed scenario-matched root+child modes for `hard_kill` and `reap_deadline`, retaining the existing child-tree command/readiness contract. Both modes emit bounded start/child-ready frames before noncooperative work; `wall_clock_timeout` remains the fixed root spin. Keep `process_limit` as a distinct one-attempt challenge; never relabel its outcome. TDD with strict scenario/sequence parsing and actual-binary fresh-Job tests; all children stay inside their Job and every test cleans before assertions. No enforcement claims. Validation owner: orchestrator.

**Historical Gate 3:** this probe-specific review gate is blocked until specific authorization. Safe implementation on another platform does not wait for this gate. Commits are authorized by the current mission.

**Gate 3 HOLD remediation (required before re-review):** (a) For new scenarios only, require scheduled stop ≥ matched observation; for `hard_kill`/`reap_deadline`, record child-ready receipt and require it within handshake cutoff and before stop. Reconcile stop-to-reap with `all_handles_closed_ms - scheduled_stop_ms`, kill-to-reap with `all_handles_closed_ms - termination_call_ms`, nested/top-level reap values, and `duration_ms` with final closure and the 25-second case ceiling. Preserve the legacy child-tree branch/fixture. Add negative tests for stop-before-observation, child-ready late/after-stop, mismatched summary durations, and duration short/over cap. (b) Prohibit `cpu_loop` passes until a separately approved calibration/parent-Job contract exists; move generic synthetic pass fixtures to a pass-eligible scenario (for example, MemoryBomb with explicit synthetic RSS evidence) so negative assertions test their intended predicate. (c) Reject `HardKill`, `ReapDeadline`, and `ProcessLimit` requests in the non-supervised in-process `run_worker` API before writing readiness or invoking any spawn path; child-creating challenges remain exclusive to actual supervised subprocess workers. Add tests asserting early error and no output. Re-run report/worker targets, full crate, formatting, whitespace/JSON checks; then request Gate 3 re-review attempt 2. No runtime writer starts until re-review PASS.

**Phase 1C-B — runtime and case orchestration (after Gate 3 PASS):** proceed through independently testable checkpoints; no broad scenario implementation lane. Checkpoint 1 adds checked HANDLE ownership and the exact absolute case clock. **Checkpoint 2 adds only a suspended `NativeSession`** in `windows_runtime/native.rs`: fresh unnamed Job with queried kill-on-close/no-breakaway policy, private pipes and explicit inherited-handle allowlist, fixed `--worker` binary launched suspended, root-only membership/accounting verified, and independent root-only watchdog using an owned duplicate process handle (never a duplicate Job). It returns a suspended session; `resume()`, worker input, IPC, scenarios, and quota policy are forbidden in this checkpoint. `NativeFailure` must carry initiating error plus observed cleanup evidence; failure after process creation cannot flow through the unconditional `unavailable()` helper. Cleanup distinguishes no process, suspended assignment failure/uncertainty, and assigned suspended root; uncertainty attempts both root and Job termination. If Job termination fails, close the sole Job as emergency kill-on-close recovery and do not claim Job-empty afterward. Watchdog is armed immediately after root acquisition, canceled through an owned channel, waited only to the absolute deadline, joined only after `is_finished`, and its duplicate process handle is checked and included in closure evidence. Any unresolved wait/close/watchdog makes continuation unsafe. Tests use scripted native calls and barriers for stage failures, policy/membership mismatch, setup cutoff, cleanup failures and watchdog cancel/expire; real launch tests install an independent test guard and complete bounded cleanup before assertions. Checkpoint 3 must establish tree-safe recovery before any resume. Later checkpoints add strict bounded IPC; hard-kill/reap-deadline; wall-clock; memory/handle telemetry (always non-passing/unsupported); process-limit attribution last. Each case gets a fresh Job/worker and the full deadline contract. For process-limit, baseline accounting before the single attempt and capture the completion message before parent termination; do not infer attribution from message order, raw spawn errors or absence of a marker. If documented pre-execution denial or ancestor-policy eligibility cannot be established, report `failed`, `enforcement=Configured`, `enforcement_attributed=false` and continue only after verified cleanup. In `windows.rs`, stop after any unconfirmed reap and fill remaining scenarios with `not_tested`; global tree/termination summaries must cover all launched cases.

**Guardian subplan status (separate from A01–A25):** prior authorization records approved fixture work, but the current A01–A25 mission does not initiate Guardian work. Checkpoint 2 and Checkpoint 3 remain HOLD; Guardian Tasks 5–7, root-resume, worker scenarios, and enforcement remain blocked. No checkpoint is cleared by this plan.

**Historical Gate 4:** Windows runtime/probe/liveness targets and `--probe` execution are blocked by the current authorization. A future authorization must retain fail-closed report checks and platform-specific evidence. Linux implementation remains independent; no platform's probe result substitutes for another. Commits remain authorized, but do not merge.

**Hard feasibility stops:** the user retained the 256 MiB RSS requirement and a hard limit of 64 general kernel handles. Current Microsoft API research found no tamper-resistant RSS quota or documented general handle-count quota: Job memory limits constrain committed memory; working-set maxima permit paging and worker self-change. Therefore these cases must stay `failed`/`not_tested` unless a supported mechanism is proven; do not reinterpret telemetry, commit charge, or inherited-handle allowlists. Windows remains independently NO-GO; this does not block safe implementation work on Linux or macOS. Keep external execution blocked, A01–A04 open, and all probe execution pending specific authorization.

### Task 3: Linux namespace, Landlock/seccomp, and cgroup lane (independent; runtime probes blocked)

**Current sequencing:** Linux implementation does not wait for Windows. The
existing Linux preflight still launches no worker and installs no policy. Do
not begin Linux worker execution or enforcement probes under the current
authorization. The known `memory.max` versus RSS gap leaves Linux independently
NO-GO for external execution; do not presume platform equivalence.

**Files:**
- Create `crates/plugin-sandbox-probe/src/platform/linux.rs` and Linux-only integration tests in `crates/plugin-sandbox-probe/tests/`.
- Add only the Linux syscall/runtime dependencies needed by this probe to `crates/plugin-sandbox-probe/Cargo.toml`.
- Add the Linux job to `.github/workflows/plugin-sandbox-probe-linux.yml`; keep the existing modified `.github/workflows/ci.yml` untouched and do not set `continue-on-error`.

**Known documented enforcement:** cgroup v2 `cpu.max`, `memory.max`, `pids.max`, `cgroup.kill`; `RLIMIT_NOFILE` hard/soft limit 64; user/mount/PID/network namespaces, seccomp with `no_new_privs`, and Landlock when supported. **Known gap:** `memory.max` is a cgroup memory ceiling, not an RSS-only quota; do not silently treat it as equivalent to the approved 256 MiB process-RSS limit. The WASM 128 MiB limit cannot be tested until a runtime exists. Missing cgroup delegation or kernel features forces NO-GO.

**Validation (blocked):** Enforcement probes require separate explicit
authorization. Until then use source review and synthetic protocol/policy
fixtures only; missing namespace, Landlock/seccomp, or cgroup delegation is a
NO-GO finding, and cgroup memory is not an RSS cap.

**Current evidence (preflight only):** Linux adapter intentionally launches no worker and installs no policy; it reports kernel/cgroup/namespace/security observations, all canaries `not_run`, and fixed `NO_GO`. The delegated test command ran on Windows and filtered the Linux-specific test (0 tests); local WSL is unavailable. No Linux compilation, probe execution, or cgroup evidence is claimed until the dedicated `ubuntu-latest` workflow produces a real runner result. This preflight alone does not pass the Linux gate.

### Task 4: Common adversarial probe contract and phase reconciliation

**Files:**
- Create `crates/plugin-sandbox-probe/src/main.rs`, common probe definitions under `crates/plugin-sandbox-probe/src/probe.rs`, and the root workspace member in `Cargo.toml` only after platform lane interfaces are agreed.
- Modify `crates/plugin-sandbox-probe/Cargo.toml` to expose a deterministic test binary and integration-test target.
- Update root `Cargo.lock` only for the new workspace package and dependencies; preserve existing locked versions where possible.
- Update `.slim/deepwork/plugin-execution-isolation.md` with exact runner results and changed paths.

**Probe contract:** Use a fixed, non-plugin worker with host-generated canary paths and values. Record that policy activation precedes the worker's first application instruction and that no guest bytes, guest-controlled paths, environment, or inherited handles arrive before activation. Probe environment, out-of-root file read/write, loopback connection, child-process attempt, CPU loop, memory growth, handle/FD growth, timeout, and full-tree termination. Report each observation through a bounded parent-created pipe; never make stdout an unbounded trust channel. Emit a bounded machine-readable evidence manifest where every control is `enforced`, `measured_only`, `unsupported`, or `not_tested`, with mechanism and observed result. Set each platform verdict to `NO_GO` if any approved quota lacks enforcement; do not convert a diagnostic test pass into a security pass. The worker must not receive artifact bytes. Phase 2 must repeat this ordering proof with actual WASM bytes before any A01 claim.

**Validation commands:** `cargo fmt --all -- --check`; `cargo test --workspace --locked` on Windows and Linux; platform probe command with explicit test mode; dedicated CI returns real results for `windows-latest` and `ubuntu-latest`. Archive OS/runner architecture, executable and policy hashes, denial observations, quota enforcement method/results, and process exit/reap results. These two runs are partial evidence only and do not imply macOS or other-installation support.

**Historical phase review:** probe review requires specific authorization; do not run probes under the current mission. Source work on another platform does not wait for this review. Any future result remains platform-specific and cannot substitute for another OS.

## Phase 2 — Versioned protocol and Rust/Wasmtime runner (shared source work can proceed; dispatch remains gated per platform)

Shared protocol and runner source may be implemented and safely tested independently of platform lanes. It must remain disconnected from external plugin ingress until the selected platform adapter enforces the complete approved policy and required runtime proof receives authorization. Add strict versioned length-framed RPC schemas, reject unknown/duplicate/out-of-order/oversized messages before dispatch, host-issued identity and generation, bounded stdout/stderr, one helper per plugin generation, and preemptive OS termination. WASI environment/filesystem/network/process/stdio imports and preopens are absent; only allowlisted `modus:host` calls exist. Do not treat compile-only or synthetic tests as proof of OS enforcement. TDD safe protocol fixtures only; any probe/enforcement scenario remains blocked.

## Phase 3 — Host proxies and lifecycle integration (safe source work may proceed; external ingress remains denied)

Add one `PluginExecutionHost` coordinator and host-side broker dispatcher; external providers registered in the existing CapabilityRegistry are host-created proxies. Route every external lifecycle hook through the same executor. Use origin, immutable digest, host grants, and generation from host authority, never persisted trust claims or guest fields. Wire quarantine → revoke/cancel → kill/reap → rollback/state commit to Stop, timeout, crash, disable, uninstall, upgrade/rollback, startup recovery, and Safe Mode. Preserve current denial in production and keep Pi SDK external-extension autoload disabled. Oracle gate must inspect all execution ingress and cleanup/provider-ghost races.

## Phase 4 — Packaged adversarial E2E and release evidence (blocked; requires specific authorization)

This phase would execute probes and adversarial/enforcement scenarios and is not
authorized. Do not run it under the current mission. A future explicit
authorization must test the actual packaged dispatch path separately on each
OS, retain denial/reap evidence, and keep plugin origins blocked until all
platform-specific requirements pass; external plugins still require a
separate user decision to reopen.

## Exit conditions and out-of-scope findings

A01–A04 close only when all exact criteria in the spec pass in packaged E2E on each supported OS. Keep NO-GO if any adapter is unavailable or evidence is missing. This plan does not close A05–A06, A07–A09, A10–A14, general A15, A20–A25, supply-chain/kernel/runtime escape risks, or the seven unattributed broad Pi suite failures.
