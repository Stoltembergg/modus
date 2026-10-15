# Native THX-01 Decision Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for approved execution. This document authorizes no execution by itself. Stop at each milestone and obtain the user's authorization before the next.

**Goal:** Establish measured native equivalence for `choice` with exactly three context alternatives, then a supervised Rust runtime on one development platform, then observation-only Pi SDK integration.

**Authorization:** revised architecture and milestone 1 explicitly authorized. **Execution stopped blocked:** the single export call failed in ONNXScript version conversion; see `docs/architecture/thx01-onnx-feasibility.md`. No milestone-2 authorization or native equivalence is established. Marco 1.1 subsequently resolved that specific converter failure with ONNXScript 0.6.2; the Checker-valid artifact still has a fixed 97-token attention mask. See `docs/architecture/thx01-onnxscript-diagnosis.md`. Marco 1.2 subsequently validated directed variable-length Python ORT agreement (see `docs/architecture/thx01-dynamic-shapes-validation.md`). Marco 1.3 was subsequently authorized and completed the frozen 24-case Rust/PyTorch technical comparison on Linux x64; see `docs/architecture/thx01-rust-equivalence.md`. Marco2.1 was subsequently explicitly authorized and implemented; see `docs/architecture/thx01-native-runtime.md`. Marco2.2 packaging/distribution and Marco3 remain unauthorized; stop after2.1.

**Architecture:** Rust + ONNX Runtime (`ort`) + a compatible tokenizer in an internal application-owned subprocess, separate from Electron and external plugins. Python/PyTorch exists only in development export/reference tooling. The existing Meta Controller and dispatcher remain authoritative.

**Tech Stack:** Rust, ONNX Runtime CPU FP32, compatible Rust tokenizer; Python/PyTorch/ONNX for development-time reference/export; TypeScript and Vitest for host integration.

**Spec:** `docs/superpowers/specs/2026-10-15-thx-local-decision-model.md` (revised native architecture and milestone 1 authorized).

## Global constraints

- Checkpoint: `doofz/THX-01`, revision `01262517979528a0103108ba473b78d6baeec016`; verified local artifacts only.
- Initial consumed capability: `choice` with exactly `context_sufficient`, `retrieve_local_context`, `insufficient_information`. Preserve the original mmBERT encoder, decision head, weights, tokenizer and applicable calibration. No component substitutions to ease export.
- `noul`, `score` and tournaments above 24 alternatives are inventory-only; no implementation, test suite or full-equivalence gate for those features in milestone 1.
- No production Python, venv, user-installed runtime, remote inference, HTTP listener or runtime downloads.
- No model/provider switching, QA approvals, permissions changes, new UI or external plugin execution.
- No effect on effective Harness decisions throughout all three milestones; the internal feature remains false by default.
- Maximum 1,024 tokens including question/options/state; reject silent truncation.
- Milestones 2/3 only: one active inference, four waiting observations; 64 KiB request and 16 KiB response frames; 60-second startup and 5-second inference bounds. Do not build this infrastructure in milestone 1.
- Initial CPU settings: one inter-op and two intra-op threads. No quantization or unvalidated execution provider.
- Never claim cross-platform support, kernel-enforced resource limits, full input-space equivalence or improved delivery quality from synthetic tests.
- Guardian Tasks 5–7 and Checkpoints 2/3 remain blocked/HOLD; no adversarial or enforcement probes.

## Review focus

- Almost-tied choices: numerical closeness must not hide a changed decision (milestone 1).
- Unicode, option ordering and token limits: exact tokenizer/serialization parity precedes output comparison (milestone 1).
- ONNX external data/library loading: reject unverified or path-escaping files and unvalidated bundles (milestone 2).
- Cancelling one session during shared inference: no late observation and no cancellation of other baseline tasks (milestones 2/3).
- Missing native runtime: normal prompts continue, without Python/cloud fallback or fabricated observations (milestones 2/3).

---

## Milestone 1 — Feasibility and equivalence, without Modus integration

**Files planned:** development tools under `scripts/thx01/` (`export_onnx.py`, `reference.py`, `fixtures.jsonl`, `equivalence/Cargo.toml`, `equivalence/src/main.rs`); evidence report `docs/architecture/thx01-onnx-feasibility.md`. No changes to desktop runtime, root Cargo workspace, flags, packaging or IPC in this milestone.

**Interface produced:** a candidate ONNX artifact bundle with tokenizer/calibration files and digest manifest; paired reference/native results keyed by fixture ID; a reproducible go/no-go report. The standalone Rust runner is validation tooling, not the shipped service.

