#!/usr/bin/env python3
"""Apply Lead auto-assign patches, then remove staging."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STAGE = Path(__file__).resolve().parent

PATCHES = [
    ("NewGroupModal.tsx.patch", "apps/desktop/src/renderer/src/features/groups/NewGroupModal.tsx"),
    ("group-agents.test.ts.patch", "apps/desktop/src/main/groups/group-agents.test.ts"),
]

def main() -> None:
    for patch_name, target in PATCHES:
        patch = STAGE / patch_name
        if not patch.exists():
            print("skip missing", patch)
            continue
        cmd = ["patch", "-p1", "--forward", "--batch", "-i", str(patch)]
        print("running", " ".join(cmd), "in", ROOT)
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        if proc.returncode not in (0, 1):  # 1 = already applied
            raise SystemExit(proc.returncode)
        # verify markers
        text = (ROOT / target).read_text()
        if target.endswith("NewGroupModal.tsx"):
            assert "resolveNewGroupLead" in text and 'source === "custom"' in text
        if target.endswith("group-agents.test.ts"):
            assert "without leadName auto-assigns" in text
        print("ok", target)

if __name__ == "__main__":
    main()
