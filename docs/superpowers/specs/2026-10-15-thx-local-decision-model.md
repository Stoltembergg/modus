# THX-01 local decision integration — first milestone

Status: specification for user review; implementation has not started.

## Intent and scope

Add an internal local decision capability that can improve preparation of a task without adding UI. The user selected local inference, with no transmission of prompts or code to a remote decision service.

The first milestone is a real, bounded THX-01 inference path connected to the productive Pi SDK runtime in observation-only mode. It evaluates whether the supplied context is sufficient before a task starts. It does not change execution strategy yet. Completion must distinguish real inference, simulated transport tests, and unmeasured delivery quality.

The user-selected main model/provider, Verifier-First, permissions, existing Harness features and built-in agents remain authoritative. External plugin isolation and Guardian work are outside scope.

## Existing consumers

- `apps/desktop/src/main/agent/pi-sdk-runtime.ts`: `consultAdaptiveController`, pre-prompt boundary, run identity and release lifecycle.
- `apps/desktop/src/main/agent/harness/meta-controller.ts`: synchronous `decideNext` remains unchanged in authority and continues producing the effective decision.
- `apps/desktop/src/main/agent/harness/safe-dispatch.ts`: existing decisions continue through the existing dispatcher. A THX candidate is never passed to this dispatcher in this milestone.
- `apps/desktop/src/main/agent/runtime-registry.ts` and desktop shutdown: reuse the existing owner/disposal lifecycle rather than creating a second global orchestration registry.

Existing `advisory` mode is not observation-only: it permits some effects. Do not switch the existing active controller to shadow/advisory to evaluate THX.

## Local inference boundary

Use one application-owned Python subprocess with THX-01/PyTorch, outside the Electron renderer and main execution thread. Use bounded newline-delimited JSON over private child stdio; no HTTP listener, cloud endpoint, arbitrary command supplied by a model, or plugin worker/supervisor reuse.

Use the checkpoint `doofz/THX-01` at revision `01262517979528a0103108ba473b78d6baeec016`, under Apache-2.0 with its required notices. Load from a local snapshot containing weights, encoder configuration and tokenizer. Resolve the packaged script and artifacts from host-owned paths. Do not infer trust from an identity self-reported by the child.

For the initial runnable development path, prepare a dedicated Python environment and pinned snapshot explicitly with a setup command; inference never installs dependencies or downloads files. Record the resolved dependency versions and artifact digests used for validation. Set offline loading, reject incomplete snapshots, and prevent the upstream tokenizer fallback from fetching missing assets. No runtime `trust_remote_code` loading.

Begin with CPU inference to establish a reproducible reference path. GPU/MPS acceleration, quantization, ONNX and universal desktop packaging are separate follow-ups, not assumed capabilities. The implementation must report its actual device internally without logging user content.

A development-only installation is not a distributed desktop feature. Production packages must leave the feature unavailable until a supported, verified runtime/artifact bundle exists for that platform. Do not require the user's machine to have arbitrary Python on PATH or silently download a runtime on prompt submission.

## Decision contract

Question: does the supplied task context contain enough information to begin the requested work?

Allow exactly three choices:

- `context_sufficient`: the supplied context supports starting the requested task.
- `retrieve_local_context`: additional authorized local project information is needed.
- `insufficient_information`: the available state does not support a reliable decision.

This is a contextual judgment, not a permission, risk, QA or completion verdict. No choice changes tools, models, providers, task status, verification requirements or dispatch in this milestone.

The host builds a minimal state from the prompt and already available context facts. Do not collect additional files merely to feed the decision model. Treat all supplied text as untrusted task data. Do not send full transcripts, secrets, raw tool output, or unrelated session content. The exact tokenizer must account for question, choices, separators and state within 1,024 tokens. Reject over-budget input explicitly instead of accepting silent truncation or introducing a summarization model.

The private protocol carries a version, request ID, operation and bounded payload. Host-side request metadata binds the candidate to session, run, runtime-instance generation and relevant context revision. The child returns the request ID, selected choice and probabilities. Host validation rejects unknown choices, malformed/non-finite probabilities, invalid totals, oversized frames, unsolicited/duplicate responses and checkpoint mismatch.

