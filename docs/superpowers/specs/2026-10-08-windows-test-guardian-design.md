# Windows diagnostic test guardian design

**Status:** Design approved by the user on 2026-10-08 after Oracle review. This document does not authorize implementation by itself; the implementation plan and applicable checkpoint gate require separate approval.
**Scope:** Test-only containment and reaping for the Windows diagnostic integration tests. It does not change the production sandbox design or enforcement claims.

## Purpose and hard boundaries

The current in-process test guard cannot outlive an abrupt exit of its test process. Add an external guardian that owns a test-only Job Object and supervises one isolated case-host process. The guardian protects the diagnostic test tree if the Cargo integration-test process exits or loses its control channel.

This is a trusted diagnostic-code harness, not an isolation boundary for plugins or hostile code. It must not receive plugin/WASM bytes, launch arbitrary commands, grant host capabilities, or be integrated into the production loader. The production external-origin gate stays closed; A01–A04 stay open; macOS stays NO-GO; strict 256 MiB RSS and 64-general-handle requirements remain unchanged. No staging or commit is authorized.

The guardian is containment and cleanup support only. It proves neither quota enforcement nor production Job behavior. A test result may claim root exit only after the guardian's retained root process handle is signaled. A successful termination API call, test-Job emptiness, or case-host exit is not a substitute.

## Process topology and ownership

Use the existing Windows integration-test binary and its exact ignored-test respawn pattern. For each `NativeSession::prepare` attempt, the ordinary test launches a fresh ignored guardian test, and that guardian launches one ignored case-host test. A single `#[test]` may run several attempts sequentially, but each gets its own guardian, case host, and guardian-owned test Job; no guardian reuses a Job or combines attempt evidence. One attempt can create zero or one diagnostic root. No Cargo target or production executable is added.

```text
Cargo / integration-test process
  └── ignored guardian test                 owns sole user-mode handle to J_test
        └── ignored isolated case host      created inside J_test, nonsuspended; awaits authorization
              └── fixed diagnostic root     inherits J_test; joins fresh production J_prod
                    └── fixed challenge descendants, only after a later tree-safe gate
```

- The guardian is created before `NativeSession::prepare()` and is not assigned to `J_test`.
- The guardian creates an unnamed, non-inheritable `J_test` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Set no resource quotas, UI limits, or breakaway flags. The guardian keeps the sole user-mode handle; do not duplicate or transfer this Job handle.
- Create the case host nonsuspended with `STARTUPINFOEX` and `PROC_THREAD_ATTRIBUTE_JOB_LIST` containing `J_test`, so it belongs to `J_test` at creation. Also use an explicit inherited-handle allowlist for only the private control endpoints and case metadata required by the protocol. Do not inherit `J_test`, production Job handles, worker pipes, or unrelated handles.
- Verify case-host membership in `J_test` using the returned process handle. The host must then wait on a bounded, private guardian authorization before calling `NativeSession::prepare()`. If creation, membership verification, authorization, or the wait fails, abort and clean up; there is no ordinary-process or post-create-assignment fallback. The case host is not created suspended and no `ResumeThread` operation is part of this protocol.
- A child created by the case host inherits its non-breakaway outer Job membership. The fixed diagnostic root is created suspended and then assigned to its own fresh production Job by the existing `NativeSession` path. Verify the root belongs to both `J_test` and `J_prod` before any later checkpoint is allowed to resume it. Do not duplicate or transfer `J_prod` to the guardian.
- `J_test` is only a parent-surviving containment layer. The production Job, its policy, accounting, scenario evidence, and existing worker lifecycle remain distinct.

The preferred implementation location is `tests/windows_runtime_native.rs`, using uniquely named `#[ignore]` guardian and case-host tests invoked with `current_exe --exact <name> --ignored --nocapture`, following the established pattern in `tests/worker_input.rs`. A private launch marker and bounded protocol distinguish guardian/case-host invocations from normal test discovery; an ordinary `--ignored` run must not accidentally start this protocol.

## Platform preflight and nested Job requirements

`PROC_THREAD_ATTRIBUTE_JOB_LIST` is documented for Windows 10 and later / Windows Server 2016 and later. Require that floor and record the actual OS product/build and architecture. Before a case can proceed, exercise creation-time Job assignment and verify exact membership; also verify that a suspended root can join its fresh production Job while retaining membership in `J_test`.

The preflight must fail closed when the OS floor is unmet, the job-list attribute is unavailable, an ancestor Job makes the requested hierarchy invalid, nested membership cannot be verified, or any relevant API result is ambiguous. Do not use breakaway, loosen a production limit, skip the guardian, or fall back to creating the case host outside `J_test`. A parent/ancestor Job may impose additional constraints; record what can be observed, and do not claim the guardian removed those constraints.

