#!/usr/bin/env python3
"""Write Lead auto-assign sources from staged zlib.b64 payloads."""
from __future__ import annotations

import base64
import hashlib
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
STAGE = Path(__file__).resolve().parent

FILES = [
    ("modal.zlib.b64", "apps/desktop/src/renderer/src/features/groups/NewGroupModal.tsx",
     "26222fb932d048e0954de54e16103b82c764ba358ed89e9713e10ca0c4e58424", ("resolveNewGroupLead", 'source === "custom"')),
    ("agents-test.zlib.b64", "apps/desktop/src/main/groups/group-agents.test.ts",
     "00b4263ad1303905ca6acc77adb0b58b3b8fe40f748455df276bfae0a5f394a9", ("without leadName auto-assigns",)),
]

def main() -> None:
    for name, rel, want_sha, markers in FILES:
        raw = zlib.decompress(base64.b64decode((STAGE / name).read_text().strip()))
        digest = hashlib.sha256(raw).hexdigest()
        if digest != want_sha:
            raise SystemExit(f"sha mismatch {name}: {digest} != {want_sha}")
        text = raw.decode()
        for marker in markers:
            if marker not in text:
                raise SystemExit(f"marker missing in {rel}: {marker!r}")
        out = ROOT / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(raw)
        print("wrote", rel, len(raw), digest[:16])

if __name__ == "__main__":
    main()
