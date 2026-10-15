# THX-01 Marco 1.1 — ONNXScript diagnosis and unblock

**Result:** original ONNXScript error diagnosed and resolved in a controlled dependency comparison. A structurally valid ONNX artifact was saved. **GO, conditional, to resume Marco 1 equivalence investigation only; NO-GO for Marco 2 remains.** No inference equivalence is claimed.

## Cause and evidence

The recorded failure was inside ONNXScript's `_ConvertVersionPassRequiresInline.call`, after `InlinePass`, before PyTorch could optimize/save its ONNX program. It rejected any nonempty `model.functions` before checking whether source and target opsets were already equal.

A read-only hook in new full-export attempt 1 captured exactly two residual functions after the old inliner:

| Function | Domain | Calls anywhere in graph/functions | Body operators |
| --- | --- | ---: | --- |
| Rank | pkg.onnxscript.torch_lib.common | 0 | Shape, Size |
| IsScalar | pkg.onnxscript.torch_lib.common | 0 | Shape, Size, Constant, Equal |

Both were unused declarations, not unsupported mmBERT operations or called model logic. The source and target ONNX opset were both **18**. The old converter rejected unused functions even when no opset conversion was needed. Its inliner removed called functions but left unused declarations. The earlier report also listed called `aten_unbind`, `aten_getitem` and `aten_split`; they were not residual at the failing old-converter entry.

An independent tiny identity graph with those unused helper declarations reproduced the old error without THX, PyTorch capture, weights or Transformers. The same synthetic conversion passed with the newer package. This is diagnostic control evidence, not a model inference comparison or another full model export.

Upstream correspondence:

