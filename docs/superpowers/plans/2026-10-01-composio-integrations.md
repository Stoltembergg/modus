# Composio Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-first Integrations settings page where each Modus profile can connect Composio toolkits, choose one account and explicit operations per toolkit, and expose only those operations to agents through the existing MCP permission bridge.

**Architecture:** A main-process Composio service owns the SDK client, encrypted Project API Key, local profile policy, hosted session, and connection lifecycle. A separate internal MCP registration path exposes only the exact selected tools to chat and stays independent of workspace `mcp.json`; validated IPC and a settings panel provide the user flow.

**Tech Stack:** Electron 42, TypeScript, React, Zod, `@composio/core` (at least 0.19.1), `@modelcontextprotocol/sdk`, Electron `safeStorage`, Vitest, npm workspaces.

**Spec:** [`docs/superpowers/specs/2026-10-01-composio-integrations-design.md`](../specs/2026-10-01-composio-integrations-design.md)

## Global Constraints

- Users supply their own Composio Project API Key; V1 adds no Modus backend, Modus login, shared key, or cross-device synchronization.
- Encrypt the key with Electron's asynchronous `safeStorage`; if encryption is unavailable, do not persist plaintext or activate Composio.
- Scope Composio accounts to one stable opaque ID for the local Modus profile.
- Support up to five accounts per toolkit; the user selects exactly one account per toolkit for agent execution.
- A toolkit is agent-visible only when it is connected, enabled, has a selected active account, and has at least one explicitly selected operation.
- Every Composio tool call remains on the existing `mcp.call` permission path and is registered only for the `chat` profile.
- Use `DIRECT_TOOLS`, `mcp: true`, explicit toolkit/tool allowlists, disabled remote sandbox and Composio meta-tools, and disabled Composio multi-account session mode.
- Do not create an agent execution session without at least one selected operation; when the last operation is removed, unregister locally and delete the remote session.
- Never omit an allowlist or fall back to Composio's unrestricted catalog default. Every session update sends the complete `toolkits`, `tools`, and `connectedAccounts` maps because Composio replaces those maps.
- Keep `@composio/core` at or above 0.19.1 for safe empty-allowlist updates; because 0.19.1 is not published, install the first available stable release satisfying that minimum (`^0.20.0`) and record the exact resolution in `package-lock.json`.
- Keep generic MCP separate. Do not write Composio endpoints or headers to `mcp.json`, renderer state, logs, telemetry, or tool metadata.
- Keep the API key, session MCP URL, and session MCP headers in the main process; provider credentials remain with Composio.

## Scoped-Key Validation Note

The current Composio SDK/API documentation does not describe a non-mutating check that proves every scoped-key write permission. Key entry validates project access through read operations, so a key with read access but missing write scopes can pass that check and replace the saved key. Preserve the prior key when read validation fails; if the first explicit account/session write is denied, show the missing capability and recovery steps, and do not claim that write permissions were validated. Do not create a hidden account or execution session only to probe a write scope.

## File Map

- `apps/desktop/src/main/composio/composio-secret-store.ts`: encrypted Project API Key persistence.
- `apps/desktop/src/main/composio/composio-profile-store.ts`: local profile ID, session ID, selected accounts, aliases, and tool policies.
- `apps/desktop/src/main/composio/composio-api.ts`: typed adapter around the Composio TypeScript SDK and sanitized domain records.
- `apps/desktop/src/main/composio/composio-service.ts`: key, catalog, account, and connection lifecycle orchestration.
- `apps/desktop/src/main/composio/composio-session-sync.ts`: deterministic session policy construction, reconciliation, and fail-closed synchronization.
- `apps/desktop/src/main/mcp/mcp-service.ts`: internal Composio MCP connection/registration path, isolated from workspace MCP configuration.
- `apps/desktop/src/shared/contracts-parts/contracts-part-09.ts` and `apps/desktop/src/shared/contracts.ts`: renderer-safe Composio DTOs.
- `apps/desktop/src/main/ipc/channels.ts`, `apps/desktop/src/main/ipc/composio-ipc.ts`, and `apps/desktop/src/main/ipc/register-app-ipc.ts`: validated Composio IPC handlers.
- `apps/desktop/src/preload/types.ts` and `apps/desktop/src/preload/index.ts`: typed `window.modus.composio` API.
- `apps/desktop/src/renderer/src/features/settings/settings-types.ts`, `settingsNav.ts`, `SettingsPanel.tsx`, and `sections/integrations.tsx`: Integrations navigation and UI.
- `apps/desktop/src/main/index.ts`: asynchronous initialization and shutdown wiring.
- `docs/integrations/composio.md`: setup, least-privilege permissions, key handling, and troubleshooting.
- `apps/desktop/package.json` and root `package-lock.json`: Composio SDK dependency.

