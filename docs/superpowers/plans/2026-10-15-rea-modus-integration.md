# REA Default Modus Integration Implementation Plan

> **For agentic workers:** Use the OMO scheduler for bounded specialist lanes and `executing-plans` checkpoints. Do not use `subagent-driven-development`. Apply RED-GREEN-REFACTOR to each behavior change and obtain the required Oracle gate before advancing each phase. Steps use `- [ ]` checkboxes.

**Goal:** Provide REA by default in Modus with one isolated pinned REA MCP worker per agent session, two stable broker tools, normal per-call approval, and user-visible readiness/disable controls.

**Architecture:** A packaged Modus-owned process supervisor launches the pinned `npx` server and owns its descendant tree. A main-process per-session manager owns an MCP client/catalog/serialized call queue; stable `rea_tools`/`rea_call` host tools route through trusted `AsyncLocalStorage` context and never register dynamic REA operations in the process-wide MCP/tool maps.

**Tech Stack:** Electron main process; TypeScript; `@modelcontextprotocol/sdk` 1.29.0 `Client`/`StdioClientTransport`; Node child-process APIs; Rust process supervisor with Windows Job Object and POSIX process-group handling; React settings UI; Vitest; Biome.

**Spec:** `docs/superpowers/specs/2026-10-15-rea-modus-default-integration-design.md`

**Execution status (2026-10-15):** Phase 1 is complete at `86debb04`; Phase 2 is complete at `67b21880` with Oracle Gate 2 PASS. Phase 3 backend/skill and renderer implementation passed Oracle Gate 3. Focused tests, typecheck, Biome, diff check, and desktop build passed; the focused Phase 3 commit is pending. Phase 4 end-to-end acceptance remains.

## Global Constraints

- Launch only `npx -y rea-agents@6.5.0 mcp`; never use `@latest` at runtime.
- The first approved REA call may require Node/npm and network access; do not install Node/npm or analysis engines automatically.
- Default REA state is enabled at user scope; no workspace/project override and no global `mcp-service.ts` worker.
- Every REA catalog startup and operation call remains classified as dangerous `mcp.call`; no automatic allowlist.
- Derive session ID and generation from host tool context; never accept either from model arguments.
- Preserve plan/subagent restrictions and mark all REA target content/errors as untrusted data.
- One worker per logical Modus agent session; serialize calls per worker; do not automatically retry uncertain operations.
- Process-tree termination is a release gate. On Windows, the supervisor uses a kill-on-job-close Job Object; on POSIX, it owns a process group. A test that only confirms the direct child exited is insufficient.
- No offline REA package bundle, no provider installation, no privileged launch, and no claim that per-session workers are a sandbox.
- Reuse existing `resources/skills`/`resources/licenses` packaging rules; do not edit OpenCode's user configuration again.

## File Map and Interfaces

**Process ownership and worker protocol**

- Create `crates/modus-rea-process-supervisor/Cargo.toml`, `src/main.rs`, `src/platform/windows.rs`, `src/platform/unix.rs`, and `tests/process_tree.rs`. This helper is the direct stdio child of the MCP SDK; it launches the fixed `npx` command, proxies stdin/stdout/stderr, and owns/terminates the launched tree.
- Modify root `Cargo.toml`, `Cargo.lock`, `apps/desktop/package.json`, and `apps/desktop/electron-builder.config.ts` to build/package the helper as `resources/bin/modus-rea-process-supervisor[.exe]` for each supported target.
- Create `apps/desktop/scripts/build-rea-supervisor.mjs` to build the helper for the current packaging platform and fail when the expected release binary is missing.
- Create `apps/desktop/src/main/mcp/rea-session-manager.ts` and `rea-session-manager.test.ts`. Reuse the SDK's public `Transport`/`Client` APIs; never access `StdioClientTransport._process`.

**Session-owned broker tools and runtime wiring**

