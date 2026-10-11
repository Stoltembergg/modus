# Windows Job Validation Mismatch Tests Implementation Plan

> **For agentic workers:** The orchestrator delegates the bounded implementation to `@fixer`, then independently validates and requests Oracle review. Tasks use checkbox syntax and TDD checkpoints.

**Goal:** Add Windows-only regression tests proving the suspended native setup rejects mismatched queried Job policy, process membership, Job PID list, and active-process accounting, with cleanup before assertions.

**Architecture:** Add only `cfg(test)` override seams for the four values already queried by `NativeSession`; apply each override after the real native query succeeds and immediately before its existing strict comparison. Each test drives the normal setup-failure cleanup path, installs an independent root reaper before post-creation validation, and asserts only after cleanup/reaping. Production policy and API calls remain unchanged.

**Tech Stack:** Rust, `windows-sys`, Windows-only integration tests, Cargo.

**Spec:** `docs/superpowers/plans/2026-10-07-plugin-execution-isolation.md` — Phase 1C-B Checkpoint 2 and Gate 4 constraints.

## Global Constraints

- Checkpoint 2 remains suspended-only: no resume, worker request, IPC observation, scenario execution, or quota policy.
- Preserve strict Job policy equality (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, no breakaway), positive `IsProcessInJob`, exact PID list `[root_pid]`, and active process count `1`.
- Test overrides are `cfg(test)` only, alter only queried values before comparison, and never skip or replace the underlying Windows API call.
- A semantic mismatch must return `NativeFailure` at its corresponding stage; cleanup uncertainty must never be reported as safe continuation.
- Keep fresh Job/root ownership, explicit inherited-handle allowlist, fixed worker executable, absolute 3/13/25-second clocks, and existing cleanup/watchdog semantics unchanged.
- Preserve the approved `child_process_tree` path; no production loader, plugin bytes, quota relaxation, Linux execution, staging, or commits. Global verdict remains `NO_GO`; macOS remains `NO_GO`; A01–A04 remain open.

## File Responsibilities

- Modify `crates/plugin-sandbox-probe/src/platform/windows_runtime/native.rs` only for narrow `cfg(test)` overrides applied immediately before the four existing validation comparisons.
- Modify `crates/plugin-sandbox-probe/tests/windows_runtime_native.rs` for four semantic-mismatch regressions and, if needed, one small test helper that always cleans/reaps before assertions.
- Do not modify production report, scenario orchestration, worker, supervisor, Cargo configuration, or workflow files.

---

### Task 1: Queried Job policy mismatch

**Files:** `native.rs`; `tests/windows_runtime_native.rs`.

**Interface:** Add or extend a narrow test-only validation override carrier with `queried_job_limit_flags: Option<u32>`. `NativeSession::prepare_with_validation_overrides(hook, overrides, optional_root_observer)` may forward these values through setup; the non-test `prepare()` path must not contain or accept overrides.

- [ ] Add a regression that supplies a mismatching flag value (for example, zero), records the `Result`, explicitly cleans any unexpectedly successful session before asserting, then expects `NativeFailure` with stage `QueryJobPolicy` and no fabricated OS error.
- [ ] Run only this regression before applying the override at the production comparison point. **Expected RED:** setup succeeds with the real required policy, so the cleanup-first test observes `Ok` and then fails its semantic-rejection assertion.
- [ ] Apply the test-only value after successful `QueryInformationJobObject` and before the existing exact-flags comparison. Keep native query failures unchanged.
- [ ] Run the regression again. **Expected GREEN:** setup fails at `QueryJobPolicy`; acquired handles are closed and cleanup is not reported safe unless all cleanup evidence confirms it.

### Task 2: False `IsProcessInJob`

**Files:** `native.rs`; `tests/windows_runtime_native.rs`.

**Interface:** Add `is_process_in_job: Option<bool>` to the same test-only carrier.

- [ ] Add a regression overriding the successful API result to `false`. Use the root-acquired observer/barrier to open an independent `TestRootReaper` before setup continues; record the result, terminate/wait through the independent reaper, and only then assert.
- [ ] Run only this regression before applying the override. **Expected RED:** the real membership result is true and setup returns a suspended session; the test cleans/reaps it before failing the expected-`NativeFailure` assertion.
- [ ] Apply the override after successful `IsProcessInJob` and before the existing false-result check. Keep API-call errors unchanged.
- [ ] Run the regression again. **Expected GREEN:** initiating stage is `VerifyMembership`; cleanup reports root wait and checked handle closure. Do not claim continuation safe if any cleanup field is uncertain.

### Task 3: Incorrect Job PID list

**Files:** `native.rs`; `tests/windows_runtime_native.rs`.

**Interface:** Add `job_process_ids: Option<Vec<u32>>` to the same test-only carrier.

- [ ] Add a regression overriding the successful `query_job_pids` result to an intentionally nonmatching list, such as an empty vector. Install the independent root reaper through the root-acquired observer before the PID query, clean and independently reap before assertions.
- [ ] Run the regression before applying the override. **Expected RED:** the real list equals `[root_pid]`, setup succeeds, and the test fails only after it has cleaned/reaped the root.
- [ ] Apply the override after the successful PID query and before the exact-list comparison. Leave query errors untouched.
- [ ] Run the regression again. **Expected GREEN:** initiating stage is `QueryJobPids`; cleanup and closure evidence are checked before assertion.

### Task 4: Active-process accounting mismatch

**Files:** `native.rs`; `tests/windows_runtime_native.rs`.

**Interface:** Add `active_processes: Option<u32>` to the same test-only carrier.

