# THX-01 Marco 1 — feasibility report (2026-10-15)

**Decision: NO-GO for Marco 2. Marco 1 stopped blocked, not accepted.**

Follow-up: [Marco 1.1 diagnosis](thx01-onnxscript-diagnosis.md) resolved the ONNXScript export failure with version 0.6.2; variable-shape fidelity and native equivalence remain unproved. The original report below is historical evidence, not overwritten results.

The original CPU model ran. One `torch.onnx.export` call failed before writing a validated ONNX artifact. No ONNX Runtime inference in Rust, numeric equivalence, native tokenizer parity or contextual-decision quality was established. This does **not** prove intrinsic THX-01/ONNX architectural incompatibility: the observed failure is in the tested export/version-conversion configuration.

## Scope and final plan amendments

- Exactly 24 final fixtures (12 PT, 12 EN), frozen before final comparison, after the minimal real smoke path succeeds. Ambiguity, close probabilities, Unicode, option ordering and near-limit input remain required. The smoke failure prevented reaching this final corpus; none of the 24 were constructed or compared.
- Future Marco 3 explicitly requires asynchronous host-owned initialization independent of observations, without blocking prompts.
- Linux x64 is the first validation target. Windows x64/macOS require independent later validation; cross-compilation is not evidence of support.
- No production service, IPC, Pi SDK wiring, feature flag, packaging or unrelated code was implemented.

## Provenance and environment

Checkpoint: `doofz/THX-01`, revision `01262517979528a0103108ba473b78d6baeec016`.

Weights: 643,835,524 bytes; SHA-256 `52ce834b2a4d265fbc351338655977023ddb61b0363f5f6a4fd096e6c70154b0`, matched the pinned expected digest. Source/tokenizer/configuration hashes and sizes are recorded in [source-manifest.json](evidence/thx01-m1/source-manifest.json.gz). No snapshot file changed during loading ([loader-normalization.json](evidence/thx01-m1/loader-normalization.json.gz)). These development hashes are not a production distribution trust chain.

| Component | Recorded version/configuration |
| --- | --- |
| OS/architecture | Linux 6.18.44, glibc 2.41, x86_64 |
| CPU | Intel Xeon Platinum 8370C @ 2.80 GHz; 3 visible logical CPUs |
| Python | 3.12.14 (development only) |
| PyTorch | 2.8.0+cpu, original FP32 CPU path |
| Transformers | 5.0.0 (encoder configuration declares 5.0.0) |
| Tokenizers / NumPy | 0.22.2 / 2.2.6 |
| ONNX / ONNXScript / onnx-ir | 1.18.0 / 0.4.0 / 1.0.0 |
| ONNX Runtime | 1.22.0 installed for development; not executed |
| Rust compiler | 1.99.1 installed; no Rust runner built or executed |
| Export | opset 18, dynamo=True, fallback=False; one export API call |
| CPU threads | intra-op 2; inter-op 1 |

Complete Python dependency versions: [requirements-resolved.txt](evidence/thx01-m1/requirements-resolved.txt). No Rust `ort` version was selected/compiled because export stopped first.

## Original inference evidence

The untouched upstream `Agent` loaded the pinned weights with its strict architecture/weight checks. Its mmBERT/ModernBERT encoder, decision head, attention implementation, tokenizer and calibration were not replaced. The three-choice temperature was 2.55. Offline library flags were set and all assets were local; OS-level network isolation was not tested.

| Synthetic case | Input tokens | Original selected choice | Timed direct forward |
| --- | ---: | --- | ---: |
| smoke-pt | 97 | context_sufficient | 189.27 ms |
| smoke-en | 94 | insufficient_information | 279.03 ms |

There were four original-model forward calls overall: two timed direct calls, plus `Agent.system_one` for rounded API outputs on both cases. These are two individual timings, **not** cold/warm percentiles, repeated benchmarks, or decision-accuracy measurements. Full input IDs, masks, marker positions/type IDs, logits, action-head outputs, calibrated probabilities, selected choices and rounded API outputs are preserved in [smoke-reference.json](evidence/thx01-m1/smoke-reference.json.gz).

## Export failure and attribution

The native model's five existing tensor inputs and both raw output heads were passed directly to `torch.onnx.export`; no model wrapper or alternate attention/head was introduced. Requested dynamic sequence range was 1..1,024. This includes lengths smaller than the valid three-choice question envelope, a limitation of this export setup.