- [ ] Inspect the pinned loader/model and identify the three-choice path: encoder/head inputs and outputs, ModernBERT sliding/global attention, rotary calculations, marker indexing, padding and applicable temperature/clamp rules. Briefly inventory unused answer types without implementing or testing them. Record exporter/opset/`ort` constraints; a proven structural incompatibility ends the milestone immediately.
- [ ] Prepare explicitly downloaded pinned assets and an isolated development Python environment. Record versions/digests and licenses. No training, replacement model or production dependency changes.
- [ ] Start with a minimal smoke test: one Portuguese and one English input, each using exactly the three context alternatives. Record original FP32 inference, export the unchanged encoder/head, and execute the graph with the minimum Rust `ort` runner. Do not build a larger corpus or production infrastructure before this real inference path works. This smoke test is necessary but not full acceptance.
- [ ] Only after smoke success, freeze exactly 24 fixtures (12 Portuguese and 12 English) before final comparison in a PT/EN equivalence set covering ordinary and difficult/ambiguous inputs, close ties, accents/Unicode, identifiers, alternative ordering, and short/near-1,024-token inputs; reject over-limit input rather than truncate. Preserve raw full-precision references and record decision margins. No initial 120-question requirement or indefinite corpus expansion. Keep later contextual-quality evaluation examples independent and untouched; do not fit new temperatures or tune the checkpoint.
- [ ] Write comparison checks before using them for acceptance; prove they reject perturbed token IDs/masks/positions, applicable temperature, logits, probabilities and choices. This checks fidelity detection, not contextual classification accuracy. Do not build checkers for unused answer types.
- [ ] Preserve the complete original encoder/head and the applicable three-choice calibration/postprocessing boundary. A narrowly scoped export entry point for the existing three-choice path is allowed; changing encoder, attention, head, weights, tokenizer or calibration to make export easier is not. Support the consumed three-option/length envelope and report shape limits. No generic exporter or compatibility framework.
- [ ] Keep the smoke-test Rust runner minimal: local graph loading, compatible tokenizer, three-choice postprocessing and comparison output. Compare both identical serialized tensors and Rust-tokenized inputs. Do not substitute ONNX-in-Python execution for Rust validation. No service, IPC, supervisors or generic model abstraction.
- [ ] Verify exact token IDs, masks, marker positions and type IDs for the three-choice path. Check raw logits with `atol=1e-4, rtol=1e-3`; calibrated probability/confidence absolute error `<=1e-4`; require exact selected choices on every case. No automatic tolerance relaxation, accepted choice differences or exclusion of close ties. No score/noul/tournament equivalence requirement.
- [ ] Run graph validation and real PyTorch/Rust comparisons on the frozen three-choice set, plus an offline rerun. Exercise padding only as consumed by this single-request path; batching infrastructure is out of scope. Report every mismatch, maximum errors, decision margins, tested shapes, cold/warm timing and available memory measurements. Obtain independent review of the methodology/results; do not treat model agreement as decision accuracy.

**Acceptance:** both the minimal real smoke test and the frozen PT/EN three-choice set pass through the unchanged original model and Rust/ONNX; exact tokenization/masks/positions, logits/probabilities within unchanged tolerances, identical choices, faithful applicable calibration and no silent truncation. This demonstrates technical fidelity on tested inputs only; no accuracy or quality threshold is part of milestone 1. `noul`, `score`, tournaments and production infrastructure are not acceptance dependencies.

**Stop:** end as soon as acceptance is met or a real blocker is established. For a structural export incompatibility, stop immediately and report the exact operator/path, versions, minimal reproduction and exporter error; distinguish proven cause from hypothesis. For numerical/choice divergence, report the failing fixture/tensors and errors; do not waive acceptance. No repeated wrapper/workaround attempts, alternative implementation or Python fallback. Do not begin a further investigation or milestone automatically. Before milestone 2, obtain user approval of the report, supported envelope and memory budget based on measurements.

## Milestone 2 — Native Rust runtime and supervision

**Files planned:** promote/reuse the proven inference code into `crates/decision-runtime/` (`Cargo.toml`, `src/main.rs`, `src/inference.rs`, `src/protocol.rs`); add `apps/desktop/src/main/agent/harness/local-decision-runtime.ts` and its tests. Modify root Cargo membership and `apps/desktop/electron-builder.config.ts` only for this native component. Keep Pi SDK scheduling disconnected until milestone 3.

**Interface produced:** a host-owned bounded native process and validated `ready`, `observe`, `result`, `cancel`, `shutdown`, `unavailable` protocol, with version, request ID and generation. Host metadata binds run/session/workspace/context revision. Observation payload contains only the fixed three-choice context question. Reuse existing desktop spawn, disposal, logging and resource-path patterns, not the external plugin supervisor or a new global service registry.