- Create `apps/desktop/src/main/agent/tools/rea-tools.ts` and `rea-tools.test.ts` for the two stable tools.
- Modify `apps/desktop/src/main/agent/tools/tool-context.ts` to carry an internal REA session generation; modify `registry.ts` and `pi-sdk-runtime.ts` to register stable host tools, route calls, and close the correct session worker.
- Keep the session manager outside the process-wide generic MCP server map. A worker is keyed by `{ sessionId, generation }` and keeps its own MCP client, catalog, and serial call queue.
- Worker API shared across tasks:

```ts
export type ReaSessionOwner = { sessionId: string; generation: string };
export type ReaCatalogQuery = { query?: string; offset: number; limit: number };
export type ReaCatalogEntry = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type ReaCatalogPage = {
  offset: number;
  limit: number;
  total: number;
  tools: ReaCatalogEntry[];
};

export interface ReaSessionManager {
  listTools(owner: ReaSessionOwner, query: ReaCatalogQuery): Promise<ReaCatalogPage>;
  callTool(
    owner: ReaSessionOwner,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
  disposeSession(owner: ReaSessionOwner): Promise<void>;
  disposeAll(): Promise<void>;
}
```

`rea_tools` normalizes an optional search/offset/limit into `ReaCatalogQuery`; default `offset` is `0` and default `limit` is `10`, with a maximum page size of `10`. `rea_call` accepts exactly `{ operation: string, arguments: object }`. Neither tool has a `sessionId`, executable, endpoint, cwd, or env input.

**Default state and Settings UI**

- Create `apps/desktop/src/main/mcp/rea-settings.ts` and `rea-settings.test.ts`. Persist `{ "enabled": boolean }` to user-scoped `~/.modus/rea.json`; missing file/field means enabled, invalid JSON fails closed and reports a settings error. Project MCP files do not override this built-in state.
- Add typed `ReaIntegrationStatus`/`ReaSettings` contracts in `apps/desktop/src/shared/contracts-parts/contracts-part-06.ts`, channels in `src/main/ipc/channels.ts`, schemas in `src/main/ipc/schemas.ts`, validated handlers in `src/main/ipc/register-app-ipc.ts`, and preload methods in `src/preload/index.ts`/`src/preload/types.ts`.
- Add a built-in REA status/toggle/retry row to `apps/desktop/src/renderer/src/features/settings/sections/mcp.tsx`; `@designer` owns the UI and `mcpSettings.test.tsx` covers its state and controls.
- Append a clearly marked Modus adapter section to `apps/desktop/resources/skills/reverse-engineer-anything/SKILL.md`; retain the upstream body/references/license and direct Modus agents to `rea_tools`/`rea_call` and Modus-specific recovery.

## Phases, Ownership, and Gates

### Phase 1 — Session worker and owned process tree

**Owner:** `@fixer` for TypeScript/Rust implementation. **Validation owner:** orchestrator. **Gate:** Oracle plus Explorer structure scan after tests, before Phase 2. **Rationale:** a leaked descendant or incorrectly shared worker can corrupt or expose active-target state.

**Task 1.1 — Lock the process supervisor contract and prove descendant cleanup**

**Files:** Create `crates/modus-rea-process-supervisor/Cargo.toml`, `src/main.rs`, platform modules and tests. Modify root `Cargo.toml`, `apps/desktop/package.json`, and `electron-builder.config.ts`.

- [ ] Write a Rust test fixture whose supervisor launches a fake parent which starts a long-lived grandchild; record both process IDs and verify EOF/close terminates both.
- [ ] Run `cargo test -p modus-rea-process-supervisor` and confirm the child-tree test fails before implementation.
- [ ] Implement the supervisor as the direct stdio child. On Windows create a Job Object with kill-on-job-close, create the child suspended, assign it before resume, and proxy stdio. On POSIX put the child in an owned process group and terminate the group on supervisor close.
- [ ] Add Windows quoting/path-with-spaces and POSIX process-group tests; verify both known PIDs exit after normal close and forced termination.
- [ ] Add `build:rea-supervisor` (`cargo build --release -p modus-rea-process-supervisor`) and run it in the desktop `build`, `package`, `package:mac`, `package:win`, and `package:linux` scripts before Electron builds.
- [ ] Add the platform-specific helper path to `electron-builder.config.ts` `extraResources` under `bin`; check that packaged-app path resolution selects that helper rather than a workspace binary.
- [ ] Run `cargo test -p modus-rea-process-supervisor`, `npm run build:rea-supervisor` from `apps/desktop`, and the desktop typecheck.
- [ ] Commit only the supervisor/build/package files after Phase 1 Gate 1 approval.

