"""Validate an exported local graph and inventory artifacts; does not run inference."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import time

import onnx


def inspect(path, output):
    started = time.perf_counter()
    path = path.resolve()
    model = onnx.load(path, load_external_data=False)
    nodes, tensors = [], []

    def visit_graph(graph):
        tensors.extend(graph.initializer)
        for sparse in graph.sparse_initializer:
            tensors.extend([sparse.values, sparse.indices])
        visit_nodes(graph.node)

    def visit_nodes(items):
        for node in items:
            nodes.append(node)
            for attr in node.attribute:
                if attr.HasField("t"):
                    tensors.append(attr.t)
                tensors.extend(attr.tensors)
                if attr.HasField("g"):
                    visit_graph(attr.g)
                for graph in attr.graphs:
                    visit_graph(graph)

    visit_graph(model.graph)
    for function in model.functions:
        visit_nodes(function.node)
    identifiers = {(f.domain, f.name, f.overload) for f in model.functions}
    functions = [{"domain": f.domain, "name": f.name, "overload": f.overload,
                  "calls": sum((n.domain, n.op_type, n.overload) == (f.domain, f.name, f.overload) for n in nodes),
                  "opsets": {o.domain: o.version for o in f.opset_import}} for f in model.functions]
    files = {path: None}
    external = []
    for tensor in tensors:
        if tensor.data_location != onnx.TensorProto.EXTERNAL:
            continue
        info = {x.key: x.value for x in tensor.external_data}
        relative = Path(info['location'])
        target = (path.parent / relative).resolve()
        if relative.is_absolute() or not target.is_relative_to(path.parent) or not target.is_file():
            raise ValueError(f"Unsafe or missing external data: {info['location']}")
        offset, length = int(info.get('offset',0)), int(info.get('length',target.stat().st_size))
        if offset < 0 or length < 0 or offset + length > target.stat().st_size:
            raise ValueError(f"External tensor out of bounds: {tensor.name}")
        files[target] = None
        external.append({"tensor": tensor.name, **info})
    for file in files:
        with file.open('rb') as source:
            files[file] = {"bytes": file.stat().st_size, "sha256": hashlib.file_digest(source,'sha256').hexdigest()}
    result = {
        "graph": path.name, "ir_version": model.ir_version,
        "opsets": {o.domain:o.version for o in model.opset_import},
        "inputs": [{"name": i.name, "dimensions": [d.dim_param if d.dim_param else d.dim_value for d in i.type.tensor_type.shape.dim]} for i in model.graph.input],
        "outputs": [o.name for o in model.graph.output],
        "functions": functions,
        "node_count_including_functions": len(nodes),
        "operators": dict(sorted(Counter(f"{n.domain or 'ai.onnx'}::{n.op_type}" for n in nodes).items())),
        "artifacts": {str(p.relative_to(path.parent)):v for p,v in files.items()},
        "external_tensors": external,
        "unresolved_custom_calls": sorted({f"{n.domain}::{n.op_type}" for n in nodes if n.domain not in ('','ai.onnx') and (n.domain,n.op_type,n.overload) not in identifiers}),
        "inference_executed": False,
    }
    try:
        onnx.checker.check_model(str(path), full_check=True)
        result['checker_full_check'] = 'passed'
    except Exception as error:
        result['checker_full_check'] = 'failed'
        result['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        result['inspection_ms'] = (time.perf_counter()-started)*1000
        output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['operators','external_tensors']},indent=2))


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('graph',type=Path)
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    inspect(args.graph,args.output)