- [ONNXScript #2790](https://github.com/microsoft/onnxscript/issues/2790): the same failure after newer ONNX IR inliner behavior.
- [ONNX IR #321](https://github.com/onnx/ir-py/pull/321): inliner changes, merged 2026-01-24.
- [ONNXScript #2791](https://github.com/microsoft/onnxscript/pull/2791): removed the blanket function rejection and added function traversal; merged 2026-02-09, commit `74a5f346777f0bd458b84bcfa4da61a0b82446e4`.
- [ONNXScript #2933](https://github.com/microsoft/onnxscript/issues/2933): reports the same unused Rank/IsScalar declarations, even with a simple Linear model.

The selected published **ONNXScript 0.6.2** wheel (released 2026-02-10) was inspected before use: its converter contains the upstream change. No upstream source was patched locally.

## Compatibility and exact attempts

The old package declares `onnx_ir>=0.1.7,<2` and `onnx>=1.16`, so dependency resolution permits ONNX IR 1.0.0 despite the observed behavioral incompatibility. Transformers 5.0.0's Torch extra requires `torch>=2.2`, and its tokenizer bound includes 0.22.2. These declared constraints are not a complete tested compatibility matrix. The new package retains the PyTorch exporter API used here; actual successful export provides narrower empirical evidence for this exact stack, not all supported Torch/model configurations.

Both full exports used the exact pinned original THX model and `smoke_export.py`: CPU FP32, five original tensor inputs, both heads returned, `dynamo=True`, legacy fallback disabled, opset 18 and dynamic sequence declaration 1..1,024. Each API call automatically attempted non-strict/strict/draft capture. The diagnostic hook only inspected data then invoked the unmodified upstream converter; it never rewrote the graph or substituted model operations.

| New full attempt | Hypothesis | ONNXScript | Outcome | Export time |
| --- | --- | --- | --- | ---: |
| 1 | Unused residual helpers trigger the original blanket rejection | 0.4.0 | Reproduced failure; exact functions/call counts captured | 111.742 s |
| 2 | Published upstream correction resolves the same configuration | 0.6.2 | Export succeeded and artifact saved | 121.768 s |

**Exactly two new full exports; no further attempt.** The second used a separate virtual environment. A diff of resolved dependencies shows only `onnxscript==0.4.0` → `onnxscript==0.6.2` changed. No global Modus dependency or lockfile was changed.

Unchanged: Linux x64, Python 3.12.14, PyTorch 2.8.0+cpu, Transformers 5.0.0, tokenizers 0.22.2, NumPy 2.2.6, ONNX 1.18.0, onnx-ir 1.0.0, ONNX Runtime 1.22.0. Full resolved versions are in [requirements-resolved.txt](evidence/thx01-m11/requirements-resolved.txt). Twenty original snapshot files were rehashed unchanged, including weights, tokenizer, encoder/head code and calibration.

## Artifact validity and dependency inventory

`onnx.checker.check_model(path, full_check=True)` **passed**. This is structural/type/shape checking, not inference or equivalence.

- ONNX IR version **10**; sole imported opset **ai.onnx 18**.
- **1,205 nodes**; **zero local functions**, **zero unresolved custom calls**.
- Both raw outputs remain: `logits` and `act_logits`. Calibration remains in the unchanged reference/configuration; this export does not assert native calibrated inference.
- **213 external tensors**, all in the one local companion data file. References were checked for local containment, existence and offset/length bounds. No model HTTP/runtime download dependency was introduced.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| thx01-choice3.onnx | 2,203,230 | d56b771fb940bbcb085b2b16d1372f38f2cdf1d5e0be8f9b3aa412cc868e1af9 |
| thx01-choice3.onnx.data | 1,288,830,976 | ecfffcebc4abbf217e368cd93a969efebebe4e8e2b87bb60375d951de2e96a5d |

Large artifacts remain outside Git in `/workspace/scratch/thx01-m11/attempt-2/`; retain **both** files together. See [graph-inspection.json](evidence/thx01-m11/attempt-2/graph-inspection.json.gz) for operators, external tensor ranges, digests and shapes. These hashes identify this export; they are not proof of inference fidelity or a production signing chain.

## Remaining shape/capture limitation

The export still used the automatic `draft_export` capture after strict/non-strict shape constraints failed. PyTorch warned that two capture issues prevented a sound graph guarantee. The declared range includes length 1, smaller than the valid three-option header; that setup was deliberately left unchanged to isolate the dependency correction.

The saved graph shows:

- `input_ids`: `[1, sequence]`.
- `attention_mask`: **`[1, 97]`**, fixed to the first smoke case.
- `marker_pos`, `marker_mask`: `[1, 3]`; `qtype`: `[1]`.

Therefore this artifact is **not established as usable for varied lengths or the final 24-fixture corpus**, and no 1,024-token envelope is proved by its symbolic axis. Passing Checker cannot resolve that issue. No attempt was made to correct shapes or bypass capture checks in this authorization.

## Evidence, reproduction and review

Evidence directory: `docs/architecture/evidence/thx01-m11/` contains both converter-entry snapshots, version/source captures, export logs/reports, upstream references, the tiny synthetic reproduction results, graph inspection and original-file preservation checks.

To reproduce the two authorized configurations, use the original Marco-1 virtual environment (ONNXScript 0.4.0) and a separate environment installed from the recorded 0.6.2 requirements, then run respectively:

```sh
/workspace/scratch/thx01-m1/venv/bin/python scripts/thx01/diagnostic_export.py --snapshot /workspace/scratch/thx01-m1/snapshot --output /workspace/scratch/thx01-m11/attempt-1
/workspace/scratch/thx01-m11/venv/bin/python scripts/thx01/diagnostic_export.py --snapshot /workspace/scratch/thx01-m1/snapshot --output /workspace/scratch/thx01-m11/attempt-2
/workspace/scratch/thx01-m11/venv/bin/python scripts/thx01/inspect_onnx.py /workspace/scratch/thx01-m11/attempt-2/thx01-choice3.onnx /workspace/scratch/thx01-m11/attempt-2/graph-inspection.json
```

These are documentation of completed runs, not authorization to repeat exports. `diagnose_inlining.py` reconstructs only the unrelated tiny helper reproduction; it does not change the THX graph. Reproduction versions and the pinned source manifest are required; different versions can produce different artifacts/results.

A separate read-only reviewer confirmed the cause, isolated dependency change, read-only instrumentation, Checker result and static-mask limitation. The reviewer ran no export, inference or tests.

Follow-up: [Marco 1.2](thx01-dynamic-shapes-validation.md) subsequently corrected the capture range and validated directed variable-length Python ORT inference. The findings above remain the historical Marco-1.1 record; Rust and Marco 2 remain unvalidated.

## Technical decision and mandatory stop

**GO conditioned to resume Marco 1 investigation**, because the original ONNXScript blocker is resolved and a Checker-valid artifact exists. **Not ready to execute/accept equivalence across the 24 varied fixtures with this artifact.**

The next recommended bounded experiment, only if newly authorized, is to correct the export shape envelope to valid input lengths and verify that IDs/masks retain the same variable dimension through sound capture. No model-operation replacement or graph patch is recommended. Then actual original-versus-Rust/ONNX inference remains necessary; it has not been started.

**Marco 1.1 is stopped. Marco 2 remains NO-GO and unauthorized.** No Rust runtime, 24-fixture comparison, Pi SDK integration, flags, packaging, CI, plugin/enforcement work or further export was executed.
