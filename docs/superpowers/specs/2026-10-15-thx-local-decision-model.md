# THX-01 native local Decision Intelligence — three gated milestones

Status: native Rust/ONNX architecture approved; Marco1.3 proved frozen24-case technical equivalence. The user explicitly authorized Marco2.1 (experimental native runtime/supervision); see `docs/architecture/thx01-native-runtime.md`. Marco2.2 (distribution) and Marco3 (PiSDK integration) remain unauthorized. Earlier export failures and their resolutions remain recorded in the milestone reports.

## Intent and scope

Add an internal local decision capability that can improve preparation of a task without adding UI. The user selected local inference, with no transmission of prompts or code to a remote decision service.

The work is separated into three milestones: ONNX feasibility/equivalence without Modus integration; a native Rust local runtime; and productive Pi SDK observation-only integration. Each milestone ends in a report and an explicit stop for user review before the next. The integrated component evaluates context sufficiency before a task starts, without changing execution strategy. Completion must distinguish real inference, synthetic tests, platform validation and unmeasured delivery quality.

The user-selected main model/provider, Verifier-First, permissions, existing Harness features and built-in agents remain authoritative. External plugin isolation and Guardian work are outside scope.

## Existing consumers

- `apps/desktop/src/main/agent/pi-sdk-runtime.ts`: `consultAdaptiveController`, pre-prompt boundary, run identity and release lifecycle.
- `apps/desktop/src/main/agent/harness/meta-controller.ts`: synchronous `decideNext` remains unchanged in authority and continues producing the effective decision.
- `apps/desktop/src/main/agent/harness/safe-dispatch.ts`: existing decisions continue through the existing dispatcher. A THX candidate is never passed to this dispatcher in any of these milestones.
- `apps/desktop/src/main/agent/runtime-registry.ts` and desktop shutdown: reuse the existing owner/disposal lifecycle rather than creating a second global orchestration registry.

Existing `advisory` mode is not observation-only: it permits some effects. Do not switch the existing active controller to shadow/advisory to evaluate THX.

## Local inference boundary

The preferred production architecture is one application-owned Rust subprocess using ONNX Runtime (`ort`) and a compatible Rust tokenizer, outside the Electron renderer and main execution thread. Use bounded newline-delimited JSON over private child stdio; no HTTP listener, cloud endpoint, arbitrary command supplied by a model, or plugin worker/supervisor reuse.

Use the checkpoint `doofz/THX-01` at revision `01262517979528a0103108ba473b78d6baeec016`, under Apache-2.0 with its required notices. Load from a local snapshot containing weights, encoder configuration and tokenizer. Resolve the packaged native binary, ONNX Runtime libraries, graph, any external tensor files, calibration and tokenizer artifacts from host-owned paths. Verify their digests against an application-trusted manifest before loading; reject traversal, unlisted external tensors and artifact changes. Never trust a manifest merely because it accompanies downloaded model files. Do not infer trust from an identity self-reported by the child.

Python/PyTorch is allowed only for development-time export, preparation and equivalence validation. No production Python executable, virtual environment, user-installed dependency, Python fallback or remote inference service is permitted. An unavailable native runtime means no THX observation; the existing Harness still operates.

Begin with CPU FP32. No quantization, GPU/MPS provider, attention simplification, distillation or replacement model is part of this conversion. Record exact export, runtime and tokenizer versions. Load only local verified files, without runtime downloads or remote code loading.

Static inspection confirms that the mmBERT encoder configuration uses ModernBERT with alternating full/sliding attention and rotary configuration. Its nominal position capacity does not override THX's 1,024-token input contract. ONNX exportability is unproven. The investigation must identify exporter/opset support for the actual operators, masks, rotary calculations, marker indexing, batching and decision head rather than treat this as generic BERT export.

On a proven structural export incompatibility, stop immediately and report the exact failing operator/path, environment, error and minimal reproduction. Do not enter repeated wrapper/workaround attempts or implement alternatives. A numerical/choice mismatch also prevents acceptance and must be reported without relaxing tolerances. Any later investigation of export repairs, Candle or a dedicated native implementation requires a new authorization; no production Python fallback.

## Equivalence gate — milestone 1

The required capability is only `choice` with exactly `context_sufficient`, `retrieve_local_context` and `insufficient_information`. Preserve the original mmBERT encoder, decision head, weights, tokenization and applicable three-choice temperature/clamp/masking/tie-breaking logic. Calibration/postprocessing may be in the graph or reproduced faithfully in Rust. Exporting only hidden states or replacing model components is insufficient. `noul`, `score` and tournaments above 24 choices may be inventoried, but their implementation, tests and equivalence are not milestone-1 acceptance criteria.

