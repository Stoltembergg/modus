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
