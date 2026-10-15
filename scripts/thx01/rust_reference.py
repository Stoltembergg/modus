"""Original PyTorch reference for the frozen Rust equivalence set; no ONNX export."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import sys
import time

os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'


def digest(path):
    with path.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()


def run(snapshot,fixtures,inventory,graph,output):
    sys.path.insert(0,str(snapshot))
    import numpy as np
    import torch
    import onnxruntime
    from thx01 import Agent
    from thx01.common import build_sequence,collate_items,confidence_from_probs,temp_bucket
    torch.set_num_threads(2);torch.set_num_interop_threads(1)
    frozen=json.loads(fixtures.read_text());sha=digest(fixtures)
    expected=fixtures.with_suffix('.sha256').read_text().split()[0]
    assert sha==expected
    assert len(frozen['fixtures'])==24
    manifest={'graph':str(graph),'tokenizer':str(snapshot/'tokenizer/tokenizer.json'),
              'tokenizer_config':str(snapshot/'tokenizer/tokenizer_config.json'),
              'calibration':str(snapshot/'rl_agent_config.json'),
              'ort_library':str(Path(onnxruntime.__file__).parent/'capi/libonnxruntime.so.1.22.0'),
              'ort_version':onnxruntime.__version__,'files':[]}
    for name,info in json.loads(inventory.read_text())['artifacts'].items():
        path=graph.parent/name
        assert digest(path)==info['sha256']
        manifest['files'].append({'path':str(path),**info})
    original=json.loads((snapshot/'source-manifest.json').read_text())
    for name,info in original['files'].items():
        path=snapshot/name;assert digest(path)==info['sha256']
        manifest['files'].append({'path':str(path),**info})
    lib=Path(manifest['ort_library'])
    manifest['files'].append({'path':str(lib),'bytes':lib.stat().st_size,'sha256':digest(lib)})
    manifest['files'].append({'path':str(fixtures),'bytes':fixtures.stat().st_size,'sha256':sha})
    output.parent.mkdir(exist_ok=True,parents=True)
    (output.parent/'validation-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    started=time.perf_counter();agent=Agent(str(snapshot),device='cpu',half=False)
    result={'fixture_sha256':sha,'purpose':'fidelity_not_classification_quality','rows':[],
            'versions':{p:importlib.metadata.version(p) for p in ['torch','transformers','numpy','tokenizers']},
            'pytorch_model_load_ms':(time.perf_counter()-started)*1000}
    for fixture in frozen['fixtures']:
        qdef={'type':'choice','instructions':fixture['question'],
              'criteria':{o['key']:o['description'] for o in fixture['options']}}
        q=agent._to_internal(qdef);budget=agent._head_budget(q)
        ids,markers=build_sequence(agent.tok,fixture['state'],q,1000000,budget)
        assert 65<=len(ids)+fixture['padding']<=1024
        assert len(ids)==fixture['tokens_before_padding']
        item={'ids':ids,'markers':markers,'qtype':0}
        tensors=collate_items([[item]],agent.tok.pad_token_id)
        if fixture['padding']:
            tensors['input_ids']=torch.nn.functional.pad(tensors['input_ids'],(0,fixture['padding']),value=agent.tok.pad_token_id)
            tensors['attention_mask']=torch.nn.functional.pad(tensors['attention_mask'],(0,fixture['padding']),value=0)
        start=time.perf_counter()
        with torch.no_grad():logits,act=agent.model(*(tensors[n] for n in ['input_ids','attention_mask','marker_pos','marker_mask','qtype']))
        elapsed=(time.perf_counter()-start)*1000
        values=logits.numpy()[0]
        temperature=agent.temperature_by_options.get(temp_bucket(0,3),agent.temperature[0])
        z=values/temperature;probabilities=np.exp(z-z.max());probabilities/=probabilities.sum()
        confidence=confidence_from_probs(probabilities,3)
        row={'id':fixture['id'],'language':fixture['language'],
             'inputs':{n:tensors[n].tolist() for n in ['input_ids','attention_mask','marker_pos','marker_mask','qtype']},
             'logits':values.tolist(),'act_logits':act.numpy()[0].tolist(),
             'probabilities':probabilities.tolist(),'confidence':confidence,
             'temperature':temperature,'choice':fixture['options'][int(probabilities.argmax())]['key'],
             'top_two_margin':float(np.sort(probabilities)[-1]-np.sort(probabilities)[-2]),
             'pytorch_ms':elapsed,
             'api_answer':agent._decode({'context':qdef},[item],logits.numpy(),torch.softmax(act.float(),-1).numpy())['context']}
        result['rows'].append(row)
        print(f"{row['id']}: tokens={len(tensors['input_ids'][0])} margin={row['top_two_margin']:.6f}",flush=True)
    result['peak_rss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    result['fixture_sha256_after']=digest(fixtures);assert result['fixture_sha256_after']==sha
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':
    p=argparse.ArgumentParser()
    for key in ['snapshot','fixtures','inventory','graph','output']:p.add_argument('--'+key,type=Path,required=True)
    a=p.parse_args();run(a.snapshot.resolve(),a.fixtures.resolve(),a.inventory.resolve(),a.graph.resolve(),a.output.resolve())
