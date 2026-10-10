# A21.5 — Implementation Plan

> **For the implementation session:** execute this plan only after the user approves it. Work only on `work/windows-guardian-task4` from the latest remote PR head. Keep PR #191 Draft. Use the remote CI/runtime for test, lint, and typecheck validation. Do not run enforcement probes or adversarial scenarios.

**Goal:** Integrate safe, measurable duplicate tool-result pruning into Pi SDK model-bound context while preserving the native compaction lifecycle and all prior A16, A17, and A21.1–A21.4 guarantees.

**Design:** Follow the approved specification in `docs/superpowers/specs/2026-10-09-a21-5-compaction-pruning.md`. Only the Pi SDK `context` hook may be registered. Eligibility is deny-by-default and limited to earlier, non-error, single-text results from approved read-only tools whose exact same-tool result remains later in the same context. Never prune protected, error, unknown, mutating, spill, QA/build/check, or multimodal content. Do not alter stored history. Do not register `session_before_compact`. Use active model window metadata when present; on uncertainty, preserve the original context.

**Implementation boundaries:** Expected files are `pi-compaction-extension.ts`, `harness/compaction/compaction-pruner.ts`, `pi-sdk-runtime.ts`, `harness/observability/harness-observer.ts`, and their focused tests. Adjust another file only if an observed productive-path dependency requires it. Do not change model resolution, provider routing, permissions, Verifier-First, isolation, Guardian, quotas, external plugins, or feature-flag defaults. Stop after A21.5.

## Task 1 — Reconfirm remote starting state and safe validation path

1. Fetch and verify the remote PR head, branch identity, Draft state, and clean working tree. Preserve every existing change; do not reset or overwrite user work.
2. Inspect current CI/workflow filters and identify the remote commands/jobs for focused Vitest, full Vitest, Biome, TypeScript, and existing approved checks. Confirm no selected command runs probes or enforcement scenarios.
3. Record the starting SHA and current A16/A17/A21.1–A21.4 checks for comparison.

**Acceptance:** implementation is based on the current remote PR head; the validation path excludes adversarial/enforcement jobs and retains existing security filters.

## Task 2 — Add failing tests for safe eligibility and preservation (RED)

1. Add focused pruner tests for exact duplicate eligibility, tool identity, byte-identical matching, later-copy retention, one-text-block requirement, envelope preservation, and positive measured serialized-byte delta.
2. Add negative cases for different tools/content, no later copy, errors, unknown/mutating tools, user/assistant/system content, QA/build/check and verifier evidence, spill references, mixed/multimodal content, and under-threshold context.
3. Assert all negative/uncertain cases return the original context unchanged and never claim hidden storage or token savings as provider-reported usage.
4. Commit the tests as a test-only RED commit and run them through the authorized remote validation path. Capture the exact expected failures. Do not alter/remove assertions to force RED or GREEN.

**Acceptance:** tests fail for the identified current implementation gaps and pass for no unrelated reason; no production source has changed in the RED commit.

## Task 3 — Add productive Pi SDK lifecycle tests (RED)

1. Extend `pi-sdk-runtime.test.ts` to exercise the actual runtime extension loader with an offline Pi SDK stream and the installed SDK event contract.
2. Assert flag-off default/no registration or no effect, flag-on `context` integration, current model context window handling, unchanged model/provider/thinking configuration, and no stored-history mutation.
3. Assert the extension does not subscribe to or cancel `session_before_compact`; verify manual, automatic/threshold, and overflow compaction stay on the Pi SDK native path.
4. Add session/run isolation cases for simultaneous sessions, Agent Groups/subagents, cancellation, restart/recreation, and stale callbacks. Check A17 durable QA/Task State and A21.4 spill paths remain intact.
5. Commit as a separate test-only RED commit and capture failing results remotely.

**Acceptance:** the failing tests enter through `PiSdkRuntime` and the real offline Pi stream, not only through isolated hook/pruner calls.

## Task 4 — Implement fail-safe duplicate pruning and context-hook registration (GREEN)

