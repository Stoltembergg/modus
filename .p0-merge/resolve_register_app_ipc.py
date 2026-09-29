#!/usr/bin/env python3
"""Resolve the known register-app-ipc.ts conflict with agents backend + HyperPlan IPC extract."""
from __future__ import annotations

import re
from pathlib import Path

path = Path("apps/desktop/src/main/ipc/register-app-ipc.ts")
text = path.read_text()
replacement = """import {
  createAgent,
  deleteAgent,
  listAgents,
  setAgentArchived,
  updateAgent,
} from "../agents/agents-store";
"""
pattern = re.compile(
    r"<<<<<<<[^\n]*\n"
    r"=======\n"
    r'import \{ plansRoot \} from "\.\./agent/tools/plan-tools";\n'
    r"import \{\n"
    r"  createAgent,\n"
    r"  deleteAgent,\n"
    r"  listAgents,\n"
    r"  setAgentArchived,\n"
    r"  updateAgent,\n"
    r'\} from "\.\./agents/agents-store";\n'
    r">>>>>>>[^\n]*\n"
)
new_text, count = pattern.subn(replacement, text, count=1)
if count != 1:
    if "<<<<<<<" not in text:
        print("no conflict markers; ok")
        raise SystemExit(0)
    raise SystemExit(f"unexpected conflict markers in register-app-ipc.ts (matches={count})")
if "<<<<<<<" in new_text:
    raise SystemExit("conflict markers remain after resolve")
path.write_text(new_text)
print("resolved register-app-ipc.ts")