Validation is progressive: first one Portuguese and one English real export/inference smoke input through PyTorch and a minimal Rust/ONNX proof runner. Only if that works, freeze exactly 24 fixtures (12 Portuguese and 12 English) before final comparison in a three-choice equivalence set with difficult/ambiguous and close-tie cases, accents/Unicode, identifiers, option ordering and short/near-limit inputs. No initial 120-question requirement, generic test infrastructure or indefinite dataset expansion. Keep a separate untouched dataset for later contextual-quality assessment. Do not refit temperatures or tune the model.

Compare the original CPU FP32 model with ONNX CPU through a standalone Rust proof runner, with identical state, question and options. Require exact parity of serialized input IDs, attention masks, marker positions/masks and type IDs before numerical comparison. Outputs must include raw head logits and final calibrated three-choice distributions, selected choices and numeric confidence. Reject non-finite values.

Proposed numerical acceptance, fixed before running: raw outputs satisfy `abs(native - reference) <= 1e-4 + 1e-3 * abs(reference)`; each calibrated probability and numeric confidence differs by at most `1e-4`; selected choices match on every fixture. No choice difference is accepted. Use full-precision outputs before API rounding, and compare rounded API outputs separately. Near ties are reported and must not be excluded to obtain a pass. Changing tolerances requires explanation and user approval, not automatic relaxation.

Require a complete report of all fixtures, worst errors and decision mismatches, checkpoint/export digests, exact versions/opset, CPU, thread settings and actual measurements. A finite corpus establishes measured equivalence only on that corpus, not a mathematical guarantee for all inputs or task quality. Keep all inference offline after explicit artifact preparation.

A successful graph load, two-input smoke test or ONNX checker result alone is not this gate. Acceptance requires the subsequent fixed equivalence set too. This is technical fidelity, not contextual-decision accuracy, which is evaluated separately. Stop at acceptance or a proven real blocker and deliver the feasibility report. No Modus process lifecycle, IPC integration, feature flag or packaging changes belong to milestone 1.

## Decision contract

Question: does the supplied task context contain enough information to begin the requested work?

Allow exactly three choices:

- `context_sufficient`: the supplied context supports starting the requested task.
- `retrieve_local_context`: additional authorized local project information is needed.
- `insufficient_information`: the available state does not support a reliable decision.

This is a contextual judgment, not a permission, risk, QA or completion verdict. No choice changes tools, models, providers, task status, verification requirements or dispatch in any of the three milestones.

The host builds a minimal state from the prompt and already available context facts. Do not collect additional files merely to feed the decision model. Treat all supplied text as untrusted task data. Do not send full transcripts, secrets, raw tool output, or unrelated session content. The exact tokenizer must account for question, choices, separators and state within 1,024 tokens. Reject over-budget input explicitly instead of accepting silent truncation or introducing a summarization model.

The private protocol carries a version, request ID, operation and bounded payload. Host-side request metadata binds the candidate to session, run, runtime-instance generation and relevant context revision. The child returns the request ID, selected choice and probabilities. Host validation rejects unknown choices, malformed/non-finite probabilities, invalid totals, oversized frames, unsolicited/duplicate responses and checkpoint mismatch.

Keep upstream numeric confidence separate from existing `AdaptiveDecision.confidence`. For choice responses upstream confidence is entropy-derived and is not a probability of correctness. No arbitrary confidence threshold enables effects.

## Native lifecycle (milestone 2) and productive wiring (milestone 3)

Introduce an internal `MODUS_DECISION_MODEL` feature flag, false by default and dependent on the existing kernel flag. Do not add a Settings control or dashboard.

Milestone 3 requires explicit asynchronous initialization owned by the host lifecycle, independent of observation scheduling and without blocking prompts. Do not create a circular dependency where an observation requires a ready process but only an observation could initialize it.

At the productive pre-prompt boundary, snapshot the required input and schedule an observation only when enabled and the local process is ready. The baseline Meta Controller and prompt must not wait for model loading or inference. Skip an unavailable observation explicitly; do not label it as inferred.

Use one active inference and at most four waiting observations across the application. Reject excess observations as unavailable rather than grow an unbounded queue. Initial operational bounds: request frames at most 64 KiB, response frames at most 16 KiB, startup at most 60 seconds and an in-flight inference at most 5 seconds. These are containment bounds for the experiment, not promised latency targets or kernel-enforced quotas.

