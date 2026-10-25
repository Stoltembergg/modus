# THX-01 Shadow Observation Follow-up Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional, local THX-01 observations to real Harness turns without affecting prompt delivery, Meta Controller decisions, model selection, permissions, tools, or retries.

**Architecture:** Port the attributable native runtime from `1fab3d6628fb7db80929ce22d3d4be5054d9a23a` only after a development-only artifact loader passes its own gate. Connect a bounded observation to the existing Pi run lifecycle and record only run-correlated outputs; keep `decideNext` authoritative and leave the secure production bootstrap unchanged.

**Tech Stack:** TypeScript, Pi SDK, existing Rust `decision-runtime`, ONNX Runtime, existing Harness observer and Vitest.

**Spec:** [Harness quality evolution design](../specs/2026-10-25-modus-harness-quality-evolution-design.md) and [THX source inventory](../../evaluations/thx-shadow-source-inventory.md).

## Global Constraints

- Use only the source revision and artifact pins recorded in `thx-shadow-source-inventory.md`; do not download weights or contact a model service.
- Keep the secure bootstrap denial and production artifact trust root unchanged.
- A development loader must verify all six local artifacts against host-owned pins and must be excluded from production build outputs, not merely disabled by a runtime flag.
- Default the observer off; initialization and inference must never delay `pre_prompt` or prompt delivery.
- The observation may report only `context_sufficient`, `retrieve_local_context`, or `insufficient_information`, with finite probabilities/confidence and matching run/generation identity.
- Never feed THX output into `decideNext`, model/provider selection, tool execution, permissions, verification, or retry policy.
- Do not persist prompt/code text or upload observations. Discard stale results after cancellation, session replacement, or run replacement.
- Keep 24-fixture ONNX equivalence separate from Harness decision-quality evaluation.

## Review Focus

1. A missing, tampered, or incomplete local bundle must leave the observer unavailable without blocking the task.
2. A slow or hung process must not hold `pre_prompt`; startup and inference deadlines must cancel and reap it.
3. A result from an earlier run or replaced session must not be attributed to the current task.
4. Production packaging must not contain the development loader or an environment/configuration route that can enable it.
5. A valid but low-confidence or unsupported result must remain observational and must not change the deterministic Harness path.

## Plan and Gates

This is a follow-up plan, not authorization to alter the secure loader, production packaging, or current Harness behavior. Stop at each gate and report evidence before continuing.

### Gate 1 — Development-only native runtime

**Source paths at the pinned ref:** `crates/decision-runtime/src/{main,service,protocol,artifacts,inference}.rs`; `apps/desktop/src/main/agent/decision/{decision-runtime,artifact-trust,native-trust-root}.ts`.

- [ ] Port the native inference service and supervisor from the pinned ref without changing the three labels, tokenization, preprocessing, weights, calibration, or ONNX options.
- [ ] Add a separate development bundle resolver for the six locally supplied artifacts, verifying the pinned SHA-256 values before launch and rejecting symlinks, missing files, and mismatched digests. Keep `openTrustedExecutable()` and its production denial unchanged.
- [ ] Make the resolver unavailable in production artifacts through build-time inclusion and verify both development and production bundles. A runtime environment variable alone is not an exclusion boundary.
- [ ] Add Rust/TypeScript tests for artifact identity, startup/handshake failure, timeout, cancellation, cleanup, offline operation, and production-bundle exclusion.
- [ ] Run one real local inference only after the user-provided bundle passes all six pins; report class, probabilities, confidence, latency, and exact artifact digests.

**Gate 1 acceptance:** real local inference runs from the verified bundle in a development build; production output cannot import or launch the experimental runtime; the existing secure bootstrap still denies launch. Stop on artifact, memory, or platform incompatibility.

### Gate 2 — Pi SDK observation lifecycle

**Consumers:** `apps/desktop/src/main/agent/pi-sdk-runtime.ts` (`consultAdaptiveController` at the `pre_prompt` boundary and the active `run.id` lifecycle); `apps/desktop/src/main/agent/harness/observability/harness-observer.ts`; `apps/desktop/src/main/agent/harness/meta-controller.ts` (`decideNext`).

- [ ] Define a small `DecisionShadow` contract in `apps/desktop/src/main/agent/decision/decision-shadow.ts`. Inputs carry only a bounded, typed snapshot and `{sessionId, runId, sessionToken}` correlation; outputs carry the three-class distribution, confidence, duration, and runtime generation. Do not include raw prompt/code or introduce another controller.
- [ ] Schedule observations asynchronously from the existing `pre_prompt` point after the deterministic decision snapshot exists. Prompt delivery and `decideNext` must not await runtime initialization or inference.
- [ ] Correlate completion with the current session token and active run; cancel or discard it on run cancellation, session replacement, runtime shutdown, or generation change.
- [ ] Record a bounded observation through the existing Harness observability boundary. Add no UI, new modal, remote telemetry, or raw-context persistence.
- [ ] Add Pi runtime tests proving prompt delivery is unchanged when THX is disabled, unavailable, slow, cancelled, or returns a stale result; assert `decideNext` receives identical inputs and outputs with the observer on and off.

**Gate 2 acceptance:** eligible turns can receive a run-correlated shadow observation; every failure/stale case is non-blocking and leaves the deterministic Harness result unchanged.

### Gate 3 — Qualification and release boundary

- [ ] Keep the original 24-fixture equivalence corpus and its approved tolerances unchanged; do not substitute Harness tests for ONNX equivalence.
- [ ] Run the fixed v1/v2 live evaluation only with the user's exact provider/model, thinking level, and cost ceiling, using the same configuration for comparable refs. Keep results separated by corpus and revision.
- [ ] Measure startup, inference latency, memory, timeout rate, stale-result rate, and recommendation/outcome agreement. Treat a small fixture set as a signal, not proof of general decision quality.
- [ ] Re-run TypeScript, Pi SDK, Rust, packaging, and platform-specific validation. Keep Linux-only results from being described as Windows/macOS support.

**Gate 3 acceptance:** reports distinguish functional inference, lifecycle safety, contextual quality, and distribution readiness. No GO for integration or distribution while a required gate remains HOLD.

## Stop Conditions

- The pinned native source, six artifact hashes, or local bundle cannot be independently verified.
- The development runtime cannot be excluded from official production artifacts.
- Asynchronous observation cannot preserve the current prompt deadline and run/session ownership.
- Any test shows THX can change the effective model, `decideNext`, tools, permissions, or task completion status.
- Live evaluation parameters or cost authorization are absent; in that case keep quality claims in HOLD and do not invoke a provider.