The case host's only pre-prepare gate is the bounded private guardian authorization, issued after `J_test` membership is confirmed. Keep the diagnostic root suspended until guardian custody is acknowledged and the existing production-Job setup/membership checks succeed. This ordering does not rely on an unverified assumption that application code is harmless before a later assignment.

## Root custody handshake

If `NativeSession::prepare()` successfully creates its suspended root, the case host reports one bounded, versioned `ROOT_OFFER` containing a fixed case identifier and the suspended root PID through a private guardian-control pipe. The host retains its original root HANDLE while the offer is in flight. The guardian:

1. Opens the root with `PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION` access, including the query right required for the following membership check.
2. Calls `IsProcessInJob` on the opened process and verifies that it is a member of `J_test`.
3. Retains that guardian-local process HANDLE and replies `ROOT_OWNED` only after both operations succeed.

The existing test-only root-acquired observer may implement this synchronous barrier. It returns success to `NativeSession` only after receiving the matching acknowledgement. There is at most one root offer per prepare attempt; duplicate, malformed, mismatched, late, or oversized frames fail closed. The guardian never receives a production Job handle and never resumes the root.

If `OpenProcess`, identity/membership verification, or acknowledgement fails after root creation, preparation aborts and custody validation fails even if test-Job containment cleanup succeeds. No root wait may be fabricated: passing still requires the guardian's retained root HANDLE and its signaled wait. The PID is offered while the host still owns the original process HANDLE and the root remains suspended; do not make an unpinned later PID lookup.

An expected prepare failure before successful root creation is reported as a trusted, explicit `NO_ROOT_CREATED` result, tied to the fixed case identifier and prepare attempt. It carries no `root_pid`, and claims no root handle, root wait, or root-signaled evidence. The case host must include the structured `NativeFailure` stage/root-creation evidence establishing that `CreateProcessW` never successfully created the root; the guardian must not infer this state merely from a missing `ROOT_OFFER`. A disconnect or missing result before that proof leaves root state unknown, triggers containment cleanup, and fails custody validation. Negative-path tests with verified `NO_ROOT_CREATED` may pass on their intended failure assertions together with an empty `J_test` and case-host exit; they do not claim root reaping. If a root was created but guardian handle acquisition or acknowledgement failed, the result is not `NO_ROOT_CREATED`; containment cleanup alone cannot validate custody and the case fails. A prepare attempt creates zero or one root, including tests that loop over multiple policy/prepare cases: each guardian invocation supervises only one attempt and must not combine attempts or their root evidence.

## Parent-disconnect and reap protocol

Use separate bounded private channels for launcher↔guardian and guardian↔case-host control. Include a protocol version and fixed case identifier; accept only fixed test operations such as `READY`, `PREPARE_AUTHORIZED`, `ROOT_OFFER`, `ROOT_OWNED`, `NO_ROOT_CREATED`, `CASE_RESULT`, `REAP`, and `ROOT_SIGNALED`. `PREPARE_AUTHORIZED` is sent only after case-host membership verification; `NO_ROOT_CREATED` is a trusted case-host result only for a prepare attempt that did not successfully create a root. No channel carries worker scenario input, plugin bytes, or arbitrary commands. Apply explicit handle allowlists at both process-creation boundaries so a descendant cannot keep a parent's control pipe artificially open.

Before launching the guardian, the ordinary test invocation establishes the single authoritative case origin using `QueryPerformanceCounter` and captures the corresponding `QueryPerformanceFrequency`. This origin is valid only for the same running Windows system/VM boot. It transports the origin tick and frequency in validated, versioned case metadata over the private launcher↔guardian protocol; the guardian passes the unchanged values to the case host, which supplies them unchanged to `NativeSession`. Each process queries its local QPC frequency and rejects a mismatch or invalid value. In guardian-controlled test mode, `NativeSession` must use this shared QPC origin for all deadline comparisons; it must not create a fresh local `Instant` origin or reset its `CaseClock`. The normal non-guardian runtime path is unchanged.

