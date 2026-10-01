# Composio Integrations for Modus

**Status:** Proposed design; conversational sections approved, written specification awaiting review  
**Date:** 2026-10-01

## Problem

Modus is a local-first desktop application with a generic MCP integration, but users do not have one guided place to connect the platforms their agents need. The requested experience is to connect multiple platforms through Composio, manage their accounts in Modus, and make agent access visible and controllable without adding a Modus account system or hosted backend.

## Goals

- Let each user configure their own Composio Project API Key and connect multiple Composio toolkits and accounts from Settings.
- Keep the API key in the Electron main process and protect it with the operating system's credential facilities.
- Make platform connection and agent access separate choices. A connected toolkit grants no agent tools until the user selects its allowed operations.
- Expose selected operations individually through Modus's existing MCP bridge and `mcp.call` permission flow.
- Retain the current generic MCP feature as a separate, advanced path for custom MCP servers.

## Non-goals for V1

- A Modus-hosted backend, Modus login, shared Modus API key, or cross-device synchronization.
- Native Modus OAuth implementations or direct provider SDK integrations.
- Removing or replacing generic MCP configuration.
- Per-workspace or per-group integration policies; the Composio configuration belongs to the local Modus profile and is available across its conversations.
- Composio triggers, webhooks, or background automation.

## Approved design decisions

1. Users bring their own Composio **Project API Key**. Modus does not ship or operate a shared key.
2. Settings gains an Integrations area for the Composio key, toolkit catalog, account lifecycle, and per-toolkit operation allowlists. Generic MCP remains separate.
3. The main process uses the Composio TypeScript SDK for connection/session management. Agent execution uses a Composio-hosted Session MCP endpoint through the existing Modus MCP bridge.
4. A stable, opaque ID generated for the local Modus profile scopes Composio accounts. The configuration is local to that profile and is not synchronized to another device.
5. A toolkit is agent-visible only when it is connected, enabled for agents, and has at least one explicitly selected operation. “Select all” is an explicit user action.
6. Every exposed operation uses the existing `mcp.call` authorization policy. Composio metadata may inform display labels, but cannot bypass Modus approval.
7. Multiple accounts per toolkit are supported, labeled with user-defined aliases, and capped at five per toolkit in V1. The user selects exactly one active account per toolkit for agent execution in Settings; the session is pinned to that account so tools never silently use the newest account or choose an account on the agent's behalf.
8. The hosted session uses the direct-tools preset with an explicit toolkit/tool allowlist. Remote sandbox, Composio search/execution meta-tools, and other unrelated session helpers are disabled.

## User experience

The Integrations settings page guides the user through adding a Project API Key and validating that it can access the selected Composio project. It then presents a searchable toolkit catalog and, for each toolkit, the connection status, connected account aliases, the single account selected for agents, and the operations currently allowed to agents.

Connecting an account uses a Composio Connect Link opened in the system browser. The user can add up to five accounts for the same toolkit, rename aliases, choose which one account agents may use, reconnect expired accounts, disable a toolkit for agents, and disconnect an account. The UI clearly distinguishes “connected” from “available to agents.” A connected account that is not selected for agents, or has no selected operations, remains unavailable to agents.

For a toolkit that needs an auth configuration not already available in the Composio project, Modus first tries to create a Composio-managed configuration when the toolkit supports it. If the toolkit requires custom credentials, Modus explains that setup must be completed in Composio before the user retries. Provider credentials are entered into Composio's hosted connection flow/configuration; Modus does not build a provider-specific OAuth form.

Removing the Composio key from Modus disconnects the local integration and erases its local key copy. It does not delete connected accounts from the user's Composio project. Disconnecting an individual account is a separate, confirmed action because revocation removes its provider grant.

## Architecture

### Main-process Composio service

Add a focused main-process service that owns the SDK client, local profile ID, Composio session ID, toolkit/account queries, Connect Link lifecycle, selected operation lists, aliases, and internal MCP registration state. Persist the non-secret profile ID, session ID, aliases, and toolkit/tool allowlists; always refresh connection status from Composio. The renderer talks to this service only through validated IPC methods exposed by the preload API.

All Composio reads must filter accounts by the local profile ID. Connection aliases and selected toolkit/tool IDs are non-secret configuration; provider tokens remain with Composio.

### Credential storage