- [ ] Write RED tests for missing/tampered artifacts, incompatible protocol, malformed/oversized frames, incomplete startup, single-flight creation, queue saturation, cancellation, exit and shutdown. Use synthetic transport fixtures for lifecycle failures.
- [ ] Promote the proven Rust inference/tokenizer/postprocessing instead of reimplementing it. Load the CPU provider and exact verified artifact bundle. Enforce frame/tensor/queue bounds before allocation and configure thread counts explicitly.
- [ ] Implement host supervision with generation-bound pending requests, deadlines, cancellation and bounded termination. Reject stale/duplicate responses and prevent automatic restart loops. A killed shared inference may make other observations unavailable but must never cancel their baseline tasks.
- [ ] Apply the memory budget approved after milestone 1; distinguish tensor/allocator bounds, actual measurements and any OS-enforced total process limit. If a required hard bound cannot be implemented on a platform, keep that platform unavailable rather than substitute monitoring.
- [ ] First target Linux x64 as the single development platform, using the environment recorded in milestone 1; claim it as supported only after real validation. Deliver its binary, CPU ONNX Runtime library, graph/external data, tokenizer/calibration, trusted digests and license notices. Verify library resolution and offline inference. Other platforms must not block this initial proof.
- [ ] Record progressive Windows x64 and macOS arm64/x64 bundle/signing validation as later separately authorized deliveries. Do not implement those adapters/packages in this first runtime milestone or claim support from cross-compilation.
- [ ] Run Rustfmt, Cargo check/test and relevant host TypeScript/Vitest/Biome checks. Repeat real equivalence against the actual runtime bundle. Request independent review of artifact loading, cancellation and concurrency.

**Acceptance:** real local inference through the native process on the single Linux x64 development target; bounded validated IPC/queue; lifecycle/error tests pass; its native bundle works offline without Python or remote fallback. Windows/macOS remain unavailable until their later validations and do not block initial acceptance. Mock transport success alone does not satisfy inference or packaging acceptance.

**Stop:** report native runtime, resource semantics and packaging evidence. No Pi SDK scheduling or activation. Await explicit authorization for milestone 3.

## Milestone 3 — Pi SDK observation-only integration

**Files planned:** modify `apps/desktop/src/main/agent/pi-sdk-runtime.ts`, existing Harness feature-flag definitions/validation, `apps/desktop/src/main/agent/runtime-registry.ts` and the existing application shutdown owner where needed. Extend productive Pi SDK, feature-flag and lifecycle tests; use the native runtime from milestone 2. No change to model selection, Meta Controller authority, safe-dispatch allowlist, QA gates or renderer UI.

**Interface produced:** `MODUS_DECISION_MODEL=false` by default, kernel-dependent; pre-prompt observation snapshots and validated diagnostic outcomes bound to the effective baseline decision, without passing THX candidates to the dispatcher.

- [ ] Write RED productive-path tests for flag off/on, missing native artifacts, unavailable inference and both valid/invalid configurations. Assert unchanged effective decision, prompt/model/provider and permissions; no extra tools or QA verdict.
- [ ] Implement explicit asynchronous initialization owned by the host lifecycle, independently of observation scheduling; observations must not be the only mechanism that could start the process they require. Schedule observations only at the existing pre-prompt boundary, without waiting for startup/inference. Keep the active Meta Controller operating. Minimize the state and reject over-budget serialization instead of silently summarizing/truncating.
- [ ] Add RED/GREEN cancellation/release/recreate/concurrent-session tests, including Agent Groups/subagents and changed context. Invalidate old results by host-owned identity and context revision. Verify clean shutdown and no baseline task cancellation.
- [ ] Use existing internal diagnostics only; record skipped/failed/completed observations distinctly. Never log raw prompts/context or present agreement as success. No dashboard or new user control.
- [ ] Exercise the productive Pi SDK path with offline fixtures and real native inference on a validated platform. Compare against the baseline on held-out PT/EN tasks using independently reviewed expected decisions; report disagreements and failures as well as cold/warm latency, queue effects and memory.
- [ ] Run relevant Vitest, Biome, Typecheck and safe CI, preserving regression coverage for model choice, real QA, Harness and lifecycle. Request independent review of non-blocking behavior, privacy and evidence attribution.

**Acceptance:** a real, correctly attributed native candidate is produced via the productive runtime when available; normal tasks continue when it is not; flags/lifecycle/regressions pass; no THX execution effects, remote context transmission or UI additions. Distinguish conversion equivalence, contextual-decision accuracy and final task outcome quality in the report.

**Stop:** deliver evidence and limitations. Do not enable retrieval, replanning or other effects, change defaults, select another model, or continue to a further milestone without new authorization.