## Review Focus

1. Empty or stale toolkit/tool/account policies must never expose Composio's unrestricted catalog or select the newest account implicitly. Test in `composio-session-sync.test.ts` that an empty policy deletes the session, complete maps pin only the selected account, and unrelated tools never register.
2. Concurrent settings changes must not restore an older allowlist after a newer disable or account switch. Test in `composio-session-sync.test.ts` that serialized/version-checked updates leave only the latest policy active.
3. Missing OS encryption, corrupt ciphertext, and invalid replacement keys must preserve the prior valid key; scoped-key write denial must remain redacted and actionable even though reads succeeded. Test in `composio-secret-store.test.ts` and `composio-service.test.ts`.
4. Canceled, expired, late, or foreign-profile connection results must not become agent-visible, and the five-account cap must include pending links. Test in `composio-service.test.ts`.
5. An MCP response over the existing 500-tool cap or missing an explicitly selected tool must register no partial set. Test in `mcp-service.test.ts`.

---

### Task 1: Add encrypted key and profile-policy stores

**Files:**
- Create: `apps/desktop/src/main/composio/composio-secret-store.ts`
- Test: `apps/desktop/src/main/composio/composio-secret-store.test.ts`
- Create: `apps/desktop/src/main/composio/composio-profile-store.ts`
- Test: `apps/desktop/src/main/composio/composio-profile-store.test.ts`

**Interfaces:**
- Produces `createComposioSecretStore({ userDataPath, safeStorage })` with `load(): Promise<string | undefined>`, `save(apiKey: string): Promise<void>`, and `clear(): Promise<void>`.
- Produces `ComposioProfileConfig = { version: 1; profileId: string; sessionId?: string; toolkits: Record<string, { enabled: boolean; selectedToolSlugs: string[]; selectedAccountId?: string; aliases: Record<string, string> }> }`; `createComposioProfileStore({ userDataPath })` exposes `load(): ComposioProfileConfig`, `save(config: ComposioProfileConfig): void`, and `update(updater: (current: ComposioProfileConfig) => ComposioProfileConfig): ComposioProfileConfig`.
- Consumes Electron async `safeStorage.isAsyncEncryptionAvailable()`, `encryptStringAsync`, and `decryptStringAsync`; honor `shouldReEncrypt` by retrying decryption once and fail closed if the result still requests re-encryption. Store adapters accept injected dependencies so tests need no live Electron app.

- [x] **Step 1: Write key-store tests** proving encrypted bytes are persisted instead of the supplied key, the key decrypts after reload, unavailable encryption rejects without creating a file, corrupt ciphertext fails closed, and clearing removes the encrypted file.
- [x] **Step 2: Run the new key-store tests and verify they fail** because the store module/exports do not exist.

Run from the repository root: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/composio/composio-secret-store.test.ts`

Expected: FAIL on missing module or exports.

- [x] **Step 3: Implement `createComposioSecretStore()`** under `app.getPath("userData")/composio/`; write only safeStorage ciphertext using an atomic temp-file rename and restrictive file mode, and never fall back to plaintext.
- [x] **Step 4: Write profile-store tests** proving first load creates an opaque ID, later loads preserve it, policies/aliases/session ID survive reload, and malformed JSON is rejected without returning an unrestricted default.
- [x] **Step 5: Run the profile-store tests and verify they fail** on the missing profile-store implementation.

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/composio/composio-profile-store.test.ts`