1. Tighten `compaction-pruner.ts` to use a deny-by-default allowlist of read-only informational tools and exact `toolResult` semantics. Reject all non-text, mixed-content, error, spill, evidence, unknown, and mutating cases. Remove broad role/tool-name inference.
2. Replace only an earlier duplicate's textual content with a concise marker while preserving its Pi SDK tool-result envelope; leave the later byte-identical result and all other messages unchanged. Do not use a storage-recovery claim.
3. Update `pi-compaction-extension.ts` to safely handle the installed SDK's `context` event and return an unchanged context on errors, stale lifecycle, disabled flag, missing prerequisites, or uncertain eligibility. Apply only when the current context policy calls for preventive headroom; prefer `ctx.model.contextWindow` when valid.
4. Remove the `session_before_compact` registration and every Modus cancellation/custom-summary behavior from this extension. Pi SDK remains the sole owner of manual, threshold, automatic, and overflow compaction.
5. Register the extension from `PiSdkRuntime` only under the effective feature flag and with the session/lifecycle token bound to that runtime instance. Recheck the active flag/token in each callback.
6. Do not mutate session history or make new durable copies of tool outputs. Keep all current model/provider/thinking selections untouched.

**Acceptance:** the productive runtime tests and eligibility tests turn GREEN; unsafe or uncertain cases remain byte-for-byte unchanged; native compaction is not intercepted.

## Task 5 — Record truthful metrics and lifecycle-safe telemetry (GREEN)

1. Measure serialized model-bound context bytes immediately before and after pruning; record only positive actual byte reduction.
2. Reuse `HarnessObserver`, attaching metrics to the active session/run and preventing stale callbacks from emitting after release/cancel/recreate.
3. Name/serialize token counts as estimates and keep them distinct from provider-reported usage. Do not report estimated tokens as realized provider savings.
4. Ensure telemetry contains no tool content and that observer failure cannot prevent the original model request.

**Acceptance:** tests prove exact byte delta, explicit token-estimate labeling, no content leakage, and unchanged-context fallback if observer or extension work fails.

## Task 6 — Prove interaction and regressions

1. Run focused offline-stream integration tests repeatedly to detect lifecycle/race instability.
2. Run tests for flag combinations, actual model windows, native manual/automatic/overflow compaction, spill references, QA/Verifier-First evidence, multimodal content, simultaneous sessions, Agent Groups/subagents, cancellation, restart, and stale callbacks.
3. Run A16 model-selection and A17 verification-integrity regression tests plus A21.1 repeat-guard, A21.2 flags/lifecycle, A21.3 PromptRegistry, and A21.4 spill tests. Do not modify those components to accommodate A21.5.
4. Compare serialized context before/after and show essential later duplicate content remains accessible in the same Pi context. Distinguish estimated token reduction from provider usage data.

**Acceptance:** all targeted tests pass and prior guarantees remain unchanged; any unsupported content shape fails open with original context.

## Task 7 — Remote checks, independent review, and PR publication

1. On the remote infrastructure, run focused and full Vitest, Biome, TypeScript/typecheck, and all applicable CI checks under the preserved security filters. Do not trigger probes, enforcement, or unrelated adversarial jobs.
2. Compare results against the recorded starting SHA and classify regressions only with evidence.
3. Request an independent review of the final diff and tests. Address actionable findings in task-specific commits and rerun affected remote checks.
4. Publish only A21.5-specific commits to `work/windows-guardian-task4`, confirm PR #191 remains Draft and no unrelated files/changes were included, and attach the PR artifact if needed.
5. Report root cause, files changed, RED/GREEN evidence, productive Pi SDK proof, remote check outputs, independent review, commit SHAs, and residual risks. Do not begin A21.6.

**Acceptance:** the PR is updated and remains Draft; no safety filter was bypassed; all claims are backed by fresh remote outputs; if safe eligibility or preservation cannot be proven, pruning stays disabled and the blocker is reported instead of claiming completion.
