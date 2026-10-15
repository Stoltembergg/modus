"""Directed CPU comparison for Marco 1.2; no Rust runtime or 24-fixture evaluation."""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import resource
import sys
import time

import numpy as np


def enforce_token_limit(length):
    if length > 1024:
        raise ValueError('Input exceeds 1024 tokens; silent truncation is forbidden')


def calibrate(logits, temperature):
    z=logits[0]/temperature
    probabilities=np.exp(z-z.max())
    probabilities/=probabilities.sum()
    confidence=float(np.clip(1.0-float(-(probabilities*np.log(np.clip(probabilities,1e-12,1.0))).sum())/math.log(3),0,1))
    return probabilities,confidence


def compare_outputs(reference, actual, reference_act, actual_act, temperature):
    for value in [reference,actual,reference_act,actual_act]:
        if not np.isfinite(value).all(): raise AssertionError('Outputs must be finite')
    if not np.allclose(reference,actual,rtol=1e-3,atol=1e-4):
        raise AssertionError('Raw logits violate atol=1e-4, rtol=1e-3')
    if not np.allclose(reference_act,actual_act,rtol=1e-3,atol=1e-4):
        raise AssertionError('Action-head logits violate atol=1e-4, rtol=1e-3')
    rp,rc=calibrate(reference,temperature)
    ap,ac=calibrate(actual,temperature)
    delta=float(np.abs(rp-ap).max())
    if delta>1e-4: raise AssertionError('Calibrated probabilities differ by more than 1e-4')
    if abs(rc-ac)>1e-4: raise AssertionError('Confidence differs by more than 1e-4')
    if int(rp.argmax())!=int(ap.argmax()): raise AssertionError('Selected choice differs')
    return {'max_logit_abs_error':float(np.abs(reference-actual).max()),
            'max_action_logit_abs_error':float(np.abs(reference_act-actual_act).max()),
            'max_probability_abs_error':delta,'confidence_abs_error':abs(rc-ac),
            'reference_probabilities':rp.tolist(),'ort_probabilities':ap.tolist(),
            'reference_confidence':rc,'ort_confidence':ac,
            'reference_choice_index':int(rp.argmax()),'ort_choice_index':int(ap.argmax())}