Expected: FAIL on missing module or exports.

- [x] **Step 6: Implement `createComposioProfileStore()`** with schema-validated JSON persistence and a `crypto.randomUUID()` profile ID; preserve an explicit empty policy as empty.
- [x] **Step 7: Run both store test files and verify they pass.**
- [x] **Step 8: Commit** as `feat(composio): add encrypted key and profile stores`.

### Task 2: Add Composio SDK adapter and shared DTOs

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`
- Create: `apps/desktop/src/main/composio/composio-api.ts`
- Test: `apps/desktop/src/main/composio/composio-api.test.ts`
- Create: `apps/desktop/src/shared/contracts-parts/contracts-part-09.ts`
- Modify: `apps/desktop/src/shared/contracts.ts`

**Interfaces:**
- Produces renderer-safe `ComposioSettingsState`, `ComposioToolkitSummary`, `ComposioToolSummary`, `ComposioAccountSummary`, `ComposioConnectionOperation`, `ComposioUserError`, and inputs for connection, policy, rename, and disconnect.
- `ComposioSettingsState` is `{ apiKeyConfigured: boolean; status: "unconfigured" | "loading" | "ready" | "error"; toolkits: ComposioToolkitSummary[]; error?: ComposioUserError }`.
- `ComposioToolkitSummary` is `{ slug: string; name: string; description?: string; accounts: ComposioAccountSummary[]; enabled: boolean; selectedAccountId?: string; selectedToolSlugs: string[] }`; `ComposioToolSummary` is `{ toolkitSlug: string; slug: string; name: string; description?: string; riskHint?: string }`.
- `ComposioAccountSummary` is `{ id: string; toolkitSlug: string; alias: string; status: "active" | "pending" | "failed" | "expired" | "revoked" | "disabled" | "unknown" }`; `ComposioConnectionOperation` is `{ id: string; toolkitSlug: string; alias: string; status: "pending" | "active" | "failed" | "expired" | "canceled"; error?: ComposioUserError }`; `ComposioUserError` is `{ code: string; message: string; retryable: boolean }`.
- `ComposioToolkitPolicyInput` is `{ toolkitSlug: string; enabled: boolean; selectedToolSlugs: string[]; selectedAccountId?: string }`; `ComposioStartConnectionInput` is `{ toolkitSlug: string; alias: string }`; `ComposioRenameAccountInput` is `{ toolkitSlug: string; accountId: string; alias: string }`; and `ComposioDisconnectAccountInput` is `{ toolkitSlug: string; accountId: string }`.
- No shared DTO includes the key, endpoint URL, headers, raw SDK objects, provider tokens, or raw connection links.
- Main-process records are `ComposioToolkitRecord { slug: string; name: string; description?: string }`, `ComposioToolRecord { slug: string; name: string; description?: string; riskHint?: string }`, `ComposioAccountRecord { id: string; toolkitSlug: string; alias?: string; status: string }`, and `ComposioAuthConfigRecord { id: string; isComposioManaged: boolean; authScheme: string }`.
- `ComposioConnectionRequest` is `{ id: string; redirectUrl: string; waitForConnection(timeoutMs: number): Promise<ComposioAccountRecord> }`.
- `ComposioSessionConfig` is `{ toolkits: { enable: string[] }; tools: Record<string, { enable: string[] }>; connectedAccounts: Record<string, string[]>; sessionPreset: SessionPreset.DIRECT_TOOLS; mcp: true; sandbox: { enable: false }; manageConnections: { enable: false }; multiAccount: { enable: false; requireExplicitSelection: false } }`.
- Produces a `ComposioApi` port with return types: `validateProjectReadAccess(profileId: string): Promise<void>`, `listToolkits(): Promise<ComposioToolkitRecord[]>`, `listTools(toolkitSlug: string): Promise<ComposioToolRecord[]>`, `listAuthConfigs(toolkitSlug: string): Promise<ComposioAuthConfigRecord[]>`, `createManagedAuthConfig(toolkitSlug: string): Promise<ComposioAuthConfigRecord>`, `listAccounts(profileId: string, toolkitSlug?: string): Promise<ComposioAccountRecord[]>`, `linkAccount(input: { userId: string; authConfigId: string; alias: string; allowMultiple: true }): Promise<ComposioConnectionRequest>`, `deleteAccount(accountId: string): Promise<void>`, `createSession(userId: string, config: ComposioSessionConfig): Promise<ComposioSession>`, `useSession(sessionId: string): Promise<ComposioSession>`, and `deleteSession(sessionId: string): Promise<void>`.
- `ComposioSession` exposes only `id: string`, `configVersion: number`, `mcp: { url: string; headers?: Record<string, string> }`, and `update(config: ComposioSessionConfig, expectedConfigVersion?: number): Promise<void>`; map the SDK's `sessionId` to `id` and reject a missing `configVersion` or MCP headers. For SDK updates, omit create-only `sessionPreset` and `mcp`, merge `expectedConfigVersion` into a cloned mutable config, and call `session.update(updateConfig)` (the SDK expects the version field in the config, not as a second request-options argument). This type stays in the main process.

- [x] **Step 1: Write adapter tests** proving account listing always uses the supplied local profile ID, `linkAccount` calls `connectedAccounts.link()` with the requested alias and `allowMultiple: true`, and public mappers discard token/auth-state fields from toolkit, tool, and account records.
- [x] **Step 2: Run the adapter tests and verify they fail** because the API port and DTOs do not exist.

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/composio/composio-api.test.ts`

