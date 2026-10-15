# THX-01 Marco 1.3 — Rust/PyTorch equivalence

**Decision: GO for requesting authorization for Marco 2; Marco 2 remains unauthorized and was not started.** Linux x64 CPU technical fidelity passed on the frozen set. This is not a classification-quality evaluation or production-runtime approval.

## Scope and provenance

No ONNX re-export, model substitution, calibration changes, production integration, workspace membership, feature flags, packaging or global CI. The existing work from Marcos 1–1.2 was preserved. No commits or remote publication were requested or performed in this milestone.

Original checkpoint: `doofz/THX-01@01262517979528a0103108ba473b78d6baeec016`. Exactly the Marco 1.2 dynamic graph and external weights were reused:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| thx01-choice3-dynamic.onnx | 2482868 | `13a870e7211257b3a6eb93696ec25f8ff91488638bc308a6738957edf9024a58` |
| thx01-choice3-dynamic.onnx.data | 1287651328 | `8e5c1f58aa060e9279ebd07d27f3cc160dd0cc1ee7a9407819ac54c200e58f5c` |
| fixtures.json | see manifest | `88cae7fb314e6367cab697a677680616002788fb4eb462f9ff326ede6e8a9810` |

The manifest also records the 20 original snapshot files (including tokenizer, configuration, Python reference source and weights), shared ORT library and their size/digests. Rust verified the listed artifacts before and after inference. The manifest is a trusted development input, not a production authorization/signature scheme. Large artifacts remain outside Git in the approved scratch directories; the report does not create new model copies.

## Fixed methodology

`freeze_fixtures.py` fixed 12 PT and 12 EN fixtures before reference/native results were available. Four deterministic option orders; ambiguous requests; Unicode/emoji/combining characters; literal special-token handling; whitespace; lengths 82–1024; two 1024-token sequences; two cases with seven explicitly masked pad tokens. Near-limit filler was selected solely by token count, never predictions. These 24 cases are technical-equivalence data; future decision-quality evaluation must use an independent holdout, which was not consumed here.

The original pinned `Agent`, `build_sequence`, `collate_items`, decision model and `_decode` supplied PyTorch FP32 reference results. Rust independently loaded the original tokenizer JSON using the matching tokenizer version, disabled implicit truncation/padding, assembled the question/options/state and checked all five input tensors exactly before starting ORT inference: `input_ids`, `attention_mask`, `marker_pos`, `marker_mask`, `qtype` (choice = 0). Option order and first-maximum tie behavior were preserved. Requested head/option truncation and total lengths outside 65–1024 are rejected; no automatic padding or silent truncation was introduced. Explicit fixture padding is compared to the original reference, not assumed equivalent.

Rust applies the original `choice:3-5` temperature **2.55**, stable float32 softmax and normalized entropy confidence `1 − H(p)/ln(3)`. Confidence is not empirical accuracy. Comparisons use unrounded values; original API answers rounded to four decimals are retained in the reference. The standalone runner reports raw numeric values rather than serving the production API. The auxiliary action-head logits are also compared; no action is taken.

## Results — actual CPU inference

**24/24 exact input tensors; 24/24 identical choices; 0 non-finite outputs; 0 tolerance failures.**

- Choice logits maximum absolute error: **3.24249267578125e-5**. Every element satisfied `abs(actual-reference) <= 1e-4 + 1e-3*abs(reference)`; largest tolerance utilization **0.00954989**.
- Probabilities maximum absolute error: **1.7881393432617188e-6**, below `1e-4`.
- Confidence maximum absolute error: **1.9668425967900305e-6**, below `1e-4`.
- Auxiliary action logits maximum absolute error: **0.0010986328125**, within the same absolute-plus-relative bound (large-magnitude action logits). This is not a probability error.
- Five reference top-two probability margins below the pre-fixed 0.10 threshold: PT-05 0.045663; PT-08 0.026825; EN-05 0.053461; EN-08 0.086120; EN-12 0.052012. All choices matched. None was added/removed after scoring.
- Winner coverage: 10 `context_sufficient`, 14 `insufficient_information`, **0 `retrieve_local_context`**. All three option positions/probabilities are compared in every fixture, but retrieval-as-winner is not demonstrated. The fixed corpus was not changed to force coverage.

In the table, sufficient/insufficient abbreviate the full choice keys. Each listed choice is identical in PyTorch and Rust; full tensors, logits, probabilities, confidence, margins and errors are in the JSON evidence.