Derive absolute cutoffs from the one origin with checked integer arithmetic. The setup cutoff is origin + 3 s and covers guardian startup, test-Job setup, case-host creation/membership/authorization, and the complete `NativeSession::prepare()` setup/root-custody barrier. The handshake cutoff is origin + 13 s; it is not an additional 13 seconds after setup. The wall-clock work cutoff is the matched challenge-start observation's receipt time + 10 s. Cleanup is at most 2 s from the scheduled stop and clipped by the origin + 25 s overall cutoff. For the wall-clock scenario, scheduled stop is the calculated work cutoff, not a late watchdog wake. On setup failure, the case host captures `failure_observed_qpc` immediately when `prepare_inner()` returns the initiating error and before `NativeSession` cleanup begins. Its scheduled stop is that timestamp unless setup has already expired, in which case it is the setup cutoff. Include both values in the failure/control record and transport them unchanged to the guardian; the guardian's later IPC receipt must never restart cleanup. For an explicit cancel/disconnect, use the first recorded trigger QPC. Preserve these values and their existing schedule; no subprocess launch, guardian authorization, or `NativeSession::prepare()` entry may reset, restart, or extend any budget. Reject overflow, invalid frequency, or ambiguous cutoff ordering (including cross-process QPC values within ±1 tick) rather than extending a deadline. QPC includes system sleep time; these are wall-elapsed deadlines.

The launcher supplies the guardian with an explicitly inherited process HANDLE having `SYNCHRONIZE` access, in addition to its control channel. The guardian also retains the case-host process HANDLE and watches its control channel. A signaled launcher process, launcher-channel EOF/error, case-host exit, case-host-channel EOF/error, explicit `REAP`, or bounded protocol timeout triggers cleanup. Disconnect is idempotent and cannot be mistaken for successful cleanup. A fixed negative test may designate one specific `NativeSession` operation deadline as expected to expire; the test may pass only if it observes the intended operation failure/no prepared session and all originally scheduled cleanup, root-wait (when a root was created), Job-empty, handle-close, and overall cutoffs are met. This exception does not apply to guardian startup, test-Job membership, case-host authorization, root custody, protocol, cleanup, or overall deadlines; any such miss is a test failure. An expected operation expiry grants no extra time, and its later `NativeFailure` IPC receipt cannot move the scheduled stop or cleanup cutoff. The guardian may continue cleanup/wait attempts and retain its root HANDLE and `J_test` custody after a test deadline expires, without turning that timeout into success.

On cleanup, the guardian:

1. Records the trigger and, if it has a root HANDLE, checks whether the root is already signaled.
2. If the root is live, attempts `TerminateProcess` on that root and records the immediate API result/error.
3. Calls `TerminateJobObject(J_test, ...)` as tree-wide containment, including the case host and any diagnostic descendants. This is a cleanup action, not root-exit evidence.
4. Waits on the retained root HANDLE and case-host HANDLE, and verifies `J_test` has zero active processes. Capture each result independently.
5. Emits `ROOT_SIGNALED` only when `WaitForSingleObject(root, …)` returns `WAIT_OBJECT_0`. Retain the root HANDLE until that result is established; retain guardian Job custody until the contained tree is confirmed empty.

Do not block indefinitely on a pipe read, child wait, or reader-thread join. Use bounded protocol waits and process-object waits, or an equivalent event-driven design. Native API latency itself is not a hard real-time guarantee. The existing setup/handshake/work/cleanup and overall deadlines remain authoritative absolute cutoffs from the case origin; guardian startup and custody consume the same case budget rather than extending or resetting it. A case can pass only when all non-targeted deadlines and the original scheduled cleanup/reap cutoffs are met. The only allowed expected deadline failure is the fixed negative-test operation expiry described above; an unexpected operation miss or any guardian/protocol/cleanup/overall miss fails the test, even if the guardian continues holding custody and later establishes cleanup evidence.

## Failure and custody rules

- **Launcher exits before root custody:** The guardian still owns `J_test`; it terminates the Job and verifies Job emptiness. If no root HANDLE was acquired, it cannot claim a root wait or a passed cleanup result.
- **Launcher exits after root custody:** The guardian retains the root HANDLE, terminates the root and `J_test`, and waits independently. A passing cleanup requires the root HANDLE to signal, the case host to exit, and `J_test` to become empty within the applicable deadline.
- **Guardian crashes:** Windows closes its sole `J_test` handle, invoking kill-on-close as a containment fallback. This does not produce guardian-observed root-exit evidence and cannot pass the case. Do not put the guardian itself in `J_test` or in a parent-owned kill-on-close test Job.
- **Termination API fails or the root does not signal:** Record the error/outcome, retain the root HANDLE and `J_test` custody, and continue bounded retry/wait attempts without reporting reaped. The parent may time out and fail; it must not kill the guardian to make its own wait finish. Permanent OS termination failure is unresolved and cannot pass.
- **Root HANDLE was never acquired:** If a root was created, the guardian can use `J_test` to contain the tree and may wait for Job emptiness and the case host, but must not fabricate a root HANDLE wait; custody validation fails and this path is non-passing. The separate `NO_ROOT_CREATED` result has no root wait claim and may pass only on its intended failure assertions, case-host exit, and empty `J_test`.
- **Enclosing CI/ancestor Job terminates the guardian:** The guardian cannot survive an external supervisor that forcibly kills its process or its enclosing Job. This design covers abrupt exit/disconnect of the Cargo integration-test process when the guardian itself remains schedulable; it does not claim survival against OS shutdown, CI-job teardown, or external process termination.

