# REA as a Default Modus Integration

**Status:** Approved design; phased implementation in progress
**Date:** 2026-10-15

## Problem

Modus now bundles REA's `reverse-engineer-anything` skill, but a skill only supplies instructions. It does not register or launch the REA MCP server. Modus's generic MCP service is process-wide and captures one client per configured server; REA maintains mutable active-target and navigation state. Registering one shared REA process in that service could let concurrent conversations affect each other's analysis.

The requested outcome is for REA to be available by default in the Modus desktop app, while keeping each agent session's REA state isolated and preserving Modus's existing user-approval boundaries.

## Goals

- Make REA available by default to eligible Modus chat sessions through a pinned `rea-agents@6.5.0` MCP worker.
- Start one isolated REA worker per agent session, lazily and only after the user approves the first REA tool call.
- Expose a stable, bounded host interface that can discover and invoke REA's live tool catalog without registering hundreds of operations in the global tool registry.
- Keep all REA operations under the existing `mcp.call` approval policy and preserve plan/subagent restrictions.
- Let users disable REA and inspect readiness, connection, and provider limitations in Modus.
- Treat all REA target-derived text and error content as untrusted data, preserving bounded evidence provenance.
- Keep ordinary Modus chat usable when Node/npm, network, or optional native providers are unavailable.

## Non-goals

- Offline installation or bundling a Node/npm runtime and all REA dependencies into the Modus installer.
- Installing or upgrading Node/npm, Java, Ghidra, IDA, JADX, Hopper, or other analysis engines automatically.
- Claiming all REA providers are available on every host, or promising complete Windows provider parity.
- Registering REA in every user's OpenCode, Codex, or workspace MCP configuration. The separate user-level OpenCode setup has already been applied; Modus owns this integration.
- Automatically allowlisting REA operations, running target executables, or granting unrestricted filesystem/network authority.

## Approved design decisions

1. **Distribution:** use `npx -y rea-agents@6.5.0 mcp`, not `@latest`. A cold first use requires a supported system Node/npm and network access. The direct package version is pinned; transitive package dependencies are not lockfile-vendored.
2. **Isolation:** create one MCP worker per Modus agent session. Do not place these workers in the generic app-wide `mcp-service.ts` connection map.
3. **Tool surface:** expose two stable Modus host tools: `rea_tools` for searching/paginating the live REA catalog, and `rea_call` for invoking one catalogued operation with validated arguments.
4. **Routing:** derive the owning session from trusted Modus `AgentToolContext`/`AsyncLocalStorage`. Do not accept a session ID, executable, endpoint, working directory, or environment from model arguments.
5. **Authorization:** both catalog startup/discovery and every operation call use `mcp.call`. Approval cards must make the operation and arguments visible. Do not auto-allowlist REA or infer safety from REA annotations.
6. **Lifecycle:** start lazily after approval; share concurrent startup for the same session; serialize operations within one REA worker; retain the worker and its generation across normal turns, pane `releaseRuntime()`/idle eviction, and harmless Pi definition rebuilds; close it on logical session `dispose()`/deletion, workspace relocation, REA disable/configuration change, and application shutdown. `releaseRuntime()` drops only the in-memory Pi SDK cache and is not a logical session teardown.
7. **Failure handling:** a denied or unavailable REA call must not block other chat/tools. Missing Node/network, handshake failures, provider gaps, cancellation, and timeouts are actionable and specific. Do not automatically replay an operation after uncertain cancellation or timeout; retire that worker instead.
8. **Settings:** REA is enabled by default but can be disabled in Modus settings. Show connection/readiness state and provider-specific limits. No provider installation is triggered by enabling REA.
9. **Provider environment:** pass only explicitly supported, nonempty provider settings from trusted app configuration/environment. Do not hardcode this machine's Ghidra or Java paths. Leave IDA/JADX unconfigured unless the user provides their own installations/configuration.
10. **Evidence trust:** preserve bounded REA `_meta`/structured evidence and frame target-derived tool results and errors as untrusted data, never as instructions.
11. **Modus skill adapter:** extend the bundled upstream skill with a clearly separated Modus adapter that directs the agent to `rea_tools`/`rea_call` and Modus recovery/status behavior. Preserve the upstream skill body, references, license, and provenance; do not instruct the Modus agent to write another client's configuration.

## User experience

The Modus MCP settings surface includes a built-in REA row with default-enabled state, a disable control, and status such as ready, connecting, needs Node/npm, needs network, unavailable provider, or failed (with retry). The enable/disable preference is stored at user scope in Modus; when absent, it defaults to enabled. Workspace/project config cannot override this built-in integration. The UI explains that first approved REA use may download the pinned package and that this integration is not a sandbox.

