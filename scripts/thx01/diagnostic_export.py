"""Development-only read-only hooks around one full export call; no graph rewriting."""
import argparse
import functools
import importlib.metadata
import inspect
import json
from pathlib import Path
import sys


def install_hooks(output):
    import onnxscript.version_converter as vc
    classes = [getattr(vc, name) for name in ("_ConvertVersionPassRequiresInline", "_ConvertVersionPass") if hasattr(vc, name)]
    if len(classes) != 1:
        raise RuntimeError("Expected one known upstream converter class; refusing unknown instrumentation")
    cls = classes[0]
    original = cls.call

    @functools.wraps(original)
    def observe(self, model):
        nodes = list(model.graph.all_nodes())
        for function in model.functions.values():
            nodes.extend(function.all_nodes())
        functions = []
        for identifier, function in model.functions.items():
            calls = [n for n in nodes if n.op_identifier() == identifier]
            functions.append({"identifier": list(identifier), "call_count": len(calls), "body": [{"domain": n.domain, "op": n.op_type} for n in function.all_nodes()]})
        snapshot = {"converter": cls.__name__, "graph_opsets": dict(model.graph.opset_imports), "target_opset": self.target_version, "functions": functions}
        (output / "converter-entry.json").write_text(json.dumps(snapshot, indent=2) + "\n")
        return original(self, model)

    cls.call = observe  # Diagnostics only: inspect then invoke the unmodified upstream method.
    (output / "converter-source.py.txt").write_text(inspect.getsource(cls))
    (output / "versions.json").write_text(json.dumps({k: importlib.metadata.version(k) for k in ["torch", "transformers", "tokenizers", "numpy", "onnx", "onnxscript", "onnx-ir", "onnxruntime"]}, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    install_hooks(args.output)
    from smoke_export import run
    run(args.snapshot.resolve(), args.output.resolve())
