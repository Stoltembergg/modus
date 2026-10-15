# THX-01 Marco 1.2 — dynamic shapes and directed ORT CPU validation

**Result: accepted within this milestone's directed scope. GO to resume Marco 1 equivalence in Rust only with new authorization. Marco 2 remains blocked.**

One new full export was sufficient. No second export, definitive Rust service, native comparator, 24-fixture suite, IPC, Pi SDK/Harness wiring, feature flags, packaging, global CI or plugin/enforcement tests were executed.

## Cause and smallest correction

The original driver declared the same symbolic `sequence` dimension for IDs and attention mask, so this was not a missing dynamic-shapes declaration. It requested the invalid-for-this-question range 1..1,024. The saved logs show normal capture rejected a guard excluding length 1. The exporter then used draft capture, which weakened the required constraints and recorded two added guards:

- ModernBERT SDPA: equality of ID and mask sequence lengths.
- The unchanged decision head's TransformerEncoderLayer: `768 * mask_length == 74496`, specializing `mask_length` to 97.

The minimal driver correction computes the actual fixed three-choice question-header length from the original tokenizer/sequence builder: **65 tokens**. It constrains both tensors to one shared length in **[65, 1024]** and explicitly calls `torch.export.export(strict=False)` before ONNX export. This is ordinary verified capture with guards, not the unsound draft fallback. The resulting ExportedProgram is given directly to `torch.onnx.export`; capture failure would stop the driver.

No encoder, ModernBERT attention, decision head, weights, tokenizer, temperature, source module or ONNX node was replaced/patched. The driver preserves the original five inputs and both output heads. No dependency version changed. The outcome supports this corrected capture path; it does not prove the old Transformers implementation intrinsically cannot support dynamic shapes.

## Versions and graph checks

Linux x64, Python 3.12.14; PyTorch 2.8.0+cpu; Transformers 5.0.0; tokenizers 0.22.2; NumPy 2.2.6; ONNX 1.18.0; ONNXScript **0.6.2**; onnx-ir 1.0.0; ONNX Runtime **1.22.0**. Checkpoint revision remains `01262517979528a0103108ba473b78d6baeec016`.

ONNX Checker `full_check=True` passed. IR version 10, ai.onnx opset 18, 1381 nodes, zero local functions and zero unresolved custom calls. The graph contains 167 external tensors in one verified companion file. The capture report is successful and uses no draft strategy.

| Input | ONNX / actual ORT metadata | Tested meaning |
| --- | --- | --- |
| input_ids | int64 [1, s53] | Actual original token IDs at each tested length |
| attention_mask | int64 [1, s53] | Matching variable length; both all-valid and padded-zero masks |
| marker_pos | int64 [1, 3] | Original three alternative positions, within sequence |
| marker_mask | bool [1, 3] | Three valid alternatives |
| qtype | int64 [1] | Original choice type ID 0 |

The fixed auxiliary dimensions are intentional for one question with exactly three choices, not claims of support for other types/options/batches. The capture range is recorded in [range-constraints.txt](evidence/thx01-m12/range-constraints.txt). ONNX symbolic metadata does not itself enforce the upper bound; this development driver explicitly rejects over-1,024-token input. No production validator is implemented here.

## Real directed inference results

Each case feeds the **same tokenization and five tensors** to the original CPU FP32 PyTorch model and actual ONNX Runtime CPU. ORT was explicitly configured with only CPUExecutionProvider, intra-op 2 / inter-op 1 threads. Inputs and both raw heads are recorded in [comparison.json](evidence/thx01-m12/comparison.json.gz).

The unchanged choice:3-5 temperature **2.55**, softmax and normalized-entropy confidence are applied equally in Python to both raw outputs. This verifies directed raw-output/calibrated-result agreement; it does not validate future Rust tokenization or postprocessing.

| Case | Total / valid tokens | Max choice-logit absolute error | Max probability absolute error | PyTorch ms | ORT ms | Choice |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| short-pt | 70 / 70 | 2.5033951e-06 | 1.7881393e-07 | 203.87 | 119.57 | same |
| near-97-pt | 97 / 97 | 1.168251e-05 | 1.0728836e-06 | 215.69 | 170.63 | same |
| above-97-en | 176 / 176 | 4.2915344e-06 | 8.9406967e-08 | 338.55 | 292.49 | same |
| padded-mask-en | 183 / 176 | 4.2915344e-06 | 8.9406967e-08 | 348.56 | 314.71 | same |
| near-limit-en | 1024 / 1024 | 7.8678131e-06 | 9.5367432e-07 | 2088.37 | 2607.22 | same |

All five cases selected `context_sufficient` in both implementations. These are technical-fidelity fixtures, not ground-truth accuracy labels. In particular, the near-limit repeated synthetic context is not evidence of correct task classification.