Expected: FAIL on missing module or exports.

- [x] **Step 3: Add `@composio/core` at `^0.20.0`** with `npm install --workspace @modus/desktop '@composio/core@^0.20.0'`; keep the exact resolution in `package-lock.json`.
- [x] **Step 4: Implement the SDK adapter** with `new Composio({ apiKey })`, `connectedAccounts.link()`, `sessions.create()`, `sessions.use()` plus `session.update()`, and `sessions.delete()`; use the documented SDK list methods and map responses to the narrow internal records.
- [x] **Step 5: Add the renderer DTOs** to `contracts-part-09.ts` and export that part from `contracts.ts`; keep SDK/session secret types out of the shared barrel.
- [x] **Step 6: Run adapter tests and desktop typecheck; verify they pass.**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/composio/composio-api.test.ts`

Run: `npm run typecheck --workspace @modus/desktop`

Expected: PASS; serialized shared DTOs contain no SDK session or credential type.

- [ ] **Step 7: Commit** as `feat(composio): add SDK adapter and shared contracts`.

### Task 3: Add an isolated Composio MCP bridge

**Files:**
- Modify: `apps/desktop/src/main/mcp/mcp-service.ts`
- Modify: `apps/desktop/src/main/mcp/mcp-service.test.ts`

**Interfaces:**
- Produces `registerComposioMcpSession({ url, headers, allowedToolSlugs }): Promise<McpToolInfo[]>` and `unregisterComposioMcpSession(): Promise<void>`.
- Defines `ComposioMcpBridge` with those exact two methods for injection into the session-sync service.
- This internal registration is separate from the workspace `servers` map and `mcp.json`; `listMcpServers()` remains the generic-MCP view and `syncWorkspaceMcp()` must not remove or modify the Composio registration.
- Every registered operation uses `mcpToolName("__modus_composio", toolSlug, "dangerous")`, profile `chat` only, and permission `{ danger: "dangerous", action: "mcp.call" }`.

- [x] **Step 1: Add failing MCP tests** for exact allowlist filtering, `chat`-only registration, `mcp.call` classification, Streamable HTTP only (no SSE fallback), isolation from `syncWorkspaceMcp()`, cleanup through `disposeAllMcp()`, no overwrite if a generated Composio tool name collides with an existing generic MCP tool, no partial registration if one selected operation is missing, and rejection above 500 operations.
- [x] **Step 2: Run the focused MCP tests and verify the new assertions fail.**

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/mcp/mcp-service.test.ts -t Composio`

Expected: FAIL because the internal registration API is absent.

