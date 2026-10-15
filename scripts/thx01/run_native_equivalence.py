"""Process timing/offline wrapper only: no ML imports and no Python inference."""
import argparse
import json
from pathlib import Path
import subprocess
import time


def run(binary, manifest, fixtures, reference, output):
    output.mkdir(parents=True, exist_ok=True)
    expected = fixtures.with_suffix('.sha256').read_text().split()[0]
    command = [str(binary), str(manifest), str(fixtures), str(reference),
               str(output / 'rust-results.json'), expected]
    # Deny socket creation in this child only. No global network-policy changes.
    traced = ['strace', '-f', '-e', 'trace=network', '-e',
              'inject=socket:error=ENETDOWN', '-o', str(output / 'network.trace'), *command]
    started = time.perf_counter()
    events = []
    with (output / 'native.stderr.log').open('w') as stderr:
        process = subprocess.Popen(traced, stdout=subprocess.PIPE, stderr=stderr, text=True)
        for line in process.stdout:
            event = json.loads(line)
            event['external_elapsed_ms'] = (time.perf_counter() - started) * 1000
            events.append(event)
            print(json.dumps(event), flush=True)
        status = process.wait()
    result = {'command': traced, 'exit_code': status, 'events': events,
              'wall_ms': (time.perf_counter() - started) * 1000,
              'measurement_limitations': 'Includes strace overhead; single launch and one warmed inference per fixture. Wrapper performs no inference.'}
    (output / 'launch-measurements.json').write_text(json.dumps(result, indent=2) + '\n')
    raise SystemExit(status)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['binary', 'manifest', 'fixtures', 'reference', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    run(*(getattr(args, name).resolve() for name in ['binary', 'manifest', 'fixtures', 'reference', 'output']))
