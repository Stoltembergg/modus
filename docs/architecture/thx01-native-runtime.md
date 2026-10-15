# THX-01 Marco 2.1 — Experimental native runtime

**GO for the explicitly scoped experimental Linux x64 runtime. NOT distributed, enabled or integrated into Pi SDK. Stop before Marco2.2/3.**

## Delivered architecture

- `crates/decision-runtime/` is a root Rust-workspace member. `inference.rs` promotes the Marco1.3 tokenizer, input assembly, tensors, inference and calibrated postprocessing; the independent equivalence runner now consumes that shared library instead of maintaining a second implementation. No conversion, checkpoint or calibration change.
- `protocol.rs`: strict version1 JSON-lines private stdio, host-generated process generation and request IDs, `observe`, `cancel`, `shutdown`; `ready`, `started`, `result`, `error`, `cancelled`, `stopped`. UTF-8 validation, unknown-field rejection and bounded reading before buffer growth. Requests64KiB, responses16KiB, excluding the LF delimiter.
- `service.rs`: one model-owning inference thread, at most four waiting native jobs, cancellable ORT RunOptions and a five-second cooperative watchdog. It does not spawn executables or load plugin code. The host separately enforces the five-second active-request deadline with process termination; cooperative termination alone is not claimed as hard enforcement.
- `decision-runtime.ts`: inert constructor and explicit async `initialize()`, startup single-flight, approved60s startup ceiling including verification, one active/four waiting observations, private piped stdio, schema/numerical/identity validation, bounded frames, cancellation with the active slot retained until a terminal response, no automatic restarts. A failure invalidates pending observations; explicit reinitialization requires the previous process to have exited. Shutdown waits for close, escalates TERM/KILL and rejects unconfirmed cleanup.
- `main/index.ts` adds only the shutdown drain. No app startup, PiSDK, MetaController, model-provider, feature flag, GUI or installer changes. `configureDecisionRuntime()` creates an inert internal owner; no production caller configures or starts it in this milestone.

The current PiSDK/Harness remains authoritative and unchanged. This component is not a plugin worker and does not use or alter Guardian infrastructure.

## Assets, privacy and resource policy

Original snapshot revision `01262517979528a0103108ba473b78d6baeec016`. Same approved ONNX graph `13a870e7211257b3a6eb93696ec25f8ff91488638bc308a6738957edf9024a58` and external data `8e5c1f58aa060e9279ebd07d27f3cc160dd0cc1ee7a9407819ac54c200e58f5c`; matching tokenizer/configuration/calibration. Runtime ONNX Runtime1.22.0 CPU library was copied byte-for-byte to a development directory outside the Python venv, with its previously verified digest. The runtime manifest lists only six required native/model files: no Python modules or original PyTorch weights are required.

The host pins executable and manifest digests; Rust validates the manifest against that host digest and requires all loaded graph/data/tokenizer/calibration/library dependencies to be listed and verified before use. The graph/data are also pinned to the approved export in the loader. Request messages cannot supply executable paths, assets or commands. Development-smoke trust is provided by the approved local artifact inventory, not by a manifest downloaded alongside unknown artifacts.

**Distribution remains unavailable.** The experimental loader verifies hashes then reopens file paths; it does not defend against a concurrent same-UID writer replacing assets between those operations. Before distribution, require protected host-owned immutable artifact storage, native-library identity and a pinned application trust chain. No claim that this is a complete distribution security boundary.

CPU FP32, two intra-op/one inter-op threads; four total native threads were observed during an active request (including reader/model owner/watchdog). Tokenization precedes ORT tensor allocation. Inputs outside the proved65–1024-token envelope or requiring truncation are unavailable; no silent truncation or artificial padding. Masks/options/temperature remain unchanged. API outputs contain numerical decisions, token counts, durations and native VmHWM only; diagnostics never contain prompts, source, raw context, explanations or internal exception messages.

**Proposed planning budget:1280MiB native memory**, based on the previously measured845.90MiB peak plus headroom. No OS memory cap has been implemented or claimed. VmHWM/sampling are measurements, not enforcement. Distribution must remain unavailable if its eventual mandatory resource policy cannot be enforced. Startup remains the approved60s maximum; **inference remains5s**, unchanged.

## Verification and measured behavior

- Rust:12 tests passed (6 preserved numerical/artifact guards,6 protocol/manifest/frame checks); Cargo check/build and scoped Rustfmt passed.
- Vitest:25 tests passed (22 supervisor scenarios +3 existing runtime-registry cases); TypeScript check passed; targeted Biome passed.
- RED evidence: missing new Rust protocol and missing new TS supervisor produced initial failures, followed by passing implemented suites. Tests retain their assertions; no test limits or global settings were weakened.
- Shared-core regression: actual offline Rust/ONNX vs original PyTorch passed24/24 frozen fixtures, exact five input tensors, identical choices; maximum choice-logit error3.24249e-5, probability1.78814e-6, confidence1.96684e-6. Fixtures and approved model artifacts retain their digests. This is technical fidelity, not quality evaluation.
- Real Node supervisor -> actual Rust subprocess -> actual local ORT inference passed PT/EN and both1024-token fixtures. Also demonstrated one-active/four-waiting admission, queue overflow rejection, token overflow rejection, queued/active cancellation, same-process reuse after cancellation and confirmed shutdown. A synthetic incorrect graph digest was rejected by the real executable before ready (`artifact_load`, exit1, stdout empty); original model files were untouched.