| Fixture | Tokens | Pad | Choice, both | Max Δ logits | Max Δ probability | Δ confidence | Native ms |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| equiv-pt-01 | 89 | 0 | sufficient | 7.629e-06 | 2.682e-07 | 3.326e-07 | 167.51 |
| equiv-pt-02 | 89 | 0 | insufficient | 1.764e-05 | 7.153e-07 | 1.967e-06 | 168.98 |
| equiv-pt-03 | 82 | 0 | sufficient | 1.192e-05 | 3.576e-07 | 6.975e-07 | 186.97 |
| equiv-pt-04 | 84 | 0 | insufficient | 7.629e-06 | 1.416e-07 | 5.023e-07 | 196.95 |
| equiv-pt-05 | 100 | 0 | sufficient | 1.621e-05 | 5.364e-07 | 5.820e-07 | 347.52 |
| equiv-pt-06 | 92 | 0 | insufficient | 7.868e-06 | 1.192e-07 | 2.135e-07 | 475.80 |
| equiv-pt-07 | 85 | 0 | insufficient | 1.025e-05 | 1.118e-06 | 9.732e-07 | 297.38 |
| equiv-pt-08 | 90 | 0 | sufficient | 4.768e-06 | 6.258e-07 | 4.226e-08 | 318.85 |
| equiv-pt-09 | 90 | 0 | insufficient | 4.411e-06 | 1.937e-07 | 1.147e-07 | 288.75 |
| equiv-pt-10 | 96 | 0 | insufficient | 9.537e-06 | 2.086e-07 | 5.434e-07 | 410.28 |
| equiv-pt-11 | 1024 | 0 | insufficient | 1.764e-05 | 5.290e-07 | 5.407e-07 | 4885.37 |
| equiv-pt-12 | 95 | 7 | sufficient | 3.242e-05 | 1.788e-06 | 1.930e-06 | 264.39 |
| equiv-en-01 | 86 | 0 | sufficient | 2.265e-06 | 1.788e-07 | 1.859e-07 | 284.52 |
| equiv-en-02 | 84 | 0 | insufficient | 5.722e-06 | 4.284e-08 | 2.010e-07 | 247.85 |
| equiv-en-03 | 89 | 0 | sufficient | 4.768e-06 | 1.192e-07 | 8.804e-08 | 246.21 |
| equiv-en-04 | 88 | 0 | insufficient | 5.960e-06 | 7.153e-07 | 1.025e-06 | 241.21 |
| equiv-en-05 | 95 | 0 | insufficient | 6.199e-06 | 3.278e-07 | 2.298e-07 | 264.78 |
| equiv-en-06 | 82 | 0 | insufficient | 7.629e-06 | 1.192e-07 | 1.351e-07 | 245.89 |
| equiv-en-07 | 83 | 0 | insufficient | 1.860e-05 | 1.788e-06 | 1.706e-06 | 223.18 |
| equiv-en-08 | 83 | 0 | sufficient | 9.537e-06 | 8.345e-07 | 3.039e-07 | 233.70 |
| equiv-en-09 | 88 | 0 | insufficient | 5.245e-06 | 8.941e-08 | 7.513e-08 | 246.31 |
| equiv-en-10 | 89 | 0 | insufficient | 2.861e-06 | 3.278e-07 | 1.087e-08 | 256.82 |
| equiv-en-11 | 1024 | 0 | sufficient | 1.431e-05 | 1.013e-06 | 6.581e-07 | 4546.34 |
| equiv-en-12 | 91 | 7 | sufficient | 6.676e-06 | 1.490e-07 | 2.621e-08 | 358.54 |

## Versions, timing and native memory

Linux x86_64, kernel 6.18.44, virtualized Intel Xeon Platinum 8370C @ 2.80GHz, 3 exposed CPUs. CPU provider only; FP32; ORT intra-op threads 2, inter-op threads 1; CPU arena enabled. No environment thread overrides were present; tokenizer calls are single-sequence encoding. These settings are not a process-wide resource-enforcement claim.

- Rust **1.99.1** (`58cf8f9c3`), Cargo **1.99.1**, `ort` **2.0.0-rc.10**, ONNX Runtime **1.22.0**, Rust/Python tokenizers **0.22.2**.
- PyTorch **2.8.0+cpu**, Transformers **5.0.0**, NumPy **2.2.6**. ONNX remains the approved Marco 1.2 artifact; no exporter was run.
- Native launch → ready, externally measured: **5751.74 ms**; from Rust `main`: **5735.91 ms**. Includes SHA verification, tokenizer loading and model preparation.
- Tokenizer loading: **1804.18 ms**; ORT initialization + model loading: **898.91 ms**.
- One warmup on fixed PT-01: **201.58 ms**. Subsequent 24 actual forwards: min **167.51 ms**, median **260.61 ms**, mean **641.84 ms**, max **4885.37 ms**. The 1024-token cases took **4885.37 / 4546.34 ms**.
- Native process peak/current RSS: **866204 KiB = 845.90 MiB**, read from its own `/proc/self/status`. Includes native tokenizer, ORT, hash buffers and loaded graph; excludes the independent Python reference process and timing wrapper.
- Total external wall time: **24114.86 ms**.

