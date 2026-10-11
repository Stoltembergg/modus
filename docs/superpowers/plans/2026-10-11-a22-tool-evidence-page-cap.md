# A22 Run Tool Evidence Page Cap Implementation Plan

> **For agentic workers:** This task is executed inline under the user's continuing A01–A25 authorization. Tests follow RED/GREEN order; commits remain scoped and the PR stays Draft.

**Goal:** Keep one run-scoped tool-evidence IPC page within an 8 MiB serialized payload budget and fail closed without changing durable event history.

**Architecture:** The main-process event store measures the exact run-scoped page before materializing its payloads, returns only the requested page rows, and rejects an over-budget page. The renderer and database use one shared limit; an unavailable source lookup must not claim partial evidence is complete.

**Tech Stack:** TypeScript, Node SQLite `DatabaseSync`, Vitest, Biome, desktop TypeScript.

**Spec:** `docs/architecture/remediacao-a01-a25-status.md`, A22 source-loader and event-page sections.

## Global Constraints

- Preserve the current branch's A16, A17, A21.1–A21.6 work and other committed changes.
- Do not execute adversarial probes, enforcement scenarios, root-resume, or untrusted plugin code.
- Keep external plugins disabled, Guardian Tasks 5–7 blocked, Checkpoints 2–3 on HOLD, and PR #191 Draft.
- Reject an oversized transfer without truncating, deleting, or rewriting the durable event payload.
- Describe this as a per-run tool-evidence page bound only; do not claim all event pages, assistant-message reconstruction, heap, or RSS are bounded.

## Review Focus

- Concurrent database writes between byte preflight and payload materialization — tests should prove the queries use one SQLite read snapshot, or the ledger should record why the single synchronous main-process connection is the relied-on boundary.
- A `limit + 1` sentinel must not materialize an unbounded payload — keep `hasMore` as an existence query without selecting `payload_json`.
- The renderer collector and IPC page must share the same configured byte budget — assert the shared constant is used in both paths.
- An over-budget response must not become a partial success — assert rejection and unchanged SQLite payload bytes.

---

### Task 1: Complete the run-scoped tool evidence page limit

**Files:**
- Modify: `apps/desktop/src/shared/agent-events.ts`
- Modify: `apps/desktop/src/main/agent/agent-event-store.ts`
- Modify: `apps/desktop/src/main/agent/agent-event-store.test.ts`
- Modify: `apps/desktop/src/renderer/src/features/sources/runSources.ts`
- Modify: `docs/architecture/remediacao-a01-a25-status.md`

**Interfaces:**
- Consumes: `listAgentEventPage(sessionId, { runId, ... })` and the run-scoped SQLite event range.
- Produces: `MAX_RUN_TOOL_EVIDENCE_PAGE_BYTES = 8 * 1024 * 1024`, consistently applied to persisted `payload_json` returned for a run page.

- [x] Write the synthetic over-budget page regression and prove RED: `listAgentEventPage(sessionId, { runId })` previously materialized the page instead of rejecting.
- [x] Ensure run-boundary discovery, byte preflight, has-more detection, and payload selection share one SQLite snapshot, with `hasMore` avoiding payload materialization.
- [x] Run the focused store and renderer source tests, desktop TypeScript, targeted Biome, and `git diff --check`.
- [x] Record exact guarantee and residuals and obtain independent static review.
- [ ] Commit, publish, inspect PR CI and packaging, and confirm the PR remains Draft.
