## 2024-05-18 - ⚡ Bolt: Batch convert member sessions using json_each

**Learning:** When using `node:sqlite`, replacing an N+1 sequence of calls running in a transaction with a batched update using `UPDATE ... FROM json_each(?)` avoids many crossings across the JS-to-C++ boundary. While SQLite handles loops within a transaction extremely efficiently (and often finishes in negligible wall-clock time), moving to a JSON-mapped batch with chunks (e.g., of 500) reduces function call overhead.
**Action:** When a user explicitly requests batching N+1 SQLite queries, ensure the JSON string passed to `json_each` is chunked if it represents large dynamic arrays, and wrap it in a size check to avoid `json_each` syntax errors.
