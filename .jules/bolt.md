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
