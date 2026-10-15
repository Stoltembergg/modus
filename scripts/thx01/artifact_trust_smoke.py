"""Development test driver only: real native inference, no Python ML/backend imports.
Authenticates disposable model copies in Rust, replaces them before load, and
compares actual results with the frozen original reference. Never runs in Modus.
"""
import argparse
import hashlib
import json
import os
import signal
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path


def run(binary, manifest_path, fixtures_path, reference_path, output):
    source = json.loads(manifest_path.read_text())
    fixtures_bytes = fixtures_path.read_bytes()
    assert hashlib.sha256(fixtures_bytes).hexdigest() == '88cae7fb314e6367cab697a677680616002788fb4eb462f9ff326ede6e8a9810'
    fixtures = {f['id']: f for f in json.loads(fixtures_bytes)['fixtures']}
    references = {r['id']: r for r in json.loads(reference_path.read_text())['rows']}
    output.mkdir(parents=True, exist_ok=True)
    result = {'status': 'in_progress', 'rows': [], 'mode': 'real native example calls production authenticated-bundle consumer and production IPC service', 'startup_bootstrap': 'trusted developer launch; NOT installed deb bootstrap proof'}
    process = None
    started = time.perf_counter()
    try:
        with tempfile.TemporaryDirectory(prefix='thx-artifact-fixture-') as temporary:
            root = Path(temporary)
            paths = {}
            for artifact in source['files']:
                path = Path(artifact['path']); target = root / path.name
                assert not target.exists()
                shutil.copyfile(path, target)
                paths[str(path)] = str(target)
            locator = {k: paths.get(v, v) if isinstance(v, str) else v for k, v in source.items() if k != 'files'}
            locator['files'] = [{**a, 'path': paths[a['path']]} for a in source['files']]
            manifest = root / 'locator.json'; manifest.write_text(json.dumps(locator, indent=2))
            sha = hashlib.sha256(manifest.read_bytes()).hexdigest()
            generation = 'artifact-trust-fixture'
            command = [str(binary), str(root), str(manifest), sha, generation]
            # The native child alone is offline; no global host policy is changed.
            trace = ['strace', '-f', '-e', 'trace=network', '-e', 'inject=socket:error=ENETDOWN', '-o', str(output/'network.trace'), *command]
            frames = queue.Queue(maxsize=16)
            with (output/'native.stderr.txt').open('w') as stderr:
                launch = time.perf_counter()
                process = subprocess.Popen(trace, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, start_new_session=True)
                def read_frames():
                    try:
                        while True:
                            raw = process.stdout.readline(16*1024+2)
                            if not raw:
                                frames.put(RuntimeError('native_eof')); return
                            if len(raw) > 16*1024+1 or not raw.endswith(b'\n'):
                                frames.put(RuntimeError('native_frame')); return
                            frames.put(json.loads(raw))
                    except Exception as error:
                        frames.put(error)
                threading.Thread(target=read_frames, daemon=True).start()
                def receive(timeout):
                    value = frames.get(timeout=timeout)
                    if isinstance(value, Exception): raise value
                    assert value['version'] == 1 and value['generation'] == generation
                    return value
                def send(value):
                    raw = json.dumps({'version': 1, 'generation': generation, **value}, ensure_ascii=False).encode()
                    assert len(raw) <= 64*1024
                    process.stdin.write(raw+b'\n'); process.stdin.flush()
                ready = receive(60)
                assert ready['type'] == 'ready' and ready['manifestSha256'] == sha
                result['startup_ms'] = (time.perf_counter()-launch)*1000
                assert all(Path(a['path']).read_bytes() == b'synthetic replacement after authentication' for a in locator['files'])
                assert manifest.read_bytes() == b'synthetic locator replacement'
                result['all_six_sources_and_locator_replaced_before_consumer'] = True
                ids = ['equiv-pt-01','equiv-en-01','equiv-pt-05','equiv-en-05','equiv-pt-11','equiv-en-11']
                for fixture_id in ids:
                    fixture = fixtures[fixture_id]; ref = references[fixture_id]
                    request = {'type': 'observe', 'requestId': fixture_id, 'input': {k: fixture[k] for k in ['question','state','options']}}
                    begin = time.perf_counter(); send(request)
                    first = receive(5); assert first['type'] == 'started' and first['requestId'] == fixture_id
                    frame = receive(max(0.001, 5-(time.perf_counter()-begin)))
                    assert frame['requestId'] == fixture_id
                    if frame['type'] == 'error' and frame['code'] == 'inference_timeout':
                        result['rows'].append({'id': fixture_id, 'status': 'unavailable_timeout_5s'}); continue
                    assert frame['type'] == 'result'
                    decision = frame['decision']; assert decision['choice'] == ref['choice']
                    errors = [abs(a-b) for a,b in zip(decision['logits'],ref['logits'])]
                    assert all(error <= 1e-4+1e-3*abs(r) for error,r in zip(errors,ref['logits']))
                    p_error = max(abs(a-b) for a,b in zip(decision['probabilities'],ref['probabilities']))
                    c_error = abs(decision['confidence']-ref['confidence'])
                    assert p_error <= 1e-4 and c_error <= 1e-4
                    result['rows'].append({'id': fixture_id,'status':'passed','tokens':frame['tokens'],'choice':decision['choice'],'logits':decision['logits'],'probabilities':decision['probabilities'],'confidence':decision['confidence'],'max_logit_error':max(errors),'max_probability_error':p_error,'confidence_error':c_error,'native_ms':frame['durationMs'],'wall_ms':(time.perf_counter()-begin)*1000,'native_peak_rss_kib':frame['rssKiB']})
                send({'type': 'shutdown', 'requestId':'shutdown'})
                assert receive(3)['type'] == 'stopped'
                process.stdin.close(); assert process.wait(timeout=3) == 0
                result['status'] = 'passed' if all(r['status']=='passed' for r in result['rows']) else 'limited_timeout'
                result['native_exit_code'] = process.returncode
                result['network_socket_creation_denied'] = True
    except queue.Empty:
        result['status'] = 'deadline_unavailable'
        raise
    finally:
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=3)
        result['wall_ms'] = (time.perf_counter()-started)*1000
        (output/'results.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    for name in ['binary','manifest','fixtures','reference','output']: p.add_argument('--'+name,type=Path,required=True)
    a = p.parse_args()
    run(*(getattr(a,n).resolve() for n in ['binary','manifest','fixtures','reference','output']))