**Task 1.2 — Implement the per-session REA MCP manager**

**Files:** Create `apps/desktop/src/main/mcp/rea-session-manager.ts` and `.test.ts`.

- [ ] Write tests proving construction/session creation launches no process, first approved catalog request launches one pinned worker, concurrent first requests share one startup, and two owners in the same workspace receive distinct workers.
- [ ] Add tests for stale generation rejection, serialized calls, page-size clamping, unknown-operation rejection, queue overflow, close-session, and close-all.
- [ ] Run `npx vitest run --root ../.. apps/desktop/src/main/mcp/rea-session-manager.test.ts` from `apps/desktop`; confirm the new tests fail before implementation.
- [ ] Implement `ReaSessionManager` using a fresh `Client` and `StdioClientTransport` per `{sessionId, generation}`. The transport command points to the packaged supervisor; the supervisor receives only the fixed `npx -y rea-agents@6.5.0 mcp` command and an allowlisted environment.
- [ ] Implement one startup promise and one serialized queue per owner; use these initial limits: 4 active workers, 4 queued calls per worker, startup timeout 180,000 ms, operation timeout 600,000 ms, catalog page maximum 10, and response maximum 256 KiB.
- [ ] If cancellation/timeout makes server state uncertain, retire that worker and return an error; do not replay the operation. If worker capacity is reached, return busy without evicting another session.
- [ ] Re-run the focused test, add a warm-cache/fake-cold-cache failure case, run typecheck and Biome, then request Gate 1.

**Phase 1 commands** (from the stated working directories):

```powershell
# From modus/apps/desktop
cargo test -p modus-rea-process-supervisor
npx vitest run --root ../.. apps/desktop/src/main/mcp/rea-session-manager.test.ts
npm run typecheck

# From modus
npx biome check apps/desktop/src/main/mcp/rea-session-manager.ts apps/desktop/src/main/mcp/rea-session-manager.test.ts
```

### Phase 2 — Stable broker tools and Pi session lifecycle

**Owner:** `@fixer`. **Validation owner:** orchestrator. **Gate:** Oracle plus Explorer structure scan after tests, before Phase 3. **Rationale:** Pi snapshots tool definitions at assembly and the broker crosses the process-wide registry/session boundary.

**Task 2.1 — Add stable broker tools and permission-safe catalog/call handling**

**Files:** Create `apps/desktop/src/main/agent/tools/rea-tools.ts` and `.test.ts`; modify `apps/desktop/src/main/agent/tools/registry.ts` only for explicit `mcp.call` classification if needed.

- [ ] Write tests for `rea_tools({query, offset, limit})` and `rea_call({operation, arguments})`; assert neither input accepts or consumes `sessionId`, executable, endpoint, cwd, or env.
- [ ] Assert catalog search/page bounds, unknown operation rejection, `Value.Check` against the advertised input schema, and rejection of oversized arguments before any MCP call.
- [ ] Assert both broker tools classify as dangerous `mcp.call`, remain chat-only, and do not gain safety from REA annotations.
- [ ] Run `npx vitest run --root ../.. apps/desktop/src/main/agent/tools/rea-tools.test.ts`; confirm red before implementation.
- [ ] Implement the stable definitions once. Resolve `ReaSessionOwner` through trusted `tool-context` only; pass `{operation, arguments}` through the existing approval target and call the session manager only after approval.
- [ ] Add a bounded result converter that preserves `content`, `_meta`, and `structuredContent`, caps result bytes, marks truncation, and frames target text/errors as untrusted data.
- [ ] Re-run tests and Biome.

