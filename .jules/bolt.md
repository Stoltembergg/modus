## 2026-10-29 - Optimize SQLite inserts using json_each batching
**Learning:** When fixing N+1 SQLite queries (inserts or updates) in Node.js with \`node:sqlite\`, passing a JSON-stringified array of objects to a single parameterized query utilizing \`INSERT INTO ... SELECT ... FROM json_each(?)\` or \`UPDATE ... FROM json_each(?)\` is an excellent way to reduce query latency by over 20-30% compared to executing statements individually in a loop (even when inside an explicit transaction). However, when batching inserts in this way, uncommitted memory rows in the batch are not immediately visible to \`SELECT\` checks against the database inside the same loop. For example, if a unique naming constraint uses \`SELECT 1 FROM table WHERE name = ?\`, it will fail to see newly assigned names.
**Action:** When batching inserts that rely on uniqueness checks based on the database state, always maintain a local memory construct (e.g., a \`Set\` of taken names) to track newly added elements during the loop before they are committed, ensuring the uniqueness invariant holds true.
## 2024-05-17 - ReadFileSync Event Loop Block
**Learning:** `readFileSync` reads the entire file synchronously, even when we truncate the result later using `subarray`. For big workspace files (e.g. 50MB log files), this will pause the node event loop for hundreds of ms, causing noticeable UI stuttering via the IPC bottleneck.
**Action:** Always allocate exactly the bytes needed via `fs.openSync`, `fs.readSync`, and `fs.closeSync` for workspace files accessed via `files-service`.

## 2023-10-19 - [Bolt: Optimize readWorkspacePreview]
**Learning:** `readFileSync` blocks the event loop in the main Electron process for long durations (e.g. 5+ seconds for repeated reads of a 50MB file).
**Action:** Use `fs/promises` (`readFile` and `stat`) for large file I/O such as `readWorkspacePreview`.
- When using SQLite IN clauses with dynamic arrays (via node:sqlite), chunk the arrays into smaller batches (e.g., 500 items) to safely bypass SQLite's bound variable limitations.

## 2025-02-27 - [Batch Group Task Branch Updates]
**Learning:** SQLite `UPDATE ... FROM json_each(?)` is highly effective for removing N+1 update loops on modern `node:sqlite`. We observed query count going from N to 1 and runtime halving in benchmarks.
**Action:** Look for loops over `.run()` and replace them with a `json_each` update when mapping IDs to shared update values.
## 2026-10-22 - [Memoize sidebar session grouping]\n**Learning:** Recomputing grouped and filtered lists of sessions (like `groupSessionsByWorkspace`) on every render can cost significant time (e.g. 0.9ms per render for 5000 sessions). `useMemo` avoids this, but you must ensure any helper functions or derived filter criteria used in the `useMemo` block don't trigger unnecessary re-renders. Inline simple closures or wrap complex dependencies.\n**Action:** Use `useMemo` for expensive list filtering and grouping operations in React, ensuring minimal and stable dependencies. Never leak un-memoized expensive operations into the render path of frequently updated components.

## 2025-02-12 - [Bolt: Optimize group mailbox ackMany batching]
**Learning:** When fixing N+1 SQLite update/insert queries in Node.js with node:sqlite, instead of iterating over array items and running `.get()`, `.run()` individually inside a loop, it's significantly faster to fetch the validation rows via a single `SELECT ... WHERE id IN (SELECT value FROM json_each(?))` using a JSON-stringified array. Subsequent `INSERT` or `UPDATE` logic should also leverage `... FROM json_each(?)` with the parsed valid IDs to apply updates in bulk, yielding over 15x performance improvements.
**Action:** Use `json_each` for batch fetching and batched writing of dynamic arrays when interacting with SQLite.

## 2024-10-24 - Async File Service
**Learning:** Using `fs.readSync` instead of `fs.readFileSync` does not prevent blocking the Node.js event loop on large file reads; it simply avoids loading the entire file into a single Buffer/string payload. Real non-blocking requires `node:fs/promises`. A 100MB file read via `readSync` blocked the main process event loop for ~98ms.
**Action:** When performing file system operations in the Electron main process, strongly prefer asynchronous methods (`node:fs/promises`) for operations that can be arbitrarily large to keep the UI smooth and event loop unblocked.

## 2024-10-24 - Modus PTY Host Flake
**Learning:** `modus-pty-host` test `shutdown_keeps_group_ownership_after_the_pty_leader_exits` can flake with "shutdown lost the descendant after its PTY leader exited". This seems to be an existing race condition where the process group can sometimes be prematurely killed before the `Shutdown` command explicitly targets it. It only flakes under high concurrency or particular CI timing.
**Action:** Unrelated CI failures in native modules outside the target scope should be recorded as pre-existing flakes when they cannot be cleanly addressed.

## 2026-10-29 - [Bolt: Optimize plugin capabilities insertion]
**Learning:** SQLite `INSERT ... SELECT ... FROM json_each(?)` is highly effective for removing N+1 insert loops on modern `node:sqlite`. I observed an N+1 loop using `.run()` for inserting `plugin_capabilities` inside `apps/desktop/src/main/agent/harness/plugin/plugin-state-store.ts` which I fixed.
**Action:** Look for loops over `.run()` and replace them with a `json_each` insert/update when writing array elements to the database in bulk.

## 2026-10-27 - Sidebar Sessions grouping overhead
**Learning:** Measured the performance of the React rendering derivation for `sessionsByWorkspace`, `pinnedSessions`, and `ungroupedSessions` in `Sidebar.tsx`. For an extreme case of 5,000 active sessions, repeating the calculation 100 times took only ~420ms (meaning ~4.2ms per render). For a more typical user with a few hundred sessions, this calculation is consistently well under 1ms per render.
**Action:** Do not forcefully introduce `useMemo` optimizations in UI components unless the derivation cost actually hits a noticeable threshold. The current structure is not a relevant bottleneck.