- [ ] Add a regression overriding the successful `query_active_processes` value to a value other than one (for example, two). Establish independent reaping before the query, then clean/reap before asserting.
- [ ] Run the regression before applying the override. **Expected RED:** the real count is one, setup succeeds, and the test fails its rejection assertion after cleanup.
- [ ] Apply the override after the successful accounting query and before the existing `!= 1` check. The override must not affect cleanup’s later live Job-accounting query.
- [ ] Run the regression again. **Expected GREEN:** initiating stage is `QueryAccounting`; post-cleanup active count is observed as zero when available, and uncertainty prevents continuation.

### Integrated verification

- [ ] Run `cargo test --locked -p plugin-sandbox-probe --test windows_runtime_native -- --test-threads=1` on Windows; expected all focused tests pass, including the four new mismatch regressions.
- [ ] Run `cargo fmt --manifest-path crates/plugin-sandbox-probe/Cargo.toml -- --check` and `git diff --check`; expected clean.
- [ ] Inspect the final diff for test-only gating, unchanged production comparisons, cleanup-before-assertion ordering, and no unrelated path edits. Then obtain Oracle review of the mismatch seams and cleanup evidence.
- [ ] Do not mark Checkpoint 2 complete or proceed to Checkpoint 3 until the remaining Oracle HOLDs are closed; this plan alone does not authorize runtime scenarios or alter `NO_GO`.

## Self-Review

- All four explicit semantic comparisons in Checkpoint 2 have a dedicated mismatching-value test.
- Each override is applied only after a successful real query and is absent from production builds.
- Normal successful post-root test paths clean a possibly successful session and independently reap a created root before assertions; Oracle `ora-24` identified failure-path gaps addressed in the follow-up below.
- Existing API-error paths, strict policy, watchdog, deadlines, quotas, global verdict, and scope restrictions remain unchanged.

## Oracle review feedback follow-up (`ora-24`)

### Task 5: Bound the setup helper and make containment acknowledgement fail closed

**Files:** `native.rs`; `tests/windows_runtime_native.rs`.

- [ ] Make the test-only root observer's acknowledgement explicit. A failed send, timeout, or negative acknowledgement must abort setup before membership/PID/accounting validation rather than be ignored.
- [ ] Handle root PID receive and `OpenProcess` failures as fixture failures, not immediate panics while setup is blocked. Send a negative acknowledgement or drop the channel deliberately, then collect setup cleanup evidence through bounded waits.
- [ ] Remove unconditional `setup.join()` after a channel timeout. On result timeout, terminate/wait through any successfully opened independent root reaper before waiting further. Join only after bounded confirmation with `JoinHandle::is_finished`; if completion remains unknown, report failure without claiming native cleanup safety, and never let a live root outlast the independent guard.
- [ ] After receiving the outcome message, allow a short bounded completion window for the setup thread to reach `is_finished()` before joining; do not turn the send-before-return scheduling race into a flaky immediate assertion.
- [ ] Add a deterministic behavioral regression where observer acknowledgement is rejected and prove setup aborts before the semantic override check; confirm all setup/helper paths release channels and remain bounded.
- [ ] Add a deterministic timeout-path regression (barrier at a post-root setup stage) proving independent termination/reap occurs before further waiting and the helper never unconditionally joins.

### Task 6: Assert cleanup safety classification, not just independent reaping

**Files:** `tests/windows_runtime_native.rs`; change `native.rs` only if a new behavioral regression proves the production classification is incorrect.

- [ ] For the clean policy-mismatch case, assert `continuation_safe` agrees with complete no-process cleanup evidence, including checked handle closure and in-deadline completion.
- [ ] For clean post-root mismatch cases, assert the required native evidence (root termination/wait, empty Job, completed/joined watchdog, confirmed recovery, no intervention/errors, closed duplicate/all handles, and in-deadline completion) and the corresponding `continuation_safe` result. Independent `TestRootReaper` success is supplemental and cannot replace any native cleanup evidence.
- [ ] Add a post-root mismatch case with an injected native cleanup uncertainty (for example, a scripted Job query error) while the independent reaper still succeeds; assert `continuation_safe == false` and the exact error is preserved.
- [ ] If feasible, demonstrate the negative regression by temporarily weakening the classification predicate, observe the behavioral assertion fail, restore the predicate, then run it green. Do not change a correct production predicate merely to add coverage.

### TDD evidence checkpoint

- [ ] Demonstrate behavioral RED for acknowledgement rejection by temporarily ignoring the observer's `false` result; the test must reach semantic validation or otherwise fail the intended assertion. Restore the abort check and verify GREEN.
- [ ] Demonstrate behavioral RED for timeout ordering by moving/reordering the independent reaper operation after the setup-barrier release; the timeout test must observe that the root was not reaped before release. Restore reap-before-release and verify GREEN.
- [ ] Demonstrate behavioral RED for cleanup safety by temporarily weakening the cleanup classification so a scripted `CleanupQueryJob` error can yield `continuation_safe=true`; the mismatch cleanup-error test must fail. Restore the predicate and verify GREEN.
- [ ] Run focused regressions after restoring production code. Record RED and GREEN outputs separately; if any mutation cannot be performed safely, report that precise limitation rather than claiming TDD complete.

### Task 7: Revalidate and re-review

- [ ] Run the timeout/acknowledgement/classification regressions individually, then `cargo test --locked -p plugin-sandbox-probe --test windows_runtime_native -- --test-threads=1`, crate fmt check, and `git diff --check`.
- [ ] Inspect failure-path cleanup and confirm no assertions or unbounded joins occur before independent containment. Request Oracle re-review of all three `ora-24` findings; no checkpoint pass is implied.