There is no design that guarantees bounded guardian lifetime, retained last custody, and confirmed termination under permanent OS failure simultaneously. If termination is unresolved, retaining custody takes precedence over returning a false reaped result; a guardian may therefore outlive the test's bounded wait.

## Evidence and pass boundary

Record bounded guardian evidence separately from production `NativeSession` evidence:

- OS product/build/architecture and guardian protocol version;
- `J_test` policy queried, guardian ownership, nonsuspended case-host creation, bounded authorization, creation-time job-list result, and exact membership checks;
- launcher/case-host disconnect or explicit-reap trigger and its timestamp;
- root offer, root PID, guardian `OpenProcess` result/error, `J_test` membership, and acknowledgement receipt;
- root termination request/result/error, root wait result, case-host wait result, Job active-process counts, and final `J_test` emptiness;
- authoritative case-origin QPC value and frequency, monotonic offsets, absolute cutoff/deadline outcomes, and checked closure results for handles actually owned by each process;
- either root custody evidence for a successfully created root, or the explicit `NO_ROOT_CREATED` result with absent `root_pid` and no root-wait claim.

Null or unavailable evidence remains absent, not zero or inferred. A passing test for an attempt that created a root requires the existing production cleanup evidence plus an independently signaled guardian root HANDLE, case-host exit, verified empty `J_test`, checked handle closure, and all non-targeted deadlines. A fixed negative test may pass when its specifically designated `NativeSession` operation deadline expires as expected, provided it observes the intended failure and meets the original scheduled cleanup/reap and overall cutoffs. The distinct expected `NO_ROOT_CREATED` negative path may pass only on its intended failure assertions, case-host exit, verified empty `J_test`, checked handle closure, and all non-targeted deadlines, with no root-wait claim. Neither negative-test exception excuses guardian startup, authorization, custody, protocol, cleanup, or overall deadline misses. Job emptiness, `TerminateProcess == TRUE`, guardian exit, case-host exit, or kill-on-close alone never means `ROOT_SIGNALED`.

## Checkpoint and implementation sequencing

The first implementation may wrap only the currently authorized suspended diagnostic-root `NativeSession` checkpoint-2 tests. It must not call `ResumeThread`, send worker input, add IPC/scenarios, or change the approved `child_process_tree` path. The case host itself is nonsuspended; the diagnostic root remains suspended. Checkpoint 3 must separately establish tree-safe recovery and receive its existing review gate before any resumed root or tree scenario uses the guardian.

After user approval of this design, update the TDD implementation plan, implement only the guardian/test-fixture scope, validate bounded failure cleanup, the expected operation-deadline negative fixture, and abrupt-parent-exit behavior on supported Windows, and request Oracle re-review. The expected fixture must prove the operation expiry is reported while guardian cleanup still meets its original absolute cutoff. No checkpoint, Gate 4, Windows enforcement, Linux execution, or `NO_GO` status changes follow from the guardian design or its successful tests.

## References

- Microsoft, [`UpdateProcThreadAttribute`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) (`PROC_THREAD_ATTRIBUTE_JOB_LIST` version requirement and creation attribute).
- Microsoft, [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs) (nested hierarchy and effective constraints).
- Microsoft, [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) (membership and kill-on-close semantics).
- Microsoft, [Acquiring high-resolution time stamps](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps), [QueryPerformanceCounter](https://learn.microsoft.com/en-us/windows/win32/api/profileapi/nf-profileapi-queryperformancecounter), and [QueryPerformanceFrequency](https://learn.microsoft.com/en-us/windows/win32/api/profileapi/nf-profileapi-queryperformancefrequency) (same-system/process consistency, monotonicity, frequency, and arithmetic caveats).
- Current test respawn precedent: `crates/plugin-sandbox-probe/tests/worker_input.rs`.
- Current root-acquired observer and suspended-session path: `crates/plugin-sandbox-probe/src/platform/windows_runtime/native.rs` and `crates/plugin-sandbox-probe/tests/windows_runtime_native.rs`.