- [x] **Step 3: Implement the internal registration path** using Streamable HTTP only and the existing MCP tool-definition helpers; list all pages first, verify every allowed slug is present, reject more than `MAX_MCP_TOOLS_PER_SERVER`, then register only exact allowed names.
- [x] **Step 4: Fail closed before reconnecting** by unregistering prior Composio tools before URL/client refresh; require HTTPS for the session URL, pass the SDK-issued headers only to that URL, and set request redirect handling to `error` so credentials cannot follow a cross-origin redirect.
- [x] **Step 5: Extend `disposeAllMcp()` to close the internal client** without exposing it to workspace MCP reconciliation; preserve the existing 500-tool and timeout protections.
- [x] **Step 6: Run focused MCP tests and the full `mcp-service.test.ts`; verify they pass.**
- [ ] **Step 7: Commit** as `feat(mcp): bridge selected Composio tools`.

### Task 4: Implement Composio key, catalog, and account lifecycle

**Files:**
- Create: `apps/desktop/src/main/composio/composio-service.ts`
- Test: `apps/desktop/src/main/composio/composio-service.test.ts`
- Modify: `apps/desktop/src/main/composio/composio-api.ts` only if an adapter method is missing.

**Interfaces:**
- Produces `ComposioService` methods: `initialize(): Promise<ComposioSettingsState>`, `getSettingsState(): Promise<ComposioSettingsState>`, `setProjectApiKey(apiKey: string): Promise<ComposioSettingsState>`, `removeProjectApiKey(): Promise<ComposioSettingsState>`, `refreshCatalog(): Promise<ComposioSettingsState>`, `listToolkitTools(toolkitSlug: string): Promise<ComposioToolSummary[]>`, `startConnection(input: ComposioStartConnectionInput): Promise<ComposioConnectionOperation>`, `getConnectionOperation(operationId: string): Promise<ComposioConnectionOperation>`, `renameAccount(input: ComposioRenameAccountInput): Promise<ComposioSettingsState>`, `disconnectAccount(input: ComposioDisconnectAccountInput): Promise<ComposioSettingsState>`, and `shutdown(): Promise<void>`.
- Constructor dependencies are injected: `ComposioSecretStore`, `ComposioProfileStore`, `createComposioApi(apiKey)`, `openExternal(url)`, and the internal MCP bridge port from Task 3.
- Connection operation state is held in memory; renderer receives only operation ID, toolkit, alias, status, and sanitized error.

