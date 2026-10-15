"""Read-only analysis of the saved THX graph and a tiny unrelated IR reproduction."""
import importlib.metadata
import json
from pathlib import Path
import re
import sys
import traceback

import onnx
from onnx import TensorProto, helper
import onnx_ir as ir
from onnx_ir.passes.common import InlinePass
from onnxscript.version_converter import convert_version

report = Path(sys.argv[1]).read_text()
output = Path(sys.argv[2])
root = report[report.index("## ONNX model"): ] if "## ONNX model" in report else report
root = root[:root.index("def pkg.")]
functions = re.findall(r"^def ([\w.]+)::(\w+)\(", report, re.M)
calls = {f"{domain}::{name}": len(re.findall(r"⬅️ " + re.escape(domain + "::" + name) + r"\(", root)) for domain, name in functions}

# Synthetic identity graph with the same two unused helper functions; no THX changes.
def function(name, nodes):
    return helper.make_function("pkg.onnxscript.torch_lib.common", name, ["input"], ["return_val"], nodes, [helper.make_opsetid("", 18)])
rank = function("Rank", [helper.make_node("Shape", ["input"], ["tmp"]), helper.make_node("Size", ["tmp"], ["return_val"])])
scalar = function("IsScalar", [helper.make_node("Shape", ["input"], ["tmp"]), helper.make_node("Size", ["tmp"], ["tmp_0"]), helper.make_node("Constant", [], ["tmp_1"], value_int=0), helper.make_node("Equal", ["tmp_0", "tmp_1"], ["return_val"])])
graph = helper.make_graph([helper.make_node("Identity", ["x"], ["y"])], "unused-function-repro", [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1])], [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1])])
model = ir.from_proto(helper.make_model(graph, functions=[rank, scalar], opset_imports=[helper.make_opsetid("", 18)]))
InlinePass()(model)
result = {
    "versions": {k: importlib.metadata.version(k) for k in ["onnx", "onnxscript", "onnx-ir"]},
    "thx_report_functions": calls,
    "synthetic_after_inline": [list(k) for k in model.functions],
    "synthetic_call_sites": [node.op_identifier() for node in model.graph],
}
try:
    convert_version(model, 18)
    result["conversion"] = "passed"
except Exception:
    result["conversion"] = "failed"
    result["traceback"] = traceback.format_exc()
output.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({k:v for k,v in result.items() if k!="traceback"}, indent=2))
