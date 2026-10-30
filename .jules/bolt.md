## 2025-02-12 - Bolt: Batch profile name resolution queries

**Learning:** When generating multiple consecutive SQLite UPDATEs sequentially on a unique key, doing so synchronously creates N+1 latency problems due to overhead, especially with db.prepare(...).run().
**Action:** Accumulate modifications in memory in a map and perform batch JSON-driven parameterized UPDATEs: update [table] set [column] = j.value from json_each(?) j where [table].id = j.key.