- [x] **Step 1: Write service tests** proving read-access validation failure preserves an existing key, a later scoped-key write denial is redacted and identifies its required capability, accounts are read only for the local profile ID, a sixth or concurrent sixth account is rejected including pending links, `linkAccount` requests `allowMultiple: true`, and each account alias/status is mapped without token data.
- [x] **Step 2: Add connection-flow tests** proving only `https://connect.composio.dev/link/...` is opened, a non-HTTPS or foreign-host URL is rejected without opening, the raw URL never appears in operation state/errors, and canceled/expired/late results never activate a toolkit.
- [x] **Step 3: Run the service tests and verify they fail** because the orchestration service does not exist.

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/composio/composio-service.test.ts`

Expected: FAIL on missing module or service methods.

- [x] **Step 4: Implement the injected `ComposioService`**; hide registered Composio tools while a replacement key is being validated, use `validateProjectReadAccess(profileId)` before saving it so a read-invalid candidate leaves the old encrypted key intact, reconcile against the accepted key before restoring tools, query catalog/accounts with the opaque profile ID, and save only sanitized aliases and account IDs. Do not represent this read check as proof of write scopes; a read-valid candidate missing write access may be saved and will produce an actionable error on the first explicit write.
- [x] **Step 5: Implement bounded connection creation** by resolving/creating a supported Composio-managed auth config, calling the SDK's `connectedAccounts.link(userId, authConfigId, { alias, allowMultiple: true })`, opening only the validated Connect Link in the main process, and observing `waitForConnection()` with a 60-second bound.
- [x] **Step 6: Map Composio errors to safe actionable errors** for invalid/wrong-project key, missing scoped-key read or write permissions, unavailable toolkit/auth config, network/rate limit, canceled/expired/revoked account, and session synchronization; write-scope failures are reported on the first explicit write operation with a recovery path to re-enter a prior key if needed, and raw SDK errors containing credentials or URLs are never returned.
- [x] **Step 7: Run service tests and desktop typecheck; verify they pass.**
- [x] **Step 8: Commit** as `feat(composio): manage toolkit connections and accounts`.

### Task 5: Reconcile explicit session policy and selected tools

**Files:**
- Create: `apps/desktop/src/main/composio/composio-session-sync.ts`
- Test: `apps/desktop/src/main/composio/composio-session-sync.test.ts`
- Modify: `apps/desktop/src/main/composio/composio-service.ts`
- Modify: `apps/desktop/src/main/composio/composio-service.test.ts`

**Interfaces:**
- Produces `ComposioSessionSyncInput = { profile: ComposioProfileConfig; api: ComposioApi; mcp: ComposioMcpBridge }`, `buildComposioSessionConfig(profileId, profileConfig)`, `reconcileComposioSession(input: ComposioSessionSyncInput): Promise<ComposioSettingsState>`, and the service method `setToolkitPolicy(input: ComposioToolkitPolicyInput): Promise<ComposioSettingsState>`.
- A non-empty session uses `toolkits: { enable: string[] }`, `tools: Record<toolkitSlug, { enable: string[] }>`, and `connectedAccounts: Record<toolkitSlug, [accountId]>`; account values use the SDK's preferred one-element array shape.
- Session config sets `SessionPreset.DIRECT_TOOLS`, `mcp: true`, `sandbox: { enable: false }`, `manageConnections: { enable: false }`, and `multiAccount: { enable: false, requireExplicitSelection: false }` with no account maximum; omit search/execute/meta helpers as defined by the direct-tools preset.
- All session access uses `sessions.create(profileId, config)` or `sessions.use(sessionId, { mcp: true })`; updates call `session.update(fullConfig, expectedConfigVersion)` through the Task 2 adapter.

- [x] **Step 1: Write policy-builder tests** asserting selected toolkits/tools and exactly the selected account enter the session config; unselected, disabled, disconnected, expired, foreign, or unknown account/tool IDs do not.
- [x] **Step 2: Write lifecycle tests** asserting no session is created for zero selected tools, removing the final selected tool unregisters locally and deletes the remote session, and every non-empty update sends full replacement maps for `toolkits`, `tools`, and `connectedAccounts`.
- [x] **Step 3: Write fail-closed/race tests** asserting local tools disappear before a remote update, no tools return after update/MCP refresh failure, a concurrent stale update cannot resurrect disabled tools, and a 409 refetches and retries only the latest full policy.
- [x] **Step 4: Run `composio-session-sync.test.ts` and verify the assertions fail** because the policy builder/sync layer does not exist.

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/composio/composio-session-sync.test.ts`

Expected: FAIL on missing module or synchronization behavior.

- [x] **Step 5: Implement `buildComposioSessionConfig()`** using only the persisted user-selected policy; never omit `toolkits`/`tools`, never send `null` for a policy block, and never use the `"all"` shorthand.
- [x] **Step 6: Implement serialized session reconciliation**: unregister local tools first; create/update/delete the hosted session according to whether any selected operation remains; fetch/resume with MCP enabled; refresh the bridge with the exact local allowlist; persist the session ID only after the remote config and MCP registration succeed.
- [x] **Step 7: Handle a config-version conflict** by reloading with `sessions.use()`, reapplying the latest local full policy once with `expectedConfigVersion: session.configVersion`, and leaving tools unregistered if retry fails.
- [x] **Step 8: Wire policy, account selection, disconnect, key removal, and startup reconciliation through this layer**; disconnect removes active-account access before revoking the account, while key removal deletes only the local key/session and retains connected accounts in Composio.
- [x] **Step 9: Run session-sync and service tests plus desktop typecheck; verify they pass.**
- [x] **Step 10: Commit** as `feat(composio): sync allowlisted session tools`.

### Task 6: Expose the service through validated IPC and preload