The one export API call automatically attempted non-strict, strict and draft capture internally. Non-strict/strict capture raised shape-constraint errors, including a guard excluding sequence length 1. The draft path then reported graph capture, decomposition and ONNX translation success. A later ONNXScript version-conversion pass failed:

> `ValueError: The model contains functions. The version conversion pass does not support functions. Please use common_passes.InlinePass to inline the functions before applying this pass (_ConvertVersionPassRequiresInline).`

The outer error was `onnx_ir.passes.PassError`, after an `InlinePass` was already reported. It propagated from PyTorch's compatibility export path into `onnxscript_apis.convert_version`. No `.onnx` artifact was written. The exporter report precedes this final failure; its “Translate the graph into ONNX” success must not be presented as a successful saved/validated export.

This proves failure of the recorded toolchain/configuration, not an intrinsically unexportable mmBERT operation. The sequence-range issue and library/opset compatibility remain diagnostic limitations; neither was demonstrated to be the sole cause of the terminal conversion error. No retries with changed shapes/opsets/dependency versions, wrappers, legacy exporter, Candle, alternate model or production Python fallback were attempted.

Evidence: [full traceback](evidence/thx01-m1/export-traceback.txt), [export log](evidence/thx01-m1/export.log), and [compressed exporter strategies report](evidence/thx01-m1/exporter-strategies.md.gz).

## Equivalence and measurements

| Requirement | Result |
| --- | --- |
| Real original PyTorch inference | Available for the two smoke cases |
| Validated ONNX artifact / ONNX checker | Not reached |
| Real Rust/ONNX inference | Not reached |
| Native token ID/mask/position equality | Not measured; reference tensors only |
| Logit/probability tolerance / identical choices | Not measured; no comparison is possible |
| Numerical or choice divergence | None assessed; absence of comparison is not zero error |
| Final 24-fixture equivalence set | Not reached after smoke failure |
| Independent classification-quality evaluation | Not performed; outside this fidelity gate |
| Any distributed platform support | Not established |

Recorded original-model load time: **12.771 s**. Failed export duration: **118.824 s**. Process peak RSS (`ru_maxrss`, Linux KiB): **2,429,960 KiB (~2.32 GiB)** through load/reference, **4,168,500 KiB (~3.98 GiB)** including export. Peaks cover the entire Python process and are not exclusive weight memory, steady-state measurements, enforced quotas or predictions of Rust memory/latency.

Full metadata: [environment.json](evidence/thx01-m1/environment.json.gz).

## Reproduction

The following commands reproduce the single attempted configuration; they are documentation, not further execution. Use Linux x64 and the recorded dependency versions. Preparation downloads only the fixed development snapshot; the inference/export stage uses local assets.

```sh
python3 -m venv /workspace/scratch/thx01-m1/venv
/workspace/scratch/thx01-m1/venv/bin/pip install torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
/workspace/scratch/thx01-m1/venv/bin/pip install -r docs/architecture/evidence/thx01-m1/requirements-resolved.txt --extra-index-url https://download.pytorch.org/whl/cpu
python3 scripts/thx01/prepare.py /workspace/scratch/thx01-m1/snapshot
/workspace/scratch/thx01-m1/venv/bin/python scripts/thx01/smoke_export.py --snapshot /workspace/scratch/thx01-m1/snapshot --output /workspace/scratch/thx01-m1/evidence
```

The smoke script records environment/reference data and makes one export call; its nonzero exit and conversion traceback are the expected outcome for the recorded attempt. Version/platform differences may change the result. No claim is made that other export configurations cannot work.

## Independent review and stop

A separate read-only reviewer checked the scripts, plan, raw reference data, metadata, traceback and exporter report. The reviewer confirmed NO-GO for Marco 2, the lack of native equivalence evidence, the shape-range caveat, the automatic internal capture strategies, and the distinction between this failure and universal model incompatibility. No additional tests, inference, export or implementation were run by that reviewer.

The work is stopped at this real export-path blocker. A further bounded investigation of shape/opset/dependency compatibility would require user authorization; it was not carried out. Marco 2 and Marco 3 remain unauthorized. No production defaults, model selection, permissions, QA, UI, Guardian controls or plugin execution changed.