One process launch and one warmed forward per fixture, under strace: these are measured observations, not stable throughput/percentile benchmarks. Sequence lengths differ, cache conditions were not controlled and tracing can add overhead. No extrapolation to Windows/macOS, other CPUs, quality or production budgets.

## Offline proof and checks

The actual 24-case Rust run used `strace -f -e trace=network -e inject=socket:error=ENETDOWN`; socket creation was denied for the child and its threads. The trace contains only successful process/thread exits, **no network calls**. All artifacts were local, with telemetry disabled; Cargo's model-fetch/download-binary features and tokenizer HTTP feature are disabled. Dependency fetching occurred before inference. The executable loads the pinned ORT shared object directly: it does not invoke/import Python, despite this development library being located inside the reference venv. `ldd` lists no Python dependency. This validates offline operation of this runner, not a production network sandbox.

- Standalone locked release compilation: PASS.
- Six Rust unit tests: PASS (ties, non-finites, bounds/no truncation, tolerance rejection, uniform calibration, altered artifact rejection).
- Rustfmt check: PASS.
- Actual offline Rust/ONNX vs original PyTorch: PASS, 24/24.
- Clippy: **unavailable**, component absent; no installation attempted. This is a tooling limitation, not a lint pass.
- No global Modus CI, plugin, Guardian, enforcement or production tests were run.

## Reproduction

Use the already approved snapshot/graph and reference venv. Resolve paths to the original artifacts; verify the recorded SHA-256 before proceeding. Never regenerate or edit the frozen fixtures based on scores.

```bash
# Original PyTorch reference only; no export.
/workspace/scratch/thx01-m11/venv/bin/python scripts/thx01/rust_reference.py \
  --snapshot /workspace/scratch/thx01-m1/snapshot \
  --fixtures scripts/thx01/equivalence/fixtures.json \
  --inventory /workspace/scratch/thx01-m12/attempt-1/graph-inspection.json \
  --graph /workspace/scratch/thx01-m12/attempt-1/thx01-choice3-dynamic.onnx \
  --output /workspace/scratch/thx01-m13/reference.json
CARGO_TARGET_DIR=/workspace/scratch/thx01-m13/target ~/.cargo/bin/cargo build \
  --release --locked --manifest-path scripts/thx01/equivalence/Cargo.toml -j 2
CARGO_TARGET_DIR=/workspace/scratch/thx01-m13/target ~/.cargo/bin/cargo test \
  --release --locked --manifest-path scripts/thx01/equivalence/Cargo.toml -j 2
~/.cargo/bin/cargo fmt --check --manifest-path scripts/thx01/equivalence/Cargo.toml
python3 scripts/thx01/run_native_equivalence.py \
  --binary /workspace/scratch/thx01-m13/target/release/thx01-equivalence \
  --manifest /workspace/scratch/thx01-m13/validation-manifest.json \
  --fixtures scripts/thx01/equivalence/fixtures.json \
  --reference /workspace/scratch/thx01-m13/reference.json \
  --output /workspace/scratch/thx01-m13/native
```

`run_native_equivalence.py` is a standard-library-only timing wrapper; all native tokenization, inference and postprocessing happen in the Rust child. The native executable itself can also be invoked with the five positional arguments recorded in `launch-measurements.json`.

## Independent review and stop

Independent read-only review by a separate agent: **GO, no blocking findings**. It checked the implementation against pinned original source, manifest and actual outputs without running additional tests/models. See [review evidence](evidence/thx01-m13/independent-review.md). Its coverage/performance/trust limitations are incorporated above. No second model run or exporter run was necessary.

GO is limited to the tested three-choice technical path on Linux x64 CPU. No service, IPC, cancellation, lifecycle, resource enforcement, Pi SDK integration or packaging exists from this milestone. Windows x64/macOS require independent validation. Model quality, including the absence of retrieval winners in this set, remains unassessed. **Stop here. Marco 2 requires explicit new authorization.**
