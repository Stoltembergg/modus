## 2024-05-17 - ReadFileSync Event Loop Block
**Learning:** `readFileSync` reads the entire file synchronously, even when we truncate the result later using `subarray`. For big workspace files (e.g. 50MB log files), this will pause the node event loop for hundreds of ms, causing noticeable UI stuttering via the IPC bottleneck.
**Action:** Always allocate exactly the bytes needed via `fs.openSync`, `fs.readSync`, and `fs.closeSync` for workspace files accessed via `files-service`.
