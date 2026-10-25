# THX-01 shadow source inventory

- Inspection date: 2026-10-25
- Current checkout: `feat/modus-maturity-remediation`
- Inspected source ref: `origin/feat/thx-local-decision-model` at
  `1fab3d6628fb7db80929ce22d3d4be5054d9a23a`
- Current `origin/main` at inspection: `fd74a37b74f121f5cf6fb59c15aa009d3b6c4f66`

## Source located

The native THX implementation exists on the inspected feature ref; it is not in
the current checkout or `origin/main`. It was inspected with `git show` and
`git grep`; neither branch was checked out, and no model weights were downloaded.

Relevant source paths on the feature ref:

- `crates/decision-runtime/src/{main,service,protocol,artifacts,inference}.rs`
- `crates/decision-runtime/artifact-trust-root.json`
- `apps/desktop/src/main/agent/decision/{decision-runtime,artifact-trust,native-trust-root}.ts`
- `apps/desktop/src/main/agent/decision/{decision-runtime,artifact-trust}.test.ts`
- `scripts/thx01/equivalence/` and `scripts/thx01/`
- `docs/architecture/thx01-native-runtime.md`
- `docs/architecture/thx01-native-artifact-trust.md`
- `docs/architecture/evidence/thx01-m13/` and `docs/architecture/evidence/thx01-m22a/`

The TypeScript boundary defines the three required labels:
`context_sufficient`, `retrieve_local_context`, and
`insufficient_information`. Its request/result schemas carry a request ID,
generation, logits, probabilities, confidence, token count, and elapsed time.
`DecisionRuntime.initialize()` is asynchronous and its supervisor constrains
the protocol, queue, and inference deadline. The Rust executable is the ONNX
inference service; there is no Python inference fallback in that runtime.

The Rust trust root pins the model checkpoint, graph, external data, tokenizer,
tokenizer configuration, calibration, and ONNX Runtime library. The documented
external-data digest corresponds to a 1,287,651,328-byte file. The app trust
root pins the experimental executable and deb path independently from its
locator.

## Integration and execution gaps

The feature ref contains no `DecisionShadow` implementation and no call from
`PiSdkRuntime`, `pre_prompt`, the Harness Kernel, or Meta Controller into
`DecisionRuntime`. The branch's search results for those call sites contain
only the service implementation and its tests. The runtime is therefore not
observing real Harness snapshots on that ref.

The secure desktop bootstrap also denies execution. On Linux x64,
`artifact-trust.ts:openTrustedExecutable()` ends with
`decision_runtime:artifact_bootstrap_immutability_unproven`; it rejects both
deb and AppImage launch modes. The failure is intentional and has no
configuration bypass. The native inference evidence in the Marco 2.2a report
is development-example evidence, not evidence that the desktop supervisor can
launch the model. The final 2.2a report records six targeted direct-native
comparisons after authenticated source substitution, not a new 24-case Harness
run. Historical 24-fixture equivalence remains separate from this task's
decision-quality evaluation.

Consequently, no neural observation can currently be produced through the
production `DecisionRuntime` boundary in the Modus app. Reconstructing or
copying the service into this branch would not remove the independent bootstrap
blocker and would falsely suggest an integration was executable.

## Candidate integration paths for a supplemental plan

No integration code was added. Any next proposal should name these real
consumers and preserve their existing behavior:

1. `apps/desktop/src/main/agent/pi-sdk-runtime.ts`: the existing
   `before_agent_start`/`pre_prompt` turn boundary can assemble a typed,
   run-scoped snapshot. Initialization must be asynchronous and observations
   must not delay prompt delivery.
2. `apps/desktop/src/main/agent/harness/meta-controller.ts`: this owns the
   effective `AdaptiveDecisionSnapshot` decision path. THX output must be
   recorded beside the deterministic result, never passed back into
   `decideNext` or used to choose a model, tool, permission, or retry.
3. `apps/desktop/src/main/agent/harness/observability/`: existing run IDs and
   observation lifecycle are the likely correlation boundary. Results must be
   invalidated on session/run replacement and reconciled only with an
   independent outcome for the same run.
4. A new shadow observer contract would still need a separately reviewed
   spec: bounded inputs/outputs, explicit readiness, cancellation, stale-result
   rejection, retention, and no prompt/code persistence. This inventory does
   not define that API.

Before a port, the supplemental plan must first resolve the development-only
loader needed for a real local inference without changing the secure loader or
the official build. It must then identify exactly which verified source paths
are ported and how 24-fixture equivalence remains separate from contextual
decision-quality measurements.

## Decision

**GO — source inventory only.** The experimental native implementation and its
evidence are locatable and attributable to a specific revision.

**HOLD — Harness observation.** There is no DecisionShadow consumer and the
supervisor cannot launch the model. No THX code was integrated by this plan.

**HOLD — cognitive quality.** No chosen provider/model was authorized for a
live quality run, and no real Harness snapshot was evaluated by the native
model. The local evaluation fixtures added by this plan validate only the
Harness's existing repair and recall contracts.