**Task 2.2 — Route stable tools through each Pi session and close only its worker**

**Files:** Modify `apps/desktop/src/main/agent/tools/tool-context.ts`, `src/main/agent/pi-sdk-runtime.ts`, and `src/main/agent/pi-sdk-runtime.test.ts`.

- [ ] Write Pi runtime tests for two live sessions in the same cwd receiving different worker generations and different REA results; assert no global ToolRegistry revision changes when either catalog changes.
- [ ] Write tests for fresh assembly, resume, harmless tool-definition rebuild, pane `releaseRuntime()` preservation, logical `dispose()` teardown, workspace relocation, parent/subagent teardown, application shutdown, missing context, and stale tool approval after disposal.
- [ ] Run the named tests in `pi-sdk-runtime.test.ts` with `npx vitest run --root ../.. apps/desktop/src/main/agent/pi-sdk-runtime.test.ts -t 'REA per-session tools' --testTimeout 20000`; confirm red before implementation.
- [ ] Store a host-generated `reaGeneration` in a PiRuntime-level map keyed by persistent session ID, not only in the SDK cache. Preserve it across `releaseRuntime()` and `disposeSessionOnly()` rebuilds; rotate it on workspace relocation; delete it after logical `dispose()`/session deletion.
- [ ] Register the host tools before Pi session assembly, expose them only to the build/chat profile, and keep plan/subagent permissions unchanged.
- [ ] Keep the manager entry across pane `releaseRuntime()`; dispose only on logical `dispose()`/session deletion, workspace relocation, disable/configuration change, or app shutdown. A late startup with an obsolete generation closes instead of publishing a worker.
- [ ] Ensure `rea_tools`/`rea_call` wrappers report disabled/unavailable state without starting a process when settings are off or context is stale.
- [ ] Run both test files, typecheck, and Biome; request Gate 2.

**Phase 2 commands** (from `apps/desktop` unless noted):

```powershell
npx vitest run --root ../.. apps/desktop/src/main/agent/tools/rea-tools.test.ts
npx vitest run --root ../.. apps/desktop/src/main/agent/pi-sdk-runtime.test.ts -t 'REA per-session tools' --testTimeout 20000
npm run typecheck
```

### Phase 3 — Default setting, status UI, and Modus skill adapter

**Owners:** `@fixer` owns settings/config/contracts/IPC/skill text; `@designer` owns the renderer row and interaction. Keep write scopes disjoint. **Validation owner:** orchestrator. **Gate:** Oracle after UI/runtime tests, before Phase 4. **Rationale:** this is the user-facing default/disable boundary and must not disguise provider or download requirements.

**Task 3.1 — Add user-scoped enablement and status API**

**Files:** Create `apps/desktop/src/main/mcp/rea-settings.ts` and `.test.ts`; modify `src/shared/contracts-parts/contracts-part-06.ts`, `src/main/ipc/channels.ts`, `src/main/ipc/schemas.ts`, `src/main/ipc/register-app-ipc.ts`, `src/preload/index.ts`, `src/preload/types.ts`, and the runtime setting check.

- [ ] Write tests proving missing `~/.modus/rea.json` defaults to `{enabled: true}`, explicit false persists, invalid JSON fails closed, and workspace config cannot override user setting.
- [ ] Add IPC tests for status sanitization, schema rejection, and `setEnabled(false)` preventing any new process launch.
- [ ] Implement atomic user-scoped persistence for `{enabled:boolean}`. Do not store provider secrets or copy values from OpenCode config. On disable, block new calls and close all REA workers; an in-flight approved operation is cancelled/retired, never retried.
- [ ] Define `ReaIntegrationStatus` with `disabled`, `not_started`, `starting`, `ready`, `needs_node`, `network_error`, and `failed`, plus sanitized provider/readiness notes; do not run `doctor` automatically. Redact stderr/paths from renderer errors and preserve provider-specific limitations reported by REA operations.
- [ ] Run `npx vitest run --root ../.. apps/desktop/src/main/mcp/rea-settings.test.ts` and IPC tests; confirm red before implementation.

