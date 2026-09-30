# N4 — Proactive wake + interrupt policy

**Repo:** Stoltembergg/modus  
**Depends on:** N0–N3, N5 on main  
**Branch:** `cursor/natural-groups-n4-proactive-cb29`  
**Constraint:** stay inside Group Runtime budgets/loop guards; no parallel orchestrator.

## Behavior

1. **Resume owned work** — after a silent turn (no `@`, no loop-closing status), wake one owner of an open/`in_progress` task with `Resume: "…" — continue your owned work`.
2. **Proactive review** — after `Agreed` / `Proposed`, wake the reviewer on the speaker’s `in_progress` task with `Review ready: "…" — please review`.
3. **Interrupt the user** — `Ready for you` / `Blocked · …` (and blocked turn outcomes) do **not** proactive-wake peers.

Lead routing for unowned open tasks (P1b) is unchanged.

## Tests

- Silence + owned task → owner resumes
- Agreed + reviewer → reviewer wakes once
- Ready for you → no peer wake
