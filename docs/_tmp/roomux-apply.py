#!/usr/bin/env python3
"""Apply staged roomux-*.b64 gzip patches, then remove staging artifacts."""
from __future__ import annotations

import base64
import gzip
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
TMP = ROOT / "docs" / "_tmp"
parts = sorted(TMP.glob("roomux-*.b64"))
if not parts:
    print("missing roomux staging parts", file=sys.stderr)
    sys.exit(1)
raw = gzip.decompress(base64.b64decode(b"".join(p.read_bytes() for p in parts)))
patch = pathlib.Path("/tmp/roomux.patch")
patch.write_bytes(raw)
subprocess.run(["git", "apply", str(patch)], cwd=ROOT, check=True)
for p in parts:
    p.unlink()
wf = ROOT / ".github" / "workflows" / "apply-roomux.yml"
if wf.exists():
    wf.unlink()
script = pathlib.Path(__file__)
if script.exists():
    script.unlink()
print("applied", len(raw), "bytes from", len(parts), "parts")
