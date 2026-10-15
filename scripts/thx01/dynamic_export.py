"""Marco 1.2: export the unchanged THX model with a valid shared length constraint."""
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

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'


def run(snapshot, output):
    import torch
    sys.path.insert(0, str(snapshot))
    from thx01 import Agent
    from thx01.common import build_sequence, collate_items
    from smoke_export import CHOICES, QUESTION, SMOKE
    output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    metadata = {'platform': platform.platform(), 'export_calls': 0,
                'versions': {p: importlib.metadata.version(p) for p in ['torch','transformers','tokenizers','numpy','onnx','onnxscript','onnx-ir','onnxruntime']},
                'hypothesis': 'Use the actual question-header minimum and one shared symbolic length; require verified capture without draft fallback.',
                'opset': 18, 'capture': 'torch.export.export(strict=False); no draft fallback'}
    start = time.perf_counter()
    try:
        agent = Agent(str(snapshot), device='cpu', half=False)
        question = {'type':'choice','instructions':QUESTION,'criteria':CHOICES}
        q = agent._to_internal(question)
        budget = agent._head_budget(q)
        empty, _ = build_sequence(agent.tok, '', q, 1000000, budget)
        seq, positions = build_sequence(agent.tok, SMOKE[0]['state'], q, 1000000, budget)
        assert len(seq) <= 1024
        names = ['input_ids','attention_mask','marker_pos','marker_mask','qtype']
        tensors = collate_items([[{'ids':seq,'markers':positions,'qtype':0}]], agent.tok.pad_token_id)
        args = tuple(tensors[n] for n in names)
        length = torch.export.Dim('sequence', min=len(empty), max=1024)
        shapes = ({1:length},{1:length},None,None,None)
        metadata.update({'minimum_sequence':len(empty),'example_sequence':len(seq),'shared_length':True})
        (output/'configuration.json').write_text(json.dumps(metadata,indent=2)+'\n')
        captured = torch.export.export(agent.model, args, dynamic_shapes=shapes, strict=False)
        metadata['capture_status'] = 'verified_export_program'
        (output/'range-constraints.txt').write_text(str(captured.range_constraints)+'\n')
        metadata['export_calls'] = 1
        torch.onnx.export(captured, (), str(output/'thx01-choice3-dynamic.onnx'),
                          input_names=names, output_names=['logits','act_logits'],
                          dynamo=True, fallback=False, opset_version=18, report=True,
                          artifacts_dir=str(output))
        metadata['status']='exported_unvalidated'
    except Exception as error:
        metadata.update({'status':'failed','error_type':type(error).__name__,'error':str(error)})
        (output/'traceback.txt').write_text(traceback.format_exc())
        raise
    finally:
        metadata.update({'elapsed_ms':(time.perf_counter()-start)*1000,
                         'peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})
        (output/'configuration.json').write_text(json.dumps(metadata,indent=2)+'\n')


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--snapshot',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    run(args.snapshot.resolve(),args.output.resolve())