Keep upstream numeric confidence separate from existing `AdaptiveDecision.confidence`. For choice responses upstream confidence is entropy-derived and is not a probability of correctness. No arbitrary confidence threshold enables effects.

## Productive wiring and lifecycle

Introduce an internal `MODUS_DECISION_MODEL` feature flag, false by default and dependent on the existing kernel flag. Do not add a Settings control or dashboard.

At the productive pre-prompt boundary, snapshot the required input and schedule an observation only when enabled and the local process is ready. The baseline Meta Controller and prompt must not wait for model loading or inference. Skip an unavailable observation explicitly; do not label it as inferred.

Use one active inference and at most four waiting observations across the application. Reject excess observations as unavailable rather than grow an unbounded queue. Initial operational bounds: request frames at most 64 KiB, response frames at most 16 KiB, startup at most 60 seconds and an in-flight inference at most 5 seconds. These are containment bounds for the experiment, not promised latency targets or kernel-enforced quotas.

Host-owned request tracking must reject late results after cancellation, release, run replacement or changed context. Remove queued requests for released/cancelled runs. A hung Python inference is stopped by terminating its process, invalidating its pending results, and allowing a later explicit demand to initialize a fresh generation. No immediate retry loop. Termination of shared inference may mark other pending observations unavailable; it must never cancel their baseline tasks.

Make startup single-flight. Handle startup failure, malformed protocol, unexpected exit and shutdown explicitly. Shutdown rejects new observations, settles pending requests and waits for child exit with a bounded termination escalation. Readiness requires loaded local artifacts and protocol compatibility, not merely an open process.

No raw prompt, state, probability explanation or inference content goes into logs or public reports. Use existing internal diagnostic mechanisms for counts, outcome category, checkpoint identity, duration and baseline/candidate comparison. Do not present agreement as improved quality or failure as a successful inference.

## Validation and acceptance

1. RED/GREEN tests for productive Pi SDK scheduling with the flag on/off, while effective baseline dispatch and selected model remain unchanged.
2. Synthetic transport/lifecycle tests cover single-flight startup, bounded queue, malformed data, missing artifacts, timeouts, exit, cancellation, shutdown and late responses across concurrent sessions, recreated sessions, Agent Groups and subagents.
3. Real local inference uses only synthetic Portuguese/English fixtures, the pinned snapshot and recorded runtime versions. It must show an actual validated response; mocks cannot satisfy this criterion. Re-run with networking disabled to check offline operation.
4. Token-limit tests reject oversized input without inference or silent truncation.
5. Compare against the existing context-decision baseline on reviewed fixtures. Separate calibration/development examples from held-out evaluation. Include ambiguous requests and context omitted from the input. Report errors and abstentions, not merely confidence or agreement.
6. Measure startup and warm inference latency, available process-memory measurements and device identity. Identify measurement limitations. Author-reported GPU latency is not a Modus measurement.
7. Run relevant Vitest, Biome and TypeScript checks, retaining the existing safe CI filters. No plugin, confinement or adversarial probes.
8. Report development integration, offline inference, packaging readiness and delivery-quality evidence separately. No active THX effects or claim of improved final task outcomes in this milestone.

## Follow-ups and non-goals

A later decision must define supported desktop bundles, platform-specific installation/signing and memory/latency acceptance using measured evidence. The first milestone does not ship a universal Python/PyTorch installer.

Enabling even the context-retrieval effect requires held-out evidence and a separately reviewed policy change through the existing controller/dispatcher. Replanning and specialist selection follow later, independently. No new UI, provider switching, QA approvals, automated learning, external plugins, model substitution, or network inference.

## Sources reviewed

- https://huggingface.co/doofz/THX-01
- https://huggingface.co/doofz/THX-01/blob/01262517979528a0103108ba473b78d6baeec016/thx01/agent.py
- https://huggingface.co/doofz/THX-01/blob/01262517979528a0103108ba473b78d6baeec016/thx01/common.py
- https://huggingface.co/doofz/THX-01/blob/01262517979528a0103108ba473b78d6baeec016/pyproject.toml