- Maximum choice-logit absolute error: **1.1682510376e-05**.
- Maximum probability absolute error: **1.07288360596e-06**.
- Maximum confidence absolute error: **8.68071772242e-07**.
- Action-head maximum absolute error: **0.0010986328125**, on values around 1100–1300. It passes the approved combined absolute/relative criterion; do not misreport the choice-logit maximum as the maximum of all model outputs.
- Both raw heads satisfy `abs(actual-reference) <= 1e-4 + 1e-3 * abs(reference)`; probabilities/confidence differ by at most 1e-4; no choice differences. Tolerances were not relaxed and calibration was not fitted.

The padded case executes **183 positions with 176 valid tokens** and seven zero mask entries; it confirms mask behavior beyond identical all-one inputs. The 1,024-token case executed in both runtimes without truncation. An independently prepared over-limit sequence was rejected before inference, not sliced to fit. No cases were skipped after a failed comparison.

## Integrity, offline operation and measurements

Graph/data SHA-256 values were checked before and after inference and remained unchanged. All **20** pinned original snapshot files, including weights/tokenizer/calibration/source, were rehashed unchanged.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| thx01-choice3-dynamic.onnx | 2,482,868 | 13a870e7211257b3a6eb93696ec25f8ff91488638bc308a6738957edf9024a58 |
| thx01-choice3-dynamic.onnx.data | 1,287,651,328 | 8e5c1f58aa060e9279ebd07d27f3cc160dd0cc1ee7a9407819ac54c200e58f5c |

Large artifacts remain outside Git under `/workspace/scratch/thx01-m12/attempt-1/`; both graph and data file are required. [graph-inspection.json](evidence/thx01-m12/graph-inspection.json.gz) records every external tensor reference, offset, length and digest.

Inference used local assets, offline Hugging Face/Transformers flags and a CPython audit hook denying socket connect/address resolution. **Zero network attempts** were observed by that guard. CPU-only ORT and the graph require no custom remote operators. This is not a claim of OS-enforced network isolation or proof about arbitrary native libraries.

- End-to-end model preparation/capture/export driver: **45.724 s**, including its model load; peak process RSS **2,630,548 KiB**.
- Reference model load in the comparison process: **13.227 s**.
- ORT session creation in that already-running comparison process: **865.78 ms**.
- Comparison-process peak RSS: **2,572,796 KiB (~2.45 GiB)**, covering PyTorch and ORT together, not ORT alone or the future Rust runtime.

Per-case times above are single measured calls, not percentiles, cold-start guarantees or statistically established speedups. The 1,024-token input was feasible with available resources; resource use for production concurrency/platforms remains unvalidated.

## Files, reproducibility and independent review

Added development tools only:

- `scripts/thx01/dynamic_export.py`: corrected bounded capture and one ONNX export.
- `scripts/thx01/dynamic_equivalence.py`: directed real CPU comparison, offline guard, limits and integrity checks.
- `scripts/thx01/test_dynamic_equivalence.py`: six small comparator/limit guard checks, all passed. They reject out-of-tolerance logits, probability drift despite permitted relative logit error, a near-tie choice flip, non-finite values and oversized input. These tests are not the deferred 24-fixture model evaluation.

Reproduce using the existing fixed Marco-1.1 development environment and original snapshot:

```sh
/workspace/scratch/thx01-m11/venv/bin/python scripts/thx01/dynamic_export.py --snapshot /workspace/scratch/thx01-m1/snapshot --output /workspace/scratch/thx01-m12/attempt-1
/workspace/scratch/thx01-m11/venv/bin/python scripts/thx01/inspect_onnx.py /workspace/scratch/thx01-m12/attempt-1/thx01-choice3-dynamic.onnx /workspace/scratch/thx01-m12/attempt-1/graph-inspection.json
/workspace/scratch/thx01-m11/venv/bin/python -m unittest discover -s scripts/thx01 -p test_dynamic_equivalence.py
/workspace/scratch/thx01-m11/venv/bin/python scripts/thx01/dynamic_equivalence.py --snapshot /workspace/scratch/thx01-m1/snapshot --graph /workspace/scratch/thx01-m12/attempt-1/thx01-choice3-dynamic.onnx --inventory /workspace/scratch/thx01-m12/attempt-1/graph-inspection.json --output /workspace/scratch/thx01-m12/comparison.json
```

Commands document completed runs, not authorization for additional stages. Raw evidence is under `docs/architecture/evidence/thx01-m12/`, including successful capture report, shape inventory, comparison tensors/metrics and guard-test output. Existing exporter/ONNX inspector and pinned requirements remain unchanged.

A separate read-only reviewer examined scripts, constraints, upstream calibration and results without executing anything. No material blocking inconsistency was found; the reviewer required the action-head/choice-logit error distinction and combined-process memory qualification reflected above.

**Stop:** Marco 1.2 ends here. GO is limited to continuing original-versus-Rust equivalence under a new authorization. Python ORT success on these five cases does not establish Rust equivalence, full 24-fixture acceptance, classification quality or desktop platform support. Marco 2 remains unauthorized.
