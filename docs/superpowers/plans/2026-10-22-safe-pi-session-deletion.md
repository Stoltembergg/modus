# Safe Pi Session File Deletion Implementation Plan

> **For agentic workers:** Use the existing Modus code patterns and implement task-by-task. Each step has a checkable result.

**Goal:** Delete a Pi conversation JSONL only when Modus can prove it belongs exclusively to the session being deleted, while always preserving files whose ownership is uncertain.

**Architecture:** Add a database query that sees every stored session-file reference, then a small filesystem helper that validates the candidate path, file identity, Pi header ID, and exclusive ownership before unlinking. Invoke the helper synchronously during session teardown after runtime disposal and before removing the session record; cleanup failure must not block the record deletion.

**Tech Stack:** TypeScript, Node.js `fs`/`path`, SQLite `agent-store`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-safe-pi-session-deletion-design.md`

## Global Constraints

- Delete only a candidate directly under the app's `userData/pi-sessions` directory, when the stored `piSessionId` matches the JSONL header and no other session references the file.
- Preserve the file if any ownership, path, file-type, identity, or exclusive-use check is inconclusive or fails.
- Preserve memories, backups, shared files, and files outside the session store.
- Session database deletion must continue after a Pi-file cleanup error.
- All filesystem tests use temporary directories; do not delete real user data.

## Review Focus

- Relative, traversing, and outside-store paths: must preserve; test in cleanup helper.
- Symlinked session directories or candidate files: must preserve; test in cleanup helper.
- Hard-linked JSONL: must preserve; test in cleanup helper where hard links are supported.
- Malformed, missing, or mismatched Pi header: must preserve; test in cleanup helper.
- Another archived or group-member session points at the candidate: must preserve; test query and cleanup helper.
- Candidate changes between inspection and unlink: must preserve; test with filesystem-operation injection.
- Filesystem unlink errors: log a generic warning and continue record deletion; test lifecycle integration.

---

### Task 1: Expose all other session-file references

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-store.ts`
- Test: `apps/desktop/src/main/agent/agent-store.test.ts`

**Interfaces:**
- Produces: `listOtherAgentSessionPiSessionFiles(sessionId: string): string[]`, querying every `agent_sessions` row with a non-null `pi_session_file`, excluding only `sessionId` (no archive or kind filters).

- [ ] **Step 1: Write the failing test**

Add a test that inserts the target session and other sessions representing an active chat, an archived chat, and a `group_member`; give each a distinct `pi_session_file` and assert the function returns all three other paths, including archived and group-member references, but not the target.

- [ ] **Step 2: Run the targeted test and confirm it fails**

Run: `npm --workspace @modus/desktop exec -- vitest run --root ../.. apps/desktop/src/main/agent/agent-store.test.ts`
Expected: FAIL because the export does not exist.

- [ ] **Step 3: Implement the all-session reference query**

Implement the interface above using a single synchronous SQLite query with `id <> ?` and `pi_session_file is not null`; do not filter by `kind` or `archived_at`.

- [ ] **Step 4: Verify the targeted test passes**

Run: `npm --workspace @modus/desktop exec -- vitest run --root ../.. apps/desktop/src/main/agent/agent-store.test.ts`
Expected: PASS.

### Task 2: Add the ownership-checked file cleanup helper

**Files:**
- Create: `apps/desktop/src/main/agent/pi-session-file-cleanup.ts`
- Test: `apps/desktop/src/main/agent/pi-session-file-cleanup.test.ts`
- Consumes: `listOtherAgentSessionPiSessionFiles(sessionId: string): string[]` from Task 1.
- Produces: `deleteOwnedPiSessionFile(session: Pick<AgentSessionInfo, "id" | "piSessionId" | "piSessionFile">): "deleted" | "preserved" | "failed"`.

- [ ] **Step 1: Write failing tests using temporary directories**

Cover successful deletion of a valid owned JSONL, missing metadata, paths outside the store and path traversal, symlinked directory/file, hard link, malformed or mismatched JSONL header, another session referencing the same path (including a symlink alias where supported), changed file identity before unlink, and unlink failure. Mock `electron.app.getPath("userData")` to a fresh `mkdtemp` directory and the reference query; clean up only the temporary directory after each test.

- [ ] **Step 2: Run the targeted tests and confirm they fail**

Run: `npm --workspace @modus/desktop exec -- vitest run --root ../.. apps/desktop/src/main/agent/pi-session-file-cleanup.test.ts`
Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the minimal safe helper**

Resolve `userData/pi-sessions`; reject a symlinked/non-directory store and any candidate that is not an absolute direct child. Use `lstat` and an `O_NOFOLLOW` open flag when available; require a regular non-symlink file with `nlink === 1`; read only the first JSONL record and require `type === "session"` and `id === piSessionId`. Check every other stored path for lexical or real-path aliasing. Compare device/inode and relevant stat identity again immediately before synchronous `unlink`. Return `"preserved"` for uncertain or missing ownership, `"deleted"` only after unlink, and `"failed"` on an unexpected filesystem/database error without exposing paths or contents.

- [ ] **Step 4: Verify the targeted tests pass**

Run: `npm --workspace @modus/desktop exec -- vitest run --root ../.. apps/desktop/src/main/agent/pi-session-file-cleanup.test.ts`
Expected: PASS, including platform-gated symlink/hard-link tests.

### Task 3: Integrate cleanup into recursive session teardown

**Files:**
- Modify: `apps/desktop/src/main/agent/session-lifecycle.ts`
- Test: `apps/desktop/src/main/agent/session-lifecycle.test.ts`
- Consumes: `deleteOwnedPiSessionFile` from Task 2.

- [ ] **Step 1: Write failing lifecycle tests**

Assert the helper is called after runtime disposal and immediately before `deleteAgentSession`; assert a `"failed"` result emits only a generic warning and does not block record deletion; assert recursive child teardown invokes cleanup for the child before its record and then for the parent.

- [ ] **Step 2: Run the targeted test and confirm it fails**

Run: `npm --workspace @modus/desktop exec -- vitest run --root ../.. apps/desktop/src/main/agent/session-lifecycle.test.ts`
Expected: FAIL because cleanup is not integrated.

- [ ] **Step 3: Integrate cleanup**

After runtime disposal and the existing session cleanup steps, call the synchronous ownership-checked helper immediately before `deleteAgentSession`. If it returns `"failed"`, log one generic warning without path or content; always continue to deleting the database record.

- [ ] **Step 4: Verify lifecycle tests pass**

Run: `npm --workspace @modus/desktop exec -- vitest run --root ../.. apps/desktop/src/main/agent/session-lifecycle.test.ts`
Expected: PASS.

### Task 4: Run final verification and commit

**Files:**
- Verify: the three test files above and the desktop TypeScript project.

- [ ] **Step 1: Run all focused tests together**

Run: `npm --workspace @modus/desktop exec -- vitest run --root ../.. apps/desktop/src/main/agent/agent-store.test.ts apps/desktop/src/main/agent/pi-session-file-cleanup.test.ts apps/desktop/src/main/agent/session-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 2: Run the desktop typecheck**

Run: `npm --workspace @modus/desktop run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Run the desktop test suite**

Run: `npm --workspace @modus/desktop test`
Expected: all desktop tests pass.

- [ ] **Step 4: Review the diff and commit**

Check `git diff --check` and `git diff`; confirm only the design, plan, helper, lifecycle, and focused tests changed. Commit with `fix: safely clean up owned Pi session files`.