**Files:**
- Modify: `apps/desktop/src/main/ipc/channels.ts`
- Create: `apps/desktop/src/main/ipc/composio-ipc.ts`
- Test: `apps/desktop/src/main/ipc/composio-ipc.test.ts`
- Modify: `apps/desktop/src/main/ipc/register-app-ipc.ts`
- Modify: `apps/desktop/src/preload/types.ts`
- Modify: `apps/desktop/src/preload/index.ts`

**Interfaces:**
- Produces `window.modus.composio` methods `getState()`, `setApiKey({ apiKey })`, `removeApiKey()`, `refreshCatalog()`, `listTools({ toolkitSlug })`, `startConnection({ toolkitSlug, alias })`, `getConnectionOperation({ operationId })`, `setToolkitPolicy({ toolkitSlug, enabled, selectedToolSlugs, selectedAccountId? })`, `renameAccount({ toolkitSlug, accountId, alias })`, and `disconnectAccount({ toolkitSlug, accountId })`.
- Each IPC channel has a strict Zod input schema in `composio-ipc.ts`; each handler calls `assertTrustedSender` and returns only shared DTOs.
- Produces a lazy `getComposioService()` singleton for IPC registration; `setApiKey` is the only request carrying raw key material, and no response carries secrets.

- [x] **Step 1: Write IPC tests** proving untrusted senders are rejected, malformed/extra fields fail schema validation, valid calls reach the matching service method, and no returned state includes an API key, `x-api-key`, MCP URL/headers, provider token, or Connect Link.
- [x] **Step 2: Run the IPC tests and verify they fail** because the channels/handler do not exist.

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/ipc/composio-ipc.test.ts`

Expected: FAIL on missing module or handler.

- [x] **Step 3: Implement strict IPC schemas and handlers** for key, catalog, account, connection, and policy actions; enforce alias/key/tool slug length bounds and reject extra fields.
- [x] **Step 4: Add channel constants and register the handlers** in `register-app-ipc.ts` with the trusted-sender check and the Composio service singleton.
- [x] **Step 5: Add the typed preload API** using `ipcRenderer.invoke` only; do not expose Node, SDK objects, shell APIs, or subscription to raw session events.
- [x] **Step 6: Run IPC tests, preload/typecheck, and the relevant project-memory IPC tests; verify they pass.**
- [x] **Step 7: Commit** as `feat(composio): expose integrations IPC`.

### Task 7: Build the Integrations settings experience

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/settings/settings-types.ts`
- Modify: `apps/desktop/src/renderer/src/features/settings/settingsNav.ts`
- Modify: `apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx`
- Create: `apps/desktop/src/renderer/src/features/settings/sections/integrations.tsx`
- Test: `apps/desktop/src/renderer/src/features/settings/sections/integrations.test.tsx`
- Modify: `apps/desktop/src/renderer/src/features/settings/settingsNavigation.test.tsx`

**Interfaces:**
- Produces an Integrations settings section backed only by `window.modus.composio`; the page is local-profile-wide and takes no workspace or group ID.
- Displays key configured/unconfigured/error state, searchable toolkit catalog, per-toolkit account aliases/status, one account radio selection, searchable operations, explicit “Select all” action, and enabled/disabled state.
- The key field is password-masked and cleared after submit; connection links open through main-process IPC, while the UI polls only sanitized operation IDs/statuses until completion or timeout.

- [x] **Step 1: Add component tests** for initial unconfigured state, password-masked key submission and clearing, no key readback, multiple accounts with exactly one agent-selected account, explicit operation checkboxes and Select All, rejection with an actionable message above 500 selected tools, and actionable missing-scope/canceled/expired/sync-error states.
- [x] **Step 2: Run the component tests and verify they fail** because the Integrations panel and nav entry do not exist.

Run: `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/settings/sections/integrations.test.tsx`

Expected: FAIL on missing panel or behavior.

- [x] **Step 3: Implement the Integrations panel** with loading/empty/ready/error states; require an active account and explicit allowed operation before enabling a toolkit for agents.
- [x] **Step 4: Add settings navigation and conditional panel rendering** under the app-wide Integrations section; leave the existing generic MCP panel as its own separate advanced setting.
- [x] **Step 5: Add tests for persisted navigation/search behavior** and update expected section IDs/labels without changing the generic MCP feature's behavior.
- [x] **Step 6: Run component, navigation, MCP settings, and desktop typecheck; verify they pass.**
- [x] **Step 7: Commit** as `feat(settings): add Composio integrations panel`.

