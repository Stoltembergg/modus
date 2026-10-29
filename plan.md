1. **Optimize `saveCapabilities`**
   - Replace the loop `insStmt.run(...)` inside `apps/desktop/src/main/agent/harness/plugin/plugin-state-store.ts` with `INSERT INTO plugin_capabilities (plugin_id, capability_id, api_version) SELECT ?, json_extract(value, '$.capability'), json_extract(value, '$.apiVersion') FROM json_each(?)`.
2. **Verify modifications**
   - Use `read_file` on `apps/desktop/src/main/agent/harness/plugin/plugin-state-store.ts` to confirm the SQL query replacements were written correctly.
3. **Verify and measure**
   - Run the full test suite (`npm run test`), and run linters/typechecks (`npm run check`).
4. Complete pre-commit steps to ensure proper testing, verification, review, and reflection are done.
5. **Submit the change**
