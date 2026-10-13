# Plan Mode

Build and Plan are the active execution modes. Spec and the HyperPlan critic/revision pipeline have been removed from the UI, preload API, IPC registration and runtime guidance.

Plan reuses the read-only tool profile. Complex plans can include structured requirements, acceptance criteria and linked steps through the existing `plan_write` schema. New criteria remain pending; the model cannot manufacture check evidence. The prompt asks for researched contracts, dependencies, milestones, validation, risk handling and rollback proportional to the task.

Approving a plan uses `agent:start-plan-build`. Main validates the trusted renderer, current owner incarnation, writable session, workspace ownership, exact source fingerprint and the existing user-turn model selection. The retained build-start ledger deduplicates requests and reserves the session through the run lifecycle. Failure, cancellation and QA rules remain authoritative in `PiSdkRuntime`.

Persisted `PlanRef.spec` data and historic evidence remain compatible. Legacy Spec composer drafts are normalized to Plan during update restoration; no plan or QA history is deleted.

MCP progress carries the server and tool identity from the host registry into agent events. The live status uses that identity, never identities supplied in tool arguments. Its centered position and translucent surface remain independent of transcript layout.

These changes do not enable external plugins or establish any new kernel-isolation guarantee. Plan quality is guided and structured, not certified by an additional model review.

## Validation in the remote workspace

- The affected runtime/UI regression set passed: 418 tests across 15 files. RED/GREEN demonstrated Plan structured metadata, mode cycling, MCP labels, status placement, approval concurrency, model ownership and read-only history protection.
- `npm run check` passed (Biome and TypeScript). Biome reported 309 warnings and 42 infos; no rules were disabled. Static workflow authorization gates passed 2 tests; site tests passed 5 tests.
- The complete desktop suite with the existing CI security filter finished with 4,820 passed, 8 failed and 9 skipped tests across 440 files. All eight failing cases were reproduced independently on the unmodified baseline `d2afeab`: two real-project OAuth cases (`ECONNREFUSED`), five Chrome measurement/verifier cases (undefined measurements), and one Composio connectivity fixture timeout. No benchmark or timeout was changed.
- The initial unfiltered `npm test` invocation was interrupted when the missing safety filter was identified. It produced no complete test report; there is insufficient evidence to establish which blocked cases it reached. The subsequent complete run used the exact authorized CI exclusion pattern.
- The first Electron/Vite build compiled main and preload, then hit Node's default 2 GiB heap ceiling in the renderer. The build passed with a 4 GiB compiler heap; this does not change application or worker resource policy. The renderer was rebuilt after the final navigation guard correction.

The full desktop run preceded the final one-line cache-retention correction for navigation during plan approval. That case demonstrated RED/GREEN; the final UI set passed all 11 tests, followed by fresh `npm run check` and production Electron/Vite builds. No second complete desktop-suite run was performed.