### Task 8: Wire startup and shutdown safely

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/composio/composio-service.ts`
- Modify: `apps/desktop/src/main/composio/composio-service.test.ts`

**Interfaces:**
- Produces idempotent `initializeComposioService(): Promise<ComposioSettingsState>` and `shutdownComposioService(): Promise<void>` around the singleton.
- Startup reads/decrypts the key and reconciles the saved profile/session policy after Electron is ready; it runs after the first window is opened and is not awaited by unrelated agent startup.
- Shutdown aborts pending connection waits and clears in-memory SDK/session headers; `disposeAllMcp()` closes the internal MCP transport. Normal app quit preserves the reusable remote session.

- [x] **Step 1: Add lifecycle tests** proving initialization is idempotent, startup with unavailable encryption/invalid key registers no tools, startup reconciles tools before exposure, and shutdown aborts pending connection work and clears in-memory session credentials.
- [x] **Step 2: Run lifecycle tests and verify they fail** because the lifecycle methods are not wired.
- [x] **Step 3: Implement idempotent startup/shutdown** in the service and call initialization asynchronously from `app.whenReady()` after `openMainWindow()`.
- [x] **Step 4: Join `shutdownComposioService()` with `disposeAllMcp()`** in the existing bounded `before-quit` drain without deleting reusable sessions during ordinary shutdown.
- [x] **Step 5: Run lifecycle/service tests and desktop typecheck; verify they pass.**
- [x] **Step 6: Commit** as `feat(composio): wire integration lifecycle`.

### Task 9: Document setup and verify the complete feature

**Files:**
- Create: `docs/integrations/composio.md`
- Verify: relevant Composio, MCP, IPC, settings, and lifecycle tests.

- [x] **Step 1: Document Project API Key setup and least permissions** for toolkit discovery, auth/connected-account lifecycle, session management, and session-linked MCP execution; distinguish read checks from write scopes reported when the user first performs a protected action.
- [x] **Step 2: Document local credential handling, the stable local profile ID, multiple account/active-account behavior, explicit tool allowlists, removal semantics, custom auth setup in Composio, scoped-key read/write validation limits, and troubleshooting.**
- [x] **Step 3: Run all desktop unit tests** with `npm run test --workspace @modus/desktop`; verify the Composio/MCP subset passes and record unrelated existing failures separately.
- [x] **Step 4: Run desktop typecheck and build** with `npm run typecheck --workspace @modus/desktop` and `npm run build --workspace @modus/desktop`; if native build tooling is unavailable, run the Electron/Vite build directly and record the limitation.
- [x] **Step 5: Run `git diff --check`** and review changed files for secrets in logs, `mcp.json`, shared DTOs, or renderer state.
- [ ] **Step 6: Commit** as `docs(composio): document setup and validation`.

## Manual Acceptance

With a user-supplied Composio Project API Key, connect two platforms and two accounts for one toolkit; verify no tool appears until the user selects one account and operations; verify only the selected operations appear for chat and each goes through Modus `mcp.call` approval; switch the selected account and confirm the next calls use it; clear the final operation and confirm the local bridge unregisters and the remote session is deleted; remove the key and confirm connected accounts remain in the Composio project.

Automated tests mock the Composio SDK, Electron `safeStorage`, IPC, and MCP clients. CI must never need a live Composio key or call Composio.

## Official References

- [Composio TypeScript SDK and sessions](https://docs.composio.dev/reference/sdk-reference/typescript/sessions)
- [Composio session configuration, allowlists, account selection, and update semantics](https://docs.composio.dev/docs/configuring-sessions)
- [Composio sessions via MCP](https://docs.composio.dev/docs/sessions-via-mcp)
- [Composio connected accounts SDK](https://docs.composio.dev/reference/sdk-reference/typescript/connected-accounts)
- [Scoped Project API Key permissions](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