def run(snapshot, graph, inventory, output):
    os.environ['HF_HUB_OFFLINE']='1'
    os.environ['TRANSFORMERS_OFFLINE']='1'
    network_attempts=[]
    def audit(event, args):
        if event in ['socket.connect','socket.getaddrinfo']:
            network_attempts.append(event)
            raise RuntimeError('Network forbidden during local validation')
    sys.addaudithook(audit)
    import torch
    import onnxruntime as ort
    sys.path.insert(0,str(snapshot))
    from thx01 import Agent
    from thx01.common import build_sequence,collate_items,temp_bucket
    from smoke_export import CHOICES,QUESTION,SMOKE
    torch.set_num_threads(2);torch.set_num_interop_threads(1)
    record={'versions':{p:importlib.metadata.version(p) for p in ['torch','transformers','tokenizers','numpy','onnxruntime','onnxscript','onnx-ir','onnx']},
            'status':'running','cases':[], 'network_guard':'CPython socket audit rejects connect/getaddrinfo; not OS network isolation',
            'threads':{'intra_op':2,'inter_op':1},'inference_runtime':'Python ORT CPU, not Rust',
            'tolerances':{'logits_atol':1e-4,'logits_rtol':1e-3,'probability_atol':1e-4,'confidence_atol':1e-4,'choice':'exact'}}
    def verify_artifacts():
        for name,info in json.loads(inventory.read_text())['artifacts'].items():
            with (graph.parent/name).open('rb') as source:digest=hashlib.file_digest(source,'sha256').hexdigest()
            if digest!=info['sha256']: raise ValueError(f'Artifact digest changed: {name}')
    try:
        verify_artifacts();record['external_artifacts_verified_before']=True
        start=time.perf_counter();agent=Agent(str(snapshot),device='cpu',half=False)
        record['pytorch_load_ms']=(time.perf_counter()-start)*1000
        question={'type':'choice','instructions':QUESTION,'criteria':CHOICES}
        internal=agent._to_internal(question);budget=agent._head_budget(internal)
        def encode(state):return build_sequence(agent.tok,state,internal,1000000,budget)
        base='Authorized local context: inspect the requested change before editing.'
        lo,hi=0,2048
        while lo<hi:
            mid=(lo+hi+1)//2
            if len(encode(base+' context'*mid)[0])<=1024:lo=mid
            else:hi=mid-1
        long_state=base+' context'*lo
        fixtures=[{'id':'short-pt','state':'Corrija o botão.'},
                  {'id':'near-97-pt','state':SMOKE[0]['state']},
                  {'id':'above-97-en','state':base+' context'*100},
                  {'id':'padded-mask-en','state':base+' context'*100,'padding':7},
                  {'id':'near-limit-en','state':long_state}]
        prepared=[]
        for fixture in fixtures:
            seq,markers=encode(fixture['state']);enforce_token_limit(len(seq)+fixture.get('padding',0))
            tensors=collate_items([[{'ids':seq,'markers':markers,'qtype':0}]],agent.tok.pad_token_id)
            if fixture.get('padding'):
                n=fixture['padding']
                tensors['input_ids']=torch.nn.functional.pad(tensors['input_ids'],(0,n),value=agent.tok.pad_token_id)
                tensors['attention_mask']=torch.nn.functional.pad(tensors['attention_mask'],(0,n),value=0)
            prepared.append((fixture,tensors))
        assert prepared[0][1]['input_ids'].shape[1]<97
        assert prepared[1][1]['input_ids'].shape[1]==97
        assert prepared[2][1]['input_ids'].shape[1]>97
        assert prepared[-1][1]['input_ids'].shape[1]>=1000
        try:
            seq,_=encode(base+' context'*2048);enforce_token_limit(len(seq))
        except ValueError:record['oversized_rejected_without_inference']=True
        else:raise AssertionError('Oversized input was not rejected')
        options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
        start=time.perf_counter();session=ort.InferenceSession(str(graph),sess_options=options,providers=['CPUExecutionProvider'])
        record['ort_session_load_ms']=(time.perf_counter()-start)*1000
        record['providers']=session.get_providers()
        assert record['providers']==['CPUExecutionProvider']
        record['ort_input_metadata']=[{'name':x.name,'shape':x.shape,'type':x.type} for x in session.get_inputs()]
        names=['input_ids','attention_mask','marker_pos','marker_mask','qtype']
        temperature=agent.temperature_by_options.get(temp_bucket(0,3),agent.temperature[0]);record['temperature']=temperature
        for fixture,tensors in prepared:
            feed={n:tensors[n].numpy() for n in names}
            row={**fixture,'shapes':{n:list(v.shape) for n,v in feed.items()},'inputs':{n:v.tolist() for n,v in feed.items()},
                 'tokens_including_padding':int(tensors['input_ids'].shape[1]),'valid_tokens':int(tensors['attention_mask'].sum())}
            record['cases'].append(row)
            start=time.perf_counter()
            with torch.no_grad():reference,reference_act=agent.model(*(tensors[n] for n in names))
            row['pytorch_ms']=(time.perf_counter()-start)*1000
            start=time.perf_counter();actual,actual_act=session.run(['logits','act_logits'],feed)
            row['ort_ms']=(time.perf_counter()-start)*1000
            row.update({'pytorch_logits':reference.numpy().tolist(),'ort_logits':actual.tolist(),
                        'pytorch_action_logits':reference_act.numpy().tolist(),'ort_action_logits':actual_act.tolist()})
            try:row.update(compare_outputs(reference.numpy(),actual,reference_act.numpy(),actual_act,temperature))
            except AssertionError as error:row['validation_error']=str(error);raise
            row['reference_choice']=list(CHOICES)[row['reference_choice_index']]
            row['ort_choice']=list(CHOICES)[row['ort_choice_index']]
            row['status']='passed'
            output.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
            print(json.dumps({k:row[k] for k in ['id','tokens_including_padding','max_logit_abs_error','max_probability_abs_error','reference_choice','ort_choice','pytorch_ms','ort_ms']}),flush=True)
        verify_artifacts();record['external_artifacts_verified_after']=True
        original=json.loads((snapshot/'source-manifest.json').read_text())
        for name,info in original['files'].items():
            with (snapshot/name).open('rb') as source:digest=hashlib.file_digest(source,'sha256').hexdigest()
            if digest!=info['sha256']:raise AssertionError(f'Original snapshot changed: {name}')
        record['original_snapshot_files_verified']=len(original['files'])
        record['status']='passed_directed_python_ort_only'
    except Exception as error:
        record.update({'status':'failed','error':f'{type(error).__name__}: {error}'})
        raise
    finally:
        record.update({'network_attempts':network_attempts,'peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})
        output.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    for name in ['snapshot','graph','inventory','output']:parser.add_argument('--'+name,type=Path,required=True)
    args=parser.parse_args()
    run(args.snapshot.resolve(),args.graph.resolve(),args.inventory.resolve(),args.output.resolve())
