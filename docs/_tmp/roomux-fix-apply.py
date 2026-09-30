#!/usr/bin/env python3
from __future__ import annotations
import hashlib, pathlib, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parents[2]
TMP = ROOT / "docs" / "_tmp"
patch = TMP / "roomux-biome.patch"
EXPECTED = "4a5837098e129f412fee9828c0ba28991201669d0262b6508c6ea73991498fde"
if not patch.exists():
    print("missing roomux-biome.patch", file=sys.stderr)
    sys.exit(1)
digest = hashlib.sha256(patch.read_bytes()).hexdigest()
if digest != EXPECTED:
    print(f"patch sha256 mismatch: {digest} != {EXPECTED}", file=sys.stderr)
    sys.exit(1)
subprocess.run(["git", "apply", str(patch)], cwd=ROOT, check=True)
patch.unlink()
for p in list(TMP.glob("roomux-fix-*")) + list(TMP.glob("roomux-*.b64")):
    p.unlink(missing_ok=True)
wf = ROOT / ".github" / "workflows" / "apply-roomux-fix.yml"
if wf.exists():
    wf.unlink()
pathlib.Path(__file__).unlink(missing_ok=True)
try:
    next(TMP.iterdir())
except StopIteration:
    TMP.rmdir()
except FileNotFoundError:
    pass
print("applied plain biome patch ok")
