
## 2026-10-25 - Use async file operations for files panel
**Learning:** Partially converting synchronous file operations in Node.js (e.g. `readFileSync` to `readSync`) still blocks the event loop because the underlying execution remains synchronous. True non-blocking IO requires asynchronous equivalents (like `fs/promises`). Additionally, when dealing with legacy codebase test suites, unrelated test failures may arise when executing the full suite; verify changes in isolation and do not expand commit scope beyond the targeted files.
**Action:** When optimizing synchronous file IO for performance, always migrate entirely to `fs/promises` (`open`, `stat`, `read`, etc.) and ensure appropriate Promise chaining with resource cleanup in `finally` blocks.