Final real supervised run (single forwards, with strace overhead; choices match the original PyTorch reference):

| Fixture | Tokens | Native inference ms | Max Δ logits | Max Δ probability | Choice |
| --- | ---: | ---: | ---: | ---: | --- |
| equiv-pt-01 | 89 | 188.86 | 7.629e-06 | 2.682e-07 | context_sufficient |
| equiv-en-01 | 86 | 145.35 | 2.265e-06 | 1.788e-07 | context_sufficient |
| equiv-pt-11 | 1024 | 4050.66 | 1.764e-05 | 5.290e-07 | insufficient_information |
| equiv-en-11 | 1024 | 2713.74 | 1.431e-05 | 1.013e-06 | context_sufficient |

- Final host initialization → ready: **6336.80ms** (includes host/native hashes, tokenizer and model initialization). No hidden model warmup was added; the first PT inference is the first request.
- Final sampled native peak: **854748KiB = 834.71MiB**, separate from Node/Python. Successful responses also report their own VmHWM. Sampling every50ms may miss a final peak before forced exit.
- Final confirmed shutdown: **169.52ms**.
- Hardware: Linux x64, kernel6.18.44, virtualized Xeon Platinum8370C,3 exposed CPUs. Rust1.99.1, ort2.0.0-rc.10, ORT1.22.0, tokenizers0.22.2, Node24.19.0. No Windows/macOS support claim.

**Preserved failure evidence:** the first real run completed PT/EN but its PT1024 case reached **5001.89ms** and was made unavailable by the unchanged5s host deadline, followed by confirmed process exit. A TypeScript check was running concurrently in that initial experiment, but this does not establish causation. The later directed run passed both1024 cases at3006.01/2809.74ms; final run results are above. No claim of constant latency, exclusively environmental failure or guaranteed1024-token availability. The harness was extended to continue independent checks after an explicitly requested/confirmed test-only recreation; the production supervisor has no retry loop. An intermediate development memory-sampling helper encountered unavailable `/proc/.../children`; it was corrected to sample only the actual host-owned child PID. It did not alter inference/model behavior.

All actual native runs used process-local socket denial with `strace -f -e trace=network -e inject=socket:error=ENETDOWN`. Traces contain no network syscalls. Cargo dependency retrieval/build preceded inference; the runtime loads a local shared library directly and does not start/import Python. Python reference/export tools remain development-only. No global CI, packaging, plugin, Guardian, enforcement or adversarial workloads were run.

## Reproduction

From the repository root, with the approved local artifacts already present:

```bash
CARGO_TARGET_DIR=/workspace/scratch/thx01-m13/target ~/.cargo/bin/cargo build --release --locked -p modus-decision-runtime -j 2
CARGO_TARGET_DIR=/workspace/scratch/thx01-m13/target ~/.cargo/bin/cargo test --release --locked -p modus-decision-runtime -j 2
CARGO_TARGET_DIR=/workspace/scratch/thx01-m13/target ~/.cargo/bin/cargo check --release --locked -p modus-decision-runtime -j 2
~/.cargo/bin/cargo fmt -p modus-decision-runtime -- --check
npx vitest run apps/desktop/src/main/agent/decision/decision-runtime.test.ts apps/desktop/src/main/agent/runtime-registry.test.ts
npm run typecheck --workspace @modus/desktop
strace -f -e trace=network -e inject=socket:error=ENETDOWN -o /tmp/thx-network.trace node scripts/thx01/runtime_smoke.ts /workspace/scratch/thx01-m13/target/release/modus-decision-runtime /workspace/scratch/thx01-m21/runtime-manifest.json /workspace/modus-pr191/scripts/thx01/equivalence/fixtures.json /workspace/scratch/thx01-m13/reference.json /tmp/thx-runtime-results.json
```

The committed manifest records all six files/digests. To reconstruct it on another development machine, locate byte-identical approved assets, update only local paths, verify every recorded digest, then establish the new manifest digest in the trusted development host configuration. Do not derive production trust from that local editing process. The smoke harness is a development host, not a production trust-anchor implementation.

Raw JSON evidence is archived losslessly as `.json.gz` to preserve original bytes/hashes and keep generated arrays out of source formatting. `gzip -dc docs/architecture/evidence/thx01-m21/supervised-final.json.gz` reads the final report. No Biome rule or global exclusion was changed. Large ONNX files, native libraries and build outputs remain outside Git.

## Review, limitations and next gate

One independent read-only review found **no concrete blocker for experimental2.1**; see [review](evidence/thx01-m21/independent-review.md). Its storage/TOCTOU, resource and timing limitations are recorded above. Rust service lifecycle coverage comes from actual supervised execution and TS tests, not dedicated isolated unit tests of every service-thread interleaving. The24-case set still has no retrieval-as-winner fixture; decision quality remains unevaluated.

Marco2.2 prerequisites, only after new authorization:
1. Approve a Linux artifact/trust-chain/immutable-storage design, ORT ABI/libc targets and required license notices; do not ship developer manifests/paths.
2. Define and implement any mandatory resource enforcement before distribution; retain explicit unavailability on5s timeout. The memory proposal above requires a policy decision, not a hidden RSS-monitoring substitution.
3. Validate actual Linux package installation, asset resolution, offline execution and cleanup independently. Windows/macOS and PiSDK integration remain separate unauthorized milestones.

**Stop after2.1. No AppImage/deb packaging, feature activation, PiSDK/MetaController integration or next milestone was started.**
