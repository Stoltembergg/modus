# THX-01 Native Runtime Marco 2.1 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; one independent review at the end.

**Goal:** Promote the proven native inference to an experimental Linux CPU subprocess with bounded private JSON-lines IPC and an internal desktop supervisor.
**Architecture:** Reuse the validated Rust input construction/inference/calibration, with the validator depending on the shared crate. One model-owning thread, one bounded observation queue and native cancellation via ORT RunOptions. The TypeScript owner explicitly initializes, validates handshake/results and confirms process exit; no automatic restarts or observation-triggered startup.
**Tech Stack:** Rust, ort2.0.0-rc.10/ORT1.22.0, tokenizers0.22.2, Node child_process, Vitest.
**Spec:** docs/superpowers/specs/2026-10-15-thx-local-decision-model.md plus explicit attached Marco2.1 authorization.

## Global constraints

- Linux x64 experimental only; no model export, artifact change, PyTorch dependency, HTTP, downloads or Python fallback in runtime.
- 64KiB requests,16KiB responses, one active/four queued; CPU FP32 two intra-op/one inter-op;65–1024 tokens (existing proven graph envelope), no silent truncation.
- 5s inference deadline; explicit asynchronous initialize with60s startup deadline. Shutdown grace followed by TERM/KILL, confirmed close required. No implicit activation, PiSDK/MetaController/flags/UI/packaging changes.
- Immutable host-owned executable/manifest digests; verified artifacts before use; diagnostics never include input/error internals containing context.
- Budget proposal1280MiB, diagnostic only; distribution/enforcement not approved or claimed.

## Review focus

- Exit during startup/reinitialization: single flight and generations cannot resurrect old processes.
- Cancellation races/late results: rejected request stays correlated until completed/cancelled; never frees active slot prematurely.
- Queue pressure and newline-free streams: reject before unbounded allocation, bound backpressure.
- Missing/tampered local dependencies: verify before loading; never execute arbitrary request paths.
- Hung shutdown or timeout: reject observations, preserve failure until exit confirmed, no optimistic cleanup.

## Task1 — Native core and protocol

Files: crates/decision-runtime/{Cargo.toml,src/{lib,inference,protocol,main,service}.rs}, root Cargo.toml/Cargo.lock, scripts/thx01/equivalence/{Cargo.toml,src/main.rs}.
Interfaces: shared inference data/functions; Runtime::load(verified manifest), observe prepared input; protocol v1 generation/requestId with observe/cancel/shutdown and ready/started/result/error/cancelled/stopped outputs.
- [x] Add Rust tests for malformed/version/generation/frames/queue and guarded inputs; watch RED.
- [x] Promote validated code without changing arithmetic or model; verify manifest trust and required file coverage before library load.
- [x] Implement bounded input loop + worker, cancellation/deadline and safe output errors; Cargo test/check + standalone equivalence regression.

## Task2 — Internal supervisor

Files: apps/desktop/src/main/agent/decision/{decision-runtime,decision-runtime.test}.ts; main/index.ts shutdown drain only.
Interfaces: DecisionRuntime.initialize():Promise<void>, observe(input,AbortSignal?):Promise<Observation>, close():Promise<void>; module shutdown owner for app drain. No automatic initial instance loading.
- [x] Write failing Vitest tests for lazy/singleflight, queue, bounded frames, bad responses, cancellation, timeout, crash, shutdown and generations.
- [x] Implement using existing spawn/stdin/stdout/shutdown patterns; pinned executable/manifest hash checks; validated results and safe errors.
- [x] Pass directly affected Vitest, Typecheck and Biome.

## Task3 — Actual subprocess evidence

Files: scripts/thx01/runtime_smoke.py and docs/architecture/{thx01-native-runtime.md,evidence/thx01-m21/}.
- [x] Exercise actual offline Rust binary with synthetic PT/EN and near-limit inputs, compare frozen reference; record startup/inference/native RSS and deadline failures without changing5s.
- [x] Test actual artifact failure/oversize and cleanup; confirm no networking/Python child dependency. Re-run24frozen fixtures through shared core validator.
- [x] Independent whole-change review, one necessary fix pass. Commit dependencies and scoped runtime changes; publish feature branch without changing securityPRs. Stop before2.2/3.
