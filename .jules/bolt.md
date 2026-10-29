
## 2023-10-26 - Optimize batched SQLite updates in groups migration
**Learning:** In SQLite, instead of constructing a dynamic `IN (?, ?, ...)` clause for multiple updates in batches (which requires array mapping and string interpolation), it is significantly faster to pass a single JSON array string as a parameter and use `UPDATE ... FROM json_each(?) j WHERE id = j.value`. However, performance fixes should focus on frequent application paths rather than one-time migration scripts unless the cost is significant.
**Action:** Identify the most frequently used pathways (e.g., chat loading) and use `json_each` for batch updates if appropriate, ensuring to profile and benchmark the specific change before application.