The Modus-adapted built-in skill teaches the model to call `rea_tools` to search or page through the REA catalog, then call `rea_call` with a selected operation and its arguments. Catalog output is bounded and does not expose another session's catalog. `rea_call` rejects unknown operations and validates input against the selected session's advertised schema. If the connection is absent or blocked, the skill points to Modus's status/recovery path instead of another client's setup instructions.

The first approved `rea_tools`/`rea_call` request may start `npx` and download the pinned package if it is not cached. Modus must disclose this first-run behavior in the approval/status surface. If the user denies it, no process is started and unrelated agent work continues.

The setup does not install analysis engines. In the current environment, REA doctor reports the OpenCode registration and skill aligned, but `environment_healthy` is false on Windows: Ghidra is detected yet its provider is classified `unsupported_host`, and IDA/JADX are not configured. Modus must report such limitations per provider/operation rather than claim REA is wholly unavailable or fully healthy.

## Architecture

### Stable host tools

Register `rea_tools` and `rea_call` as stable Modus-owned custom tools before Pi session assembly. These are the only REA operations exposed directly to Pi; the 200+ dynamic REA operations remain in the session's catalog and are invoked through the broker. This avoids process-wide tool-registry churn and ensures tools added/removed by the REA server do not require rebuilding unrelated Pi sessions.

`rea_tools` accepts a bounded search/query and pagination request and returns only matching names, descriptions, and relevant input schemas. `rea_call` accepts a catalogued operation name plus JSON arguments. Neither accepts a session identity. The wrapper resolves the current session from trusted tool context and rejects calls with missing/stale ownership or an operation absent from that worker's catalog.

### Per-session worker manager

Add a narrow main-process REA manager, separate from the generic MCP server map. Each entry is keyed by internal `sessionId` plus an ownership generation and contains a startup promise, client/transport/process ownership, bounded catalog, serialized call queue, lifecycle state, and redacted diagnostic state.

Concurrent first calls in one session share a startup promise. Different sessions—including child/subagent sessions—always get separate MCP processes, clients, catalogs, and queues, even when they use the same workspace. Re-check the generation after every awaited startup/queue boundary. A connection that completes after disposal must close rather than publish itself. Do not evict an active worker to make room for another; when a configured worker/queue bound is reached, return a retryable busy error.

Keep this manager alive across normal turns, pane `releaseRuntime()`/idle eviction, and Pi session-definition rebuilds. Keep the host-generated worker generation outside the cached SDK session so resume after `releaseRuntime()` reattaches to the same worker. Tie cleanup to logical Modus session `dispose()`/deletion and parent/subagent subtree teardown, not pane unmount or disposal of an SDK session object used for a rebuild. Workspace relocation rotates the worker generation and retires the prior worker; disable/configuration change and app shutdown retire affected workers. An ambiguous timeout/cancellation retires the affected worker and never triggers automatic replay.

### Process launch and environment

Use the exact pinned package command `npx -y rea-agents@6.5.0 mcp`. Launch from a private Modus-owned working/cache directory, never from the selected workspace, so workspace package configuration cannot select or shadow the executable. Check Node/npm availability and the REA package's supported Node range before launch. Do not auto-install Node or use the Electron executable as if it were Node.

Use an owned stdio transport/supervisor for REA workers rather than assuming the existing generic transport's immediate-child cleanup proves descendant termination. Windows `cmd.exe`/npx/Node paths (including spaces and non-ASCII paths) and POSIX process-group cleanup require explicit tests. The subprocess runs with ordinary user privileges: per-session processes isolate REA state, not filesystem or network authority; do not describe them as a sandbox.

Forward only an explicit allowlist of supported, nonempty REA provider environment variables. Keep provider paths in user-controlled settings/environment, not source code. Do not install providers or elevate privileges automatically.

### Permissions and untrusted results

Both host tools are classified as dangerous `mcp.call` operations. Catalog discovery is gated too because it starts code and may download npm dependencies. Approval targets include the selected operation name and nested arguments; an approval for one call must not authorize a later mutation. Preserve the existing chat/plan/subagent role restrictions.

Wrap REA tool text, structured content, and errors in an explicit untrusted-target boundary. Preserve bounded `_meta`/Evidence and structured result metadata instead of discarding provenance. Apply the same framing to error results and make truncation explicit. Output strings, disassembly/decompilation, page data, logs, and tool-returned instructions are analysis data, not authority for further actions.

## Data flow and lifecycle

