"""Development-only: fixed three-choice reference and a single faithful ONNX export attempt."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import resource
import sys
import time
import traceback

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

CHOICES = {
    "context_sufficient": "The supplied context supports starting the requested task.",
    "retrieve_local_context": "Additional authorized local project information is needed.",
    "insufficient_information": "The available information does not support a reliable decision.",
}
QUESTION = "Does the supplied task context contain enough information to begin the requested work?"
SMOKE = [
    {"id": "smoke-pt", "language": "pt", "state": "Altere o texto do botão de Entrar para Acessar. O componente fornecido é <button>Entrar</button>. Não altere o comportamento."},
    {"id": "smoke-en", "language": "en", "state": "Find why clicking Save fails. No source code, stack trace, or project files have been provided. Authorized local project files are available to inspect."},
]


def run(snapshot, output):
    output.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(snapshot))
    import numpy as np
    import torch
    from thx01 import Agent
    from thx01.common import QTYPES, build_sequence, collate_items, confidence_from_probs, temp_bucket

    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    metadata = {
        "platform": platform.platform(), "machine": platform.machine(),
        "python": platform.python_version(), "threads": {"intra_op": 2, "inter_op": 1},
        "versions": {k: importlib.metadata.version(k) for k in ("torch", "transformers", "tokenizers", "numpy", "onnx", "onnxruntime", "onnxscript")},
        "revision": "01262517979528a0103108ba473b78d6baeec016",
        "export_attempts": 0, "opset": 18,
    }
    (output / "environment.json").write_text(json.dumps(metadata, indent=2) + "\n")
    start = time.perf_counter()
    agent = Agent(str(snapshot), device="cpu", half=False)
    metadata["load_ms"] = (time.perf_counter() - start) * 1000
    metadata["load_peak_rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    names = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"]
    rows = []
    export_args = None
    question = {"type": "choice", "instructions": QUESTION, "criteria": CHOICES}
    internal = agent._to_internal(question)
    for fixture in SMOKE:
        seq, markers = build_sequence(agent.tok, fixture["state"], internal, 1_000_000, agent._head_budget(internal))
        if len(seq) > 1024:
            raise ValueError("Input exceeds 1024 tokens; truncation is forbidden")
        tensors = collate_items([[{"ids": seq, "markers": markers, "qtype": QTYPES["choice"]}]], agent.tok.pad_token_id)
        args = tuple(tensors[n] for n in names)
        start = time.perf_counter()
        with torch.no_grad():
            logits, act_logits = agent.model(*args)
        duration = (time.perf_counter() - start) * 1000
        z = logits.numpy()[0] / agent.temperature_by_options.get(temp_bucket(0, 3), agent.temperature[0])
        probabilities = np.exp(z - z.max()); probabilities /= probabilities.sum()
        rows.append({
            **fixture, "question": question, "tokens": len(seq),
            "inputs": {n: tensors[n].tolist() for n in names},
            "logits": logits.numpy().tolist(), "act_logits": act_logits.numpy().tolist(),
            "probabilities": probabilities.tolist(), "confidence": confidence_from_probs(probabilities, 3),
            "choice": list(CHOICES)[int(probabilities.argmax())], "reference_ms": duration,
            "rounded_reference": agent.system_one(fixture["state"], {"context": question})["answers"]["context"],
        })
        if export_args is None:
            export_args = args
    (output / "smoke-reference.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")
    metadata["reference_peak_rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    print(json.dumps({"load_ms": metadata["load_ms"], "reference": [{"id": r["id"], "tokens": r["tokens"], "ms": r["reference_ms"], "choice": r["choice"]} for r in rows]}), flush=True)
    start = time.perf_counter()
    try:
        metadata["export_attempts"] = 1
        sequence = torch.export.Dim("sequence", min=1, max=1024)
        torch.onnx.export(
            agent.model, export_args, str(output / "thx01-choice3.onnx"),
            input_names=names, output_names=["logits", "act_logits"],
            opset_version=18, dynamo=True, fallback=False, report=True,
            artifacts_dir=str(output),
            dynamic_shapes=({1: sequence}, {1: sequence}, None, None, None),
        )
        metadata["export_status"] = "exported_not_yet_equivalent"
    except Exception as error:
        metadata["export_status"] = "failed"
        metadata["error_type"] = type(error).__name__
        metadata["error"] = str(error)
        (output / "export-traceback.txt").write_text(traceback.format_exc())
        raise
    finally:
        metadata["export_ms"] = (time.perf_counter() - start) * 1000
        metadata["process_peak_rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        (output / "environment.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.snapshot.resolve(), args.output.resolve())
