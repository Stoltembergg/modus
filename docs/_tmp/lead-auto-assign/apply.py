#!/usr/bin/env python3
"""Apply Lead auto-assign patches into the real source paths."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
STAGE = Path(__file__).resolve().parent

PATCHES = [
    ("NewGroupModal.tsx.patch", "apps/desktop/src/renderer/src/features/groups", "NewGroupModal.tsx",
     ("resolveNewGroupLead", 'source === "custom"')),
    ("group-agents.test.ts.patch", "apps/desktop/src/main/groups", "group-agents.test.ts",
     ("without leadName auto-assigns",)),
]

def main() -> None:
    for patch_name, rel_dir, filename, markers in PATCHES:
        patch = STAGE / patch_name
        target_dir = ROOT / rel_dir
        target = target_dir / filename
        if not patch.exists():
            raise SystemExit(f"missing patch {patch}")
        if not target.exists():
            raise SystemExit(f"missing target {target}")
        cmd = ["patch", "-p1", "--forward", "--batch", "-i", str(patch)]
        print("running", " ".join(cmd), "in", target_dir)
        proc = subprocess.run(cmd, cwd=target_dir, capture_output=True, text=True)
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        if proc.returncode not in (0, 1):
            raise SystemExit(f"patch failed rc={proc.returncode} for {filename}")
        text = target.read_text()
        for marker in markers:
            if marker not in text:
                raise SystemExit(f"marker missing in {filename}: {marker!r}")
        print("ok", target.relative_to(ROOT), "bytes", len(text))

if __name__ == "__main__":
    main()
