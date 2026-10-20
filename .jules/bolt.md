## 2024-05-17 - ReadFileSync Event Loop Block
**Learning:** `readFileSync` reads the entire file synchronously, even when we truncate the result later using `subarray`. For big workspace files (e.g. 50MB log files), this will pause the node event loop for hundreds of ms, causing noticeable UI stuttering via the IPC bottleneck.
**Action:** Always allocate exactly the bytes needed via `fs.openSync`, `fs.readSync`, and `fs.closeSync` for workspace files accessed via `files-service`.

## 2023-10-20 - ReadFileSync Event Loop Block for Previews
**Learning:** `readFileSync` reads the entire file synchronously. For large preview payloads up to 50MB, this blocks the Node.js event loop for tens of milliseconds, halting IPC communication and freezing the UI.
**Action:** Use asynchronous file reading (`fs.promises.open()` and `handle.read()`) when reading large workspace files (like previews) to avoid blocking the event loop.