Host-owned request tracking must reject late results after cancellation, release, run replacement or changed context. Remove queued requests for released/cancelled runs. A hung native inference is stopped by terminating its process, invalidating its pending results, and allowing a later explicit demand to initialize a fresh generation. No immediate retry loop. Termination of shared inference may mark other pending observations unavailable; it must never cancel their baseline tasks.

Start with ONNX Runtime CPU only, one inter-op thread and two intra-op threads, one session and a fixed supported input shape envelope. Reject inputs above 1,024 tokens before tensor allocation; bound frame size, queue and output size. Measure model loading, steady-state and peak memory. Use milestone-1 measurements to propose the total-memory budget at the milestone-2 authorization gate; ONNX arena settings or an RSS watchdog must not be called a hard process-memory limit. If a required hard limit lacks an implemented OS mechanism, declare it unavailable and keep that platform disabled.

Make startup single-flight. Handle startup failure, malformed protocol, unexpected exit and shutdown explicitly. Shutdown rejects new observations, settles pending requests and waits for child exit with a bounded termination escalation. Readiness requires loaded local artifacts and protocol compatibility, not merely an open process.

No raw prompt, state, probability explanation or inference content goes into logs or public reports. Use existing internal diagnostic mechanisms for counts, outcome category, checkpoint identity, duration and baseline/candidate comparison. Do not present agreement as improved quality or failure as a successful inference.

## Validation and acceptance — milestones 2 and 3

1. RED/GREEN tests for productive Pi SDK scheduling with the flag on/off, while effective baseline dispatch and selected model remain unchanged.
2. Synthetic transport/lifecycle tests cover single-flight startup, bounded queue, malformed data, missing artifacts, timeouts, exit, cancellation, shutdown and late responses across concurrent sessions, recreated sessions, Agent Groups and subagents.
3. Real local inference uses only synthetic Portuguese/English fixtures, the pinned snapshot and recorded runtime versions. It must show an actual validated response; mocks cannot satisfy this criterion. Re-run with networking disabled to check offline operation.
4. Token-limit tests reject oversized input without inference or silent truncation.
5. Compare against the existing context-decision baseline on reviewed fixtures. Separate calibration/development examples from held-out evaluation. Include ambiguous requests and context omitted from the input. Report errors and abstentions, not merely confidence or agreement.
6. Measure startup and warm inference latency, available process-memory measurements and device identity. Identify measurement limitations. Author-reported GPU latency is not a Modus measurement.
7. Run relevant Vitest, Biome and TypeScript checks, retaining the existing safe CI filters. No plugin, confinement or adversarial probes.
8. Report development integration, offline inference, packaging readiness and delivery-quality evidence separately. No active THX effects or claim of improved final task outcomes in these milestones.

## Follow-ups and non-goals

Milestone 2 prioritizes one development target, Linux x64, and validates its native executable, ONNX Runtime CPU library, graph/external data, tokenizer/calibration, trusted manifest, licenses, library resolution and offline inference. Its success does not require delivering all desktop packages. Windows x64 and macOS arm64/x64 packaging/signing are progressive, separately authorized follow-ups; they remain unavailable until individually validated. Linux libc compatibility and later macOS signing/notarization are explicit checks. No platform is supported merely because it cross-compiles, and no Python or plugin fallback is allowed.

Stop after milestone 2's runtime and packaging report, before touching Pi SDK behavior. Stop after milestone 3's observation/quality report, before enabling decision effects. Independent review is required for equivalence and lifecycle/concurrency evidence; no model may certify its own correctness.
Enabling even the context-retrieval effect requires held-out evidence and a separately reviewed policy change through the existing controller/dispatcher. Replanning and specialist selection follow later, independently. No new UI, provider switching, QA approvals, automated learning, external plugins, model substitution, or network inference.

## Sources reviewed

- https://huggingface.co/doofz/THX-01
- https://huggingface.co/doofz/THX-01/blob/01262517979528a0103108ba473b78d6baeec016/thx01/agent.py
- https://huggingface.co/doofz/THX-01/blob/01262517979528a0103108ba473b78d6baeec016/thx01/common.py
- https://huggingface.co/doofz/THX-01/blob/01262517979528a0103108ba473b78d6baeec016/pyproject.toml

Additional configuration source: https://huggingface.co/doofz/THX-01/blob/01262517979528a0103108ba473b78d6baeec016/encoder/config.json