**Task 3.2 — Build the built-in REA settings row**

**Files:** Modify `apps/desktop/src/renderer/src/features/settings/sections/mcp.tsx` and `src/renderer/src/features/settings/mcpSettings.test.tsx` only for the UI. `@designer` owns visual structure/copy; `@fixer` must not alter visual intent.

- [ ] Add a built-in REA row showing default-enabled state, status, first-use Node/npm/network notice, user disable/re-enable, and retry. Do not expose the external process command as an editable generic MCP entry.
- [ ] Renderer tests cover initial enabled state, disabled state, `needs_node`, `network_error`, retry, and safe failure while ordinary MCP rows remain intact.
- [ ] Run `npx vitest run --root ../.. apps/desktop/src/renderer/src/features/settings/mcpSettings.test.tsx` and Biome on the UI file.

**Task 3.3 — Add Modus-specific skill adapter instructions**

**Files:** Modify `apps/desktop/resources/skills/reverse-engineer-anything/SKILL.md`; extend `apps/desktop/src/main/agent/harness/prompt/sections/skills-section.test.ts` only if needed.

- [ ] Add a clearly separated Modus adapter section: use `rea_tools` to discover operations and `rea_call` to invoke them; use Modus status/retry/disable controls when blocked; never modify another client's MCP config from the Modus runtime.
- [ ] Preserve upstream body, references, license and provenance. Test the bundled skill still loads and contains both broker names.
- [ ] Run the harness discovery test.

- [ ] After 3.1–3.3 reconcile writer outputs, run all affected tests, typecheck and Biome, record UI handoff intent, then request Gate 3.

### Phase 4 — Integrated acceptance and final gate

**Owner:** orchestrator with focused specialist help only if failures require code changes. **Gate:** final Oracle review after evidence is recorded. **Rationale:** verify the shipped path, process ownership, permission prompt, and non-blocking failure behavior together.

- [ ] Run focused process-supervisor, manager, broker, runtime, config/IPC, MCP Settings UI, and skill-discovery Vitest suites.
- [ ] Run desktop `npm run typecheck`, `npx biome check` for changed files, and `npm run build` from `apps/desktop`.
- [ ] On Windows, use a fresh Modus session and the installed Node 24.21.0 environment to make one approved `rea_tools` catalog-only call. Confirm the first-run banner/approval states the pinned download, no target/binary operation is called, and closing the session ends the supervisor, npx, and Node descendants.
- [ ] Verify two same-workspace sessions remain isolated, disable REA, confirm new calls do not launch a worker, then re-enable and confirm a fresh worker is created.
- [ ] Record limitations: cold first use requires network; Ghidra's current Windows provider status remains limited; IDA/JADX require user installations/configuration; this is not a sandbox.
- [ ] Run Phase 4 Oracle gate and report all commands/results; do not claim unsupported provider parity.

## Deepwork execution gates

- Phase 1: `@fixer` worker/supervisor; tests; `@explorer` structure scan and `@oracle` gate in parallel; commit only Phase 1 paths after gate.
- Phase 2: `@fixer` stable broker/Pi lifecycle; tests; `@explorer` structure scan and `@oracle` gate in parallel; commit only Phase 2 paths after gate.
- Phase 3: `@fixer` backend/skill plus `@designer` renderer after the IPC contract exists; reconcile, test, then `@oracle` gate; commit only Phase 3 paths after gate.
- Phase 4: orchestrator integrates evidence, then final `@oracle` gate. Never advance while relevant writers or gates remain live.

## User-approval gate

This document is a plan, not implementation authorization. Start Phase 1 only after the user explicitly approves the plan. `rea-agents@latest setup` and the separate OpenCode registration are already complete; do not repeat or modify them as part of Modus runtime implementation.
