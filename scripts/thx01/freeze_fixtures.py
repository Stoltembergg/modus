"""Freeze exactly 24 fidelity fixtures using token lengths only, never model scores."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import sys

os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
from smoke_export import CHOICES,QUESTION

PT=[
 'Altere Entrar para Acessar neste componente fornecido: <button>Entrar</button>. Preserve o comportamento.',
 'O botão Salvar falha. Os arquivos locais podem ser consultados, mas ainda não forneci código nem erro.',
 'Talvez já exista contexto suficiente. Faça o ajuste necessário, se conseguir determinar qual é.',
 'Temos parte do contexto, mas não sabemos se falta o arquivo relevante ou apenas uma explicação.',
 'Renomeie café para ação em ação.ts. Preserve 👩🏽‍💻, 東京 e a sequência e\u0301. Código fornecido: const café = 1;',
 'O rótulo literal contém <mask> e <bos>. Só há este exemplo de texto; não há uma tarefa de alteração definida.',
 'O teste foi descrito, mas não há resultado. O arquivo local está disponível para leitura autorizada.',
 'O componente completo está abaixo: <h1>Olá</h1>. Troque Olá por Bem-vindo, sem outras mudanças.',
 'Há dados conflitantes: o texto diz que o código foi enviado, mas nenhum trecho está presente. O projeto local existe.',
 '   Ajuste o espaçamento.\n\nCódigo: <div>oi</div>\t\nNão há imagem ou medida desejada.   ',
 'Contexto local autorizado para avaliar a alteração; nenhum resultado de QA deve ser inventado.',
 'Trecho completo: const nome = "Ana"; altere somente Ana para Bia. Não modifique o restante.'
]
EN=[
 'Replace Sign in with Continue in this provided component: <button>Sign in</button>. Preserve behavior.',
 'Save crashes. Authorized local source files are available, but no source or stack trace is included.',
 'There may be enough context, or we may need one more file. Make the intended change if its scope is clear.',
 'Some context is present. It is unclear whether the missing information is local code or the user\'s intended outcome.',
 'Keep café, ação.ts, 👩🏽‍💻, 東京, and decomposed e\u0301 unchanged. Provided code: const label = "café";',
 'A literal <mask> occurs in the documentation. No concrete code change has been requested.',
 'A failing test is mentioned without output. The relevant local project files are authorized for inspection.',
 'Complete source: <h1>Hello</h1>. Replace Hello with Welcome and make no other edits.',
 'The request claims the source was attached, but no attachment or code is present. The local project can be read.',
 ' \n Fix spacing.\tProvided source: <div>hello</div>.\nThe desired spacing is unspecified. ',
 'Authorized local context for checking the intended change; verification evidence must not be invented.',
 'Complete source: const name = "Ada"; replace only Ada with Grace. Preserve the rest.'
]


def run(snapshot,output):
    sys.path.insert(0,str(snapshot))
    from transformers import AutoTokenizer
    from thx01 import Agent
    from thx01.common import build_sequence
    helper=Agent.__new__(Agent)
    helper.cfg=json.loads((snapshot/'rl_agent_config.json').read_text())
    helper.tok=AutoTokenizer.from_pretrained(snapshot/'tokenizer',local_files_only=True)
    rows=[]
    permutations=[[0,1,2],[2,0,1],[1,2,0],[2,1,0]]
    for language,states in [('pt',PT),('en',EN)]:
        for index,state in enumerate(states):
            order=permutations[index%len(permutations)]
            options=[{'key':list(CHOICES)[i],'description':list(CHOICES.values())[i]} for i in order]
            question={'type':'choice','instructions':QUESTION,'criteria':{x['key']:x['description'] for x in options}}
            q=helper._to_internal(question)
            def encode(text):return build_sequence(helper.tok,text,q,1000000,helper._head_budget(q))
            if index==10:
                filler=' contexto' if language=='pt' else ' context'
                lo,hi=0,2048
                while lo<hi:
                    mid=(lo+hi+1)//2
                    if len(encode(state+filler*mid)[0])<=1024:lo=mid
                    else:hi=mid-1
                state+=filler*lo
            ids,_=encode(state)
            padding=7 if index==11 else 0
            assert 65<=len(ids)+padding<=1024
            rows.append({'id':f'equiv-{language}-{index+1:02d}','language':language,
                         'question':QUESTION,'options':options,'state':state,'padding':padding,
                         'tokens_before_padding':len(ids),'tokens_with_padding':len(ids)+padding,
                         'ambiguous_by_design':index in [2,3,8,9]})
    assert len(rows)==24 and Counter(x['language'] for x in rows)=={'pt':12,'en':12}
    content=json.dumps({'purpose':'technical_equivalence_only_not_quality_evaluation',
                        'close_choice_margin_threshold':0.10,
                        'construction':'fixed templates; near-limit fillers depend on token count only; no score-based inclusion/exclusion',
                        'fixtures':rows},ensure_ascii=False,indent=2)+'\n'
    output.write_text(content)
    digest=hashlib.sha256(content.encode()).hexdigest()
    output.with_suffix('.sha256').write_text(digest+'  '+output.name+'\n')
    print('Frozen:',len(rows),'fixtures;',Counter(x['language'] for x in rows),'; SHA256',digest)
    print('Lengths:',[x['tokens_with_padding'] for x in rows])


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--snapshot',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();run(a.snapshot.resolve(),a.output.resolve())