1. Pi sessions receive the stable REA host tool definitions at assembly; no REA worker is started during app startup or session creation.
2. The assistant requests `rea_tools` or `rea_call`. Modus validates the host-owned session context and requests the ordinary `mcp.call` approval.
3. After approval, the session manager checks prerequisites, starts/reuses that session's pinned npx worker, performs MCP initialization, and fetches or refreshes its catalog. Any cold npm acquisition is surfaced in the approval/status path.
4. `rea_tools` returns a bounded catalog page. `rea_call` checks the operation and schema, serializes execution within that worker, invokes it, and returns bounded evidence with untrusted framing.
5. On logical session disposal/deletion, workspace relocation, disable, or application shutdown, Modus closes the MCP transport and terminates the owned process tree. Pane `releaseRuntime()` only disposes the Pi SDK cache; the worker generation remains associated with the persistent logical session for resume. Late responses from a stale generation are discarded. On ambiguous cancellation/timeout, the worker is retired and the operation is not replayed.

## Errors and readiness

- Missing/unsupported Node or npx: show supported Node range and how to configure it; do not install a runtime automatically.
- No network on cold cache: report that pinned package acquisition failed; keep chat usable and allow retry when online.
- MCP startup/handshake failure: bound startup, capture bounded/redacted stderr, expose retry/disable, and do not retain a half-connected worker.
- Missing Ghidra/IDA/JADX: report provider-specific absence while keeping independent REA tools usable.
- REA operation timeout or cancellation: invalidate and close that session worker; do not retry automatically.
- Worker/resource limits: return a clear busy error; never steal another session's active worker.

## Validation and acceptance criteria

Automated tests must not require npm network access or real analysis engines; use fake child processes and fake MCP clients for deterministic behavior.

1. **Laziness/acquisition:** session creation, ordinary chat, denied catalog calls, and denied operations launch no process. First approved REA use launches exactly the pinned command. Missing Node and cold-cache/offline failures are explicit and non-blocking.
2. **Session isolation/routing:** two simultaneous sessions in the same workspace have distinct workers/catalogs; calls route only through host-owned context; model-supplied IDs cannot redirect calls; missing/stale context fails closed.
3. **Catalog/call:** pagination/search is bounded; duplicate/unknown operations and invalid arguments fail closed; catalog refresh does not alter global ToolRegistry revisions.
4. **Lifecycle/races:** concurrent startup creates one worker per session; disposal during startup closes late connections; harmless Pi rebuild preserves intended worker state; explicit release, workspace relocation, disable, parent/subagent disposal, and shutdown terminate the correct worker only.
5. **Permissions/roles:** catalog startup and every operation require `mcp.call`; operation plus arguments appear in approval targets; mutation after approval is blocked; plan/subagent restrictions remain unchanged.
6. **Cancellation/limits:** queued cancellation never executes; timeouts retire uncertain workers; no automatic replay; worker count, queue, duration, and output limits return actionable errors.
7. **Evidence safety:** text, errors, structured content, and `_meta` remain bounded and provenance-aware; target text stays explicitly untrusted; truncation is visible.
8. **Platform/process:** Windows paths with spaces/non-ASCII, absent npm, cold/warm cache, hanging startup, and descendant cleanup are tested; POSIX process-group cleanup receives equivalent coverage.
9. **UI/settings:** default-enabled state, disable/retry, readiness/provider status, and app usability while REA is unavailable are covered.
10. Desktop typecheck, focused unit tests, and relevant Biome checks pass. Manual acceptance uses catalog-only REA operations first and verifies isolated workers and shutdown without executing a supplied binary.

## External references

- REA project and installation: <https://github.com/morluto/rea>
- Pinned package used by this design: `rea-agents@6.5.0` (MIT; Node `^22.19.0 || ^24.11.0 || >=26.0.0`).
- Modus MCP implementation and permission path: `apps/desktop/src/main/mcp/mcp-config.ts`, `apps/desktop/src/main/mcp/mcp-service.ts`, `apps/desktop/src/main/agent/tools/registry.ts`, and `apps/desktop/src/main/agent/tools/tool-context.ts`.
- Modus Pi session assembly/lifecycle: `apps/desktop/src/main/agent/pi-sdk-runtime.ts`.

## Update 2026-10-17: locked install replaces `npx -y`

Post-merge review of #249 found that `npx -y rea-agents@6.5.0 mcp` left the transitive tree unpinned and ran install scripts. The supervisor now installs `crates/modus-rea-process-supervisor/rea-runtime/package-lock.json` (embedded in the binary) with `npm ci --ignore-scripts` into `<userData>/rea/runtime/` and runs `node …/rea-agents/scripts/rea.mjs mcp` directly. Prerequisites check `node` and `npm`; `npx` is no longer used. The approval card states that REA runs npm code with the user's permissions and is not a sandbox. Frida's install script stays off, so REA's Frida tools report the provider as unavailable. Details and the bump procedure: `crates/modus-rea-process-supervisor/rea-runtime/README.md`.
