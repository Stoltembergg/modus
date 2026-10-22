# Safe Pi session-file deletion

## Intent

When a Modus session is permanently deleted, remove its Pi JSONL conversation file only when the app can prove that the file belongs to that session. If ownership or exclusive use is uncertain, preserve the file. This prevents deletion from touching shared, unrelated, or outside files.

## Goals

- Delete the session database records as today.
- Delete only the session's own persisted Pi JSONL file when its ownership is verifiable.
- Preserve memories, backups, files shared by surviving sessions, and anything outside the session store.
- Continue deleting the database record if safe file cleanup cannot be proven or fails.

## Non-goals

- Changing memory, backup, workspace, or checkpoint retention policy.
- Deleting exports or files in the project workspace.
- Rewriting session storage or adding a user-facing confirmation flow.

## Approved behavior and proof

A candidate file is eligible for deletion only if every check passes:

1. The stored path is absolute and resolves to a direct child of the app's canonical `userData/pi-sessions` directory.
2. The app's session directory is a real directory, not a symbolic link. The candidate is a regular file, not a symbolic link, and has a single filesystem link.
3. The first JSONL record parses as a Pi session header (`type: "session"`) whose `id` equals the session record's stored `piSessionId`.
4. No other `agent_sessions` record, including archived or group-member sessions, refers to the same canonical file.

If any check fails, the JSONL is left intact. Child sessions are deleted recursively; if a file is referenced by another session that is also being deleted, cleanup can happen only when the final referencing record is removed and the file still passes all checks.

All final checks and the unlink will run synchronously in the main process after the runtime is disposed, so another app operation cannot interleave between checking database references and removing the file. Immediately before unlink, the code will re-check the candidate's file identity against the previously opened/inspected file (device and inode where supported); if it changed or a symlink is detected, it will preserve the path. Filesystem cleanup errors will not block deletion of the session records and will emit a generic warning without file contents or sensitive path details.

## Approaches considered

- **Check only the directory:** smaller change, but a path inside the app folder could still belong to another session or be shared. Rejected because it does not prove ownership.
- **Strict ownership checks (chosen):** verify path, file type/link count, header ID, and other database references. It keeps the approved deletion scope and preserves data whenever proof is incomplete.
- **Never delete Pi JSONL files:** safest for file contents, but leaves conversation files behind on every permanent session deletion and fails the approved behavior.

## Design decisions left to implementation

- Isolate the ownership check from recursive lifecycle teardown so it can be tested with real temporary files.
- Query all stored session-file references, not just visible or unarchived chats.
- Treat cleanup as best-effort; a rejected candidate or filesystem error must not prevent the database session deletion.
- Add tests for owned files, missing/mismatched IDs, malformed headers, outside paths, symlinks, shared references, hard links, changed file identity, unlink errors, and child-session teardown. Verify path handling on supported platforms.