Store the Project API Key encrypted with Electron's asynchronous `safeStorage` API. Keep encrypted bytes under the application's `userData` directory. Never return the key to the renderer after saving it, persist a plaintext copy, include it in workspace `mcp.json`, or write it into logs, telemetry, error text, or tool metadata. The hosted MCP endpoint headers are also secret and remain in memory only; they are reconstructed from the stored key and session ID after restart.

If OS-backed encryption is unavailable, fail closed: do not persist the key in plaintext and do not activate the integration. Tell the user how to resolve the local credential-store problem. Electron recommends the asynchronous safeStorage API and documents platform-specific key providers and availability behavior: [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

### Composio session and MCP bridge

Maintain one reusable execution session per local profile. Create or resume it with:

- `userId`: the opaque local profile ID;
- `toolkits`: an explicit allowlist of toolkits with active accounts and selected operations;
- `tools`: an explicit allowlist of selected Composio tool slugs for each toolkit;
- `connectedAccounts`: an explicit mapping from each enabled toolkit to the one account selected by the user for agent execution;
- the `DIRECT_TOOLS` session preset and `mcp: true`;
- remote sandbox disabled;
- Composio multi-account session mode disabled. Multiple accounts remain connected in Composio, but only the user-selected account is attached to each toolkit in the execution session.

An empty toolkit/tool selection is treated as no available Composio tools; it must never fall back to Composio's unrestricted catalog default. Do not create an execution session until at least one operation is selected. When the final selected operation is removed, unregister the internal MCP server locally and delete the remote session. Every session update sends the complete current `toolkits`, `tools`, and `connectedAccounts` maps because Composio replaces those maps rather than merging partial updates. Pin the Composio SDK to a version that supports the required allowlist update behavior (at least `@composio/core` 0.19.1). Composio sessions are unrestricted by default unless a toolkit allowlist is supplied, and support explicit toolkit/tool policies and an MCP endpoint: [Configuring Sessions](https://docs.composio.dev/docs/configuring-sessions), [Using Sessions via MCP](https://docs.composio.dev/docs/sessions-via-mcp).

The MCP service gains a dynamic internal-server registration path for Composio. It must not write the endpoint or headers into `mcp.json`. Registered tools appear only in the chat profile and continue through the MCP bridge's per-call permission handling. Composio tool annotations are display hints only. The session MCP endpoint and headers come from the same-origin SDK session and must be forwarded only to that origin.

For connection creation, reuse an existing auth config for the toolkit or create a Composio-managed auth config through the API when supported. Then use Composio Connect Links and the current `connectedAccounts.link()` flow; request multiple-account creation explicitly and track each result by the local profile ID. The `link()` API requires an auth-config ID and accepts `allowMultiple` for additional accounts: [Auth Configs SDK](https://docs.composio.dev/reference/sdk-reference/typescript/auth-configs), [ConnectedAccounts SDK](https://docs.composio.dev/reference/sdk-reference/typescript/connected-accounts).

### IPC and renderer

Use typed contracts and Zod schemas for key submission, toolkit/tool selection, aliases, status queries, connection creation, account reconnection/disconnection, and key removal. Validate IPC sender as existing main-process handlers do. Responses contain sanitized status, catalog metadata, aliases, and actionable errors, never the API key, authorization headers, provider credentials, or a raw SDK object.

The Integrations page provides:

- Project API Key entry, validation, replacement, and removal;
- searchable Composio toolkit catalog and connection status;
- account aliases and multiple-account lifecycle actions;
- searchable tool lists with descriptions and risk hints when available;
- explicit operation selection, including a deliberate “select all” action;
- clear states for missing auth setup, invalid/scoped key permissions, connection pending/expired/revoked, offline state, and retry.

## Data and lifecycle

### Initial setup

1. The user submits a Project API Key through the typed preload API.
2. The main process validates it against Composio, checks that session and connection operations are available, then encrypts and saves the key. It creates or loads the local profile ID and lists toolkits/accounts scoped to that ID.
3. The UI displays available toolkits and existing accounts. No Composio tools are exposed until the user enables an integration and selects operations.

### Connect and enable

1. The user chooses a toolkit and starts a connection. The main process finds or creates an appropriate Composio auth config, then creates a Composio Connect Link for the local profile ID and requested alias, opening only an HTTPS URL from the expected Composio Connect origin in the system browser.
2. The main process waits for or polls the connection status with a bounded timeout. The UI displays pending, active, failed, expired, or canceled status without exposing the raw Connect Link in logs.
3. Once the account is active, the user selects that account for agents and selects allowed operations. Modus narrows/updates the Composio session, refreshes the internal MCP server's tool list, then registers those exact tools. If the remote update or local refresh fails, tools remain unregistered.

### Disable and disconnect

- Disabling a toolkit or clearing its operation allowlist unregisters its tools locally before the Composio session is narrowed. If other selected operations remain, send the complete remaining session maps; if none remain, delete the remote session. If the session update or deletion fails, local tools remain hidden and the UI shows that synchronization is incomplete.
- Disconnecting an account requires confirmation, revokes/deletes the Composio connected account, then refreshes the session and tool registrations.
- Removing the Project API Key unregisters and closes the local Composio MCP client, then removes the encrypted key. It does not implicitly delete remote accounts. Replacing the key hides tools while the new key is validated and the session is reconciled; an invalid replacement does not overwrite the old encrypted key. If the replacement cannot verify the existing session, keep all Composio tools hidden until the user reconnects or restores the previous key.
- On startup, decrypt the key, resume the stored session, compare its server configuration with the local allowlist, and reconcile before registering any tools. If the key, session, or permissions cannot be verified, register no Composio tools.

## Errors, reliability, and security

- Present separate actionable messages for invalid key, wrong project/key type, insufficient scoped-key permissions, unavailable toolkit/auth config, network/rate-limit errors, canceled/expired account authorization, revoked or unselected account, and session sync failure.
- Never include key material, MCP headers, raw provider tokens, or unredacted Connect Links in logs or renderer errors.
- Validate Connect Link protocol and hostname before calling Electron `shell.openExternal`.
- Use the existing MCP timeout/cancellation path for tool execution. A Composio network failure must fail that tool call clearly without blocking unrelated agents or local tools.
- Fail closed during configuration changes: hide tools locally before narrowing or removing remote access; expose new tools only after Composio confirms the new allowlist and MCP refresh succeeds.
- Composio project keys may be full-access or scoped. Before release, document the least permissions needed for toolkit discovery, auth/connected-account management, session management, and session-linked MCP execution; if a scoped key lacks access, show which capability must be enabled. See [Project API Key permissions](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions).
- Without a Modus identity service or public callback verifier, the local opaque user ID is a scoping identifier, not proof of human identity. Treat Connect Links as short-lived secrets, keep them out of logs, and open them only from the local Settings flow. Do not claim cross-device or organization-level identity guarantees.
- Composio direct-tools sessions use preloaded tool schemas; do not enable Composio multi-account session mode because Composio does not support tool preloading together with that mode. Pin one selected account per toolkit with `connectedAccounts` instead. See [Managing multiple connected accounts](https://docs.composio.dev/docs/authentication/managing-multiple-connected-accounts) and [Configuring Sessions](https://docs.composio.dev/docs/configuring-sessions).

## Validation and acceptance criteria

Automated tests use mocked Electron safeStorage, Composio SDK, IPC, and MCP clients; CI must not require a real Composio key or make calls to Composio.

1. Credential-store tests prove encrypted-only persistence, no renderer readback, and no plaintext fallback when encryption is unavailable.
2. Composio service tests prove account queries and Connect Links are scoped to the local profile ID, multiple accounts can be listed, and only the selected account plus selected toolkit/tool IDs enter session configuration.
3. MCP bridge tests prove selected tools register only for chat and every exposed Composio operation classifies as `mcp.call`; unselected, disconnected, or failed-sync operations never register.
4. IPC/preload and renderer tests cover schema rejection, sanitized responses, key lifecycle, toolkit/action selection, account statuses, and recoverable errors.
5. Desktop typecheck/build pass, and relevant unit tests pass.
6. Manual acceptance connects two different platforms and two accounts for one platform, selects one account for agent use, enables only selected operations, verifies those are the only Composio tools visible to agents and that they use the selected account, verifies every call uses the Modus approval flow, and confirms that removing the local key does not delete accounts from the Composio project.

## External references

- [Composio authentication and Project API Keys](https://docs.composio.dev/reference/authenticating-to-composio)
- [Composio authentication configs](https://docs.composio.dev/reference/api-reference/auth-configs)
- [Composio Connected Accounts](https://docs.composio.dev/reference/api-reference/connected-accounts)
- [Composio multi-account behavior](https://docs.composio.dev/docs/authentication/managing-multiple-connected-accounts)
