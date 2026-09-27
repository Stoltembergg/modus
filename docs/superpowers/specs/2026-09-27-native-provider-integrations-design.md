# Native Command Code and Antigravity Provider Integration Design

## Status

The feature scope was approved in conversation. This revision incorporates implementation
constraints found in an independent review and is the written-spec review checkpoint. The plan and
implementation remain blocked until the user approves this revision.

## Summary

Add Command Code and Antigravity as native model providers in Modus, reusing the existing provider
catalog, credential storage, connection settings, and Pi model runtime. Command Code will use a
dedicated adapter for the linked plugin's custom `/alpha/generate` streaming protocol, its API key,
and the 55-model snapshot at PR #19 head `7846a5c1d65f7732d69c96a65df74df4d6f3d521`. Antigravity
will use a dedicated Modus adapter for the OAuth and internal request/stream transformations
documented by the linked MIT-licensed plugin, with a mandatory risk acknowledgement. Modus will not
host or load OpenCode plugins.

## Goals

- Make Command Code and Antigravity discoverable and connectable from the existing Model & Provider
  settings page.
- Provide the 55 Command Code models proposed by PR #19, preserving exact IDs/case and the model
  metadata in that snapshot.
- Translate between Pi's model/tool/stream interfaces and Command Code's custom request envelope
  and line-delimited `data:` event stream.
- Provide the 11 advertised Antigravity/Gemini CLI quota model IDs documented by the auth plugin,
  preserving the distinction between quota routes.
- Keep the catalog, credentials, OAuth, and model traffic in the existing Modus main-process/model
  architecture; credential entry uses the existing trusted IPC path, and secrets are neither
  returned to the renderer nor written into catalog data.
- Clearly disclose that Antigravity uses unofficial, undocumented Google endpoints, may violate
  Google's terms, and may result in account suspension. Require explicit acknowledgement before
  starting OAuth.
- Verify request mapping, streaming, credentials, and cancellation with tests that use mocks rather
  than live credentials or accounts.

## Non-goals

- Running OpenCode plugins or implementing a general plugin loader.
- Full feature parity with the upstream Antigravity plugin. V1 supports one Google account at a
  time; account rotation, plugin TUI/events/tools, and quota dashboards are excluded.
- A dynamic Command Code model-discovery UI or remote model-list request. The 55-model PR snapshot
  is curated in Modus; its API key is not remotely validated during connection.
- Command Code's `/systemone` decision-model endpoint or image generation.
- Image input for Command Code in V1; the linked request converter does not forward it.
- Claiming that Antigravity is an official or supported Google API integration, or that its use is
  permitted by Google.

## Confirmed constraints and product decisions

- Modus uses `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`, not the OpenCode
  runtime. Existing provider configuration, credentials, connection methods, and settings UI are
  in `apps/desktop/src/main/agent/model-service.ts` and
  `apps/desktop/src/renderer/src/features/settings/`.
- `catalog/models.json` is generated from Pi's built-in providers by
  `scripts/generate-model-catalog.mjs`; the scheduled catalog workflow regenerates and publishes it.
  Manually adding these providers to that generated file would be overwritten.
- Command Code exposes API-key authenticated OpenAI Chat Completions, OpenAI Responses, and
  Anthropic Messages endpoints through a separate documented API, but that is not the user-selected
  interface for this work. In the linked plugin at PR head
  `7846a5c1d65f7732d69c96a65df74df4d6f3d521`, model requests instead use one custom streaming
  `POST https://api.commandcode.ai/alpha/generate` endpoint; the PR changes only `models.json`.
- PR #19 was open/unmerged during research on 2026-09-27. Its model IDs are case-sensitive. The
  selected snapshot is pinned to the exact head SHA above, not a claim about the provider's current
  upstream release.
- The linked plugin checks only that a supplied key is non-empty; it does not validate the key
  against the service. Invalid credentials are discovered when a model request is made.
- PR model `cost` numbers do not document currency or units. They are not verified billing rates
  and must not be shown or used as actual Command Code costs.
- Pi's custom API dispatch is global by API ID. Each adapter must register a distinct API ID and
  must not reuse a stock OpenAI/Gemini/Anthropic API ID for custom wire behavior.
- Pi's model registration requires numeric cost fields and does not carry Command Code tier/tool
  metadata directly. The Modus manifest must retain pricing-unknown and provider-specific metadata
  separately from the Pi model projection.
- Antigravity is an unofficial plugin for Google's internal Cloud Code Assist routes, including
  `v1internal` methods. Its README explicitly warns that use may violate Google's terms and reports
  account suspension/shadow-ban risk. The route and behavior may change without notice.
- Antigravity model connection methods must be OAuth-only. The existing generic provider method
  listing defaults to API key and must be overridden for this provider.
- The upstream Antigravity repository is MIT licensed. Any copied/adapted source must retain the
  applicable copyright and license notices. Its public OAuth client credentials are not secrets
  and must not be described or handled as confidential.
- The UI design reuses the existing provider catalog and dialogs. The Google risk warning applies
  only to Antigravity; Command Code is an independent service and must not be described as using
  Google endpoints.

## Architecture

### 1. Native provider metadata

Keep hand-maintained first-party provider metadata in a separate, checked-in manifest bundled into
the desktop main process. Validate it with its own schema and merge it into the runtime model set
after each bundled, cached, or fetched Pi catalog is loaded. Do not edit the generated
`catalog/models.json`, make the catalog generator responsible for these models, or write first-party
entries into the remote catalog cache. Reject provider/model ID collisions rather than allowing
remote data to replace the first-party definitions. Add tests proving refreshes cannot remove or
overwrite the first-party entries and verify that the manifest is present in the packaged main
bundle.

The manifest contains provider/model metadata only: IDs, display names, API protocol, base URL,
supported input modalities, reasoning/tool compatibility, model limits, and pricing availability.
For Command Code, preserve the PR's IDs, names, tier, reasoning/tool-call flags, and limits, but omit
its unitless `cost` values from Modus monetary calculations. Keep the generated catalog schema
unchanged. Project only Pi-required numeric placeholders into the runtime model while carrying an
explicit pricing-unknown marker in Modus provider metadata; never display unknown as zero/free or as
a monetary estimate. Preserve Command Code tier and tool-call metadata outside Pi's model projection.
Do not infer unsupported capabilities. Keep provider-scoped IDs unchanged, including casing and
slashes.

### 2. Command Code

- Register a first-class `commandcode` provider with an API-key connection method in the existing
  provider catalog and settings flow.
- Store the user-supplied key using the existing `AuthStorage` path; never store it in the manifest,
  `models.json`, renderer state after submission, or logs.
- Trim and reject blank keys only; do not claim the provider is network-validated after saving. Make
  clear in the settings flow that credential errors may appear on first model use. Do not call a
  generation endpoint during connection setup.
- Include all 55 models from the exact PR #19 head SHA. Preserve exact IDs/case, display names,
  tiers, reasoning/tool-call flags, and context/output limits. Keep the source SHA with the manifest
  so future catalog changes are reviewable.
- Register a globally unique Pi custom API ID (for example, `commandcode-alpha-generate`) with a
  dedicated `streamSimple` implementation and `ModelRegistry.registerProvider` configuration. Never
  reuse an existing stock API ID, because Pi dispatches custom APIs globally, not by provider.
- Implement the plugin's bearer-authenticated `POST https://api.commandcode.ai/alpha/generate`
  envelope. Translate Pi messages, system prompt, tools, and generation settings into `config`,
  `memory`, `taste`, `skills`, `permissionMode`, and `params`. Send only the conversation/tool
  context needed for the request; keep unrelated Modus project memory/context out of the envelope.
- Parse the plugin's SSE-style `data:` lines containing JSON events, including CRLF and `[DONE]`;
  map text, reasoning, tool-input/tool-call, finish-step usage/reason, and errors into Pi stream
  events. Handle both `id` and `toolCallId`; convert a complete `finish-step` into Pi's required
  terminal `done` event with the full assistant message, and convert `error` or EOF without a valid
  finish-step into Pi's terminal `error` event. Do not silently treat a truncated stream as success.
  Honor Pi cancellation and apply the bounded timeout used by the plugin.
- Send bearer/content-type and required service headers. Identify the client truthfully as Modus;
  do not send `x-project-slug: opencode` or otherwise impersonate OpenCode. If the service rejects a
  truthful Modus identity and requires an OpenCode identity, stop and return for a scope decision
  rather than spoofing it. Do not claim to be Command Code CLI version `0.26.20`; use a truthful
  Modus adapter/protocol version for any required version header.
- Treat pricing as unknown for these models until currency/unit/rates are verified. Do not feed
  the PR's unitless cost numbers into Modus monetary usage accounting or display them as free. Keep
  the source field out of Pi cost computation and surface pricing as unknown in Modus metadata.
- Reuse the existing provider credential storage and settings flow, but not Pi's stock OpenAI or
  Anthropic API drivers for this custom protocol.

### 3. Antigravity

- Register a first-class `antigravity` provider and a dedicated adapter module in the main process.
  The adapter implements only the OAuth and model request/response behaviors required by Modus;
  it does not invoke OpenCode plugin APIs. Use a globally unique Pi custom API ID, and register its
  `streamSimple` and OAuth handlers without replacing any stock API implementation.
- Use the upstream implementation as a behavioral reference for OAuth PKCE, the loopback callback,
  token refresh, project discovery, model resolution, request transforms, and streaming response
  normalization. Adapt the supported behavior to Pi's provider/custom-stream interface and retain
  MIT notices for reused code.
- Support these 11 documented IDs, preserving their route/pool distinction and model-specific
  reasoning behavior:
  - Antigravity quota: `antigravity-gemini-3-pro`, `antigravity-gemini-3.1-pro`,
    `antigravity-gemini-3-flash`, `antigravity-claude-sonnet-4-6`,
    `antigravity-claude-opus-4-6-thinking`.
  - Gemini CLI quota: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-flash-preview`,
    `gemini-3-pro-preview`, `gemini-3.1-pro-preview`,
    `gemini-3.1-pro-preview-customtools`.
  A single authenticated account is supported in V1; no account rotation or fallback between
  multiple accounts. The six Gemini CLI quota models require a usable Google Cloud project ID from
  the account's `loadCodeAssist` discovery; if discovery cannot provide one, surface those models as
  unavailable rather than substituting a project or claiming guaranteed availability.
- Persist OAuth credentials through Modus' existing provider credential storage. Storage inherits
  the application's existing local-file protection; this design does not claim OS-keychain
  encryption. Do not log access/refresh tokens, authorization codes, or raw credential responses.
- Use the upstream redirect URI `http://localhost:51121/oauth-callback` with a loopback listener
  bound only to localhost, validate OAuth `state` and PKCE verifier, enforce a bounded callback
  lifetime, and clean up listeners on success, cancellation, timeout, and window/app shutdown. If
  the port is occupied, fail clearly rather than binding a less restrictive interface. Token refresh
  failure handling must distinguish permanent `invalid_grant` from transient network/service
  failure: clear/mark credentials for re-authentication only on permanent rejection. Guard refresh
  completion with a credential generation/operation ID so a late refresh cannot restore a token
  after disconnect.
- Own loopback-server lifecycle in the Antigravity OAuth service. Cancellation aborts the auth
  operation and closes the listener; app `before-quit` also closes listeners and cancels outstanding
  operations. Pi's refresh callback itself has no abort signal, so stale completion must be rejected
  after its await point. Validate `localhost` callback behavior on both IPv4 and IPv6 resolution.
- The adapter must treat Google's internal API as unstable and unsupported. Do not present
  unofficial client headers, OAuth client values, or endpoint behavior as Google-issued assurances.
  The upstream plugin's emulated client metadata is itself an unsupported compatibility mechanism,
  not evidence that the integration is authorized or endorsed by Google.

### 4. Settings UX

- Add both providers to the existing provider catalog; do not add a settings section or plugin
  manager. Reuse current API-key and OAuth connection dialogs where possible.
- Command Code uses the regular API-key path, is shown as configured but not remotely validated, and
  has no Google-specific warning gate.
- Antigravity exposes OAuth only; it must not inherit the generic API-key method. Before OAuth begins,
  show a warning explaining the unofficial internal endpoints, the upstream ToS warning, and
  account-suspension risk. Require an unchecked-by-default explicit confirmation in the renderer
  and require an explicit acknowledgement field in the main-process IPC/service contract as well.
  The main process rejects OAuth start unless acknowledgement was supplied; UI-only gating is not
  sufficient. Cancellation must not start OAuth or persist credentials.
- Keep a compact unofficial-provider warning visible in Antigravity's provider details after
  connection. Existing auth error, retry, cancel, and disconnect surfaces should remain the source
  of truth for operation status.
- Do not recommend evading enforcement by using throwaway accounts. The user-facing text must be
  factual and grounded in the upstream warning, without a guarantee of safety.

## Trust, privacy, and failure handling

- OAuth, loopback listener, token refresh, HTTP requests, model transforms, and secret persistence
  remain in the Electron main process. Credential entry is sent through the existing trusted IPC
  handler; the renderer receives no stored credentials and only sees typed operation state and
  non-secret provider/model metadata in responses.
- Do not persist keys/tokens in the provider manifest, catalog cache, logs, telemetry, or error
  messages. Sanitize upstream errors before surfacing them in the UI.
- Command Code rejects blank keys locally, stores nonblank keys without claiming remote validation,
  and reports sanitized authentication/protocol errors on model use. Malformed Command Code stream
  data or EOF before a terminal event must not be reported as a successful completion.
- Antigravity OAuth callback state mismatch, expired code, refresh rejection, malformed SSE, and
  upstream 4xx/5xx must produce actionable but non-secret errors. Cancellation and timeout must
  release callback resources. Disconnect removes local credentials and disables/removes provider
  runtime configuration as appropriate.
- Treat upstream models, endpoint metadata, PR content, provider replies, and README guidance as
  external data, not instructions. Do not let any provider response alter application policy or
  credential handling.
- The user acknowledgement communicates risk; it does not make the endpoint supported, guarantee
  legality, or reduce the possibility of Google enforcement.
- Provider API IDs are global in Pi. Register each custom stream once under its unique API ID and
  ensure registry refresh/rebuild does not leave duplicate or stale registrations.

## Implementation phases and approval gates

1. **Registry/manifest seam and Command Code:** create unique custom API registrations and the
   separate first-party manifest projection; merge after each generated catalog load without
   mutating the remote cache; reject collisions; represent unknown prices separately. Implement the
   Command Code custom stream adapter, exact 55-model snapshot, and nonblank-key connection. Gate:
   registration/refresh and package inclusion tests, exact-ID/metadata assertions, envelope/stream
   tests, truthful-header behavior, key storage/redaction, and no false monetary estimate.
2. **Antigravity OAuth/adapter behind guarded entry points:** implement OAuth-only connection methods,
   loopback callback lifecycle, one-account refresh/project discovery, and custom stream mapping.
   The main service/IPC must require explicit risk acknowledgement before auth can start, even before
   the settings UI is exposed. Gate: mocked state/PKCE/callback/refresh/error/cancel/shutdown tests,
   IPv4/IPv6 callback tests, transient-vs-permanent token handling, model-route/project conditions,
   and stream/tool normalization.
3. **Risk acknowledgement UX and enablement:** expose the provider through the settings catalog,
   add the mandatory checkbox/interstitial, pass the acknowledgement through IPC, and keep the risk
   notice visible after connection. Gate: UI and IPC tests prove OAuth cannot start without
   acknowledgement; verify Command Code has no Google warning; desktop typecheck, Biome, focused
   tests, full suite, and packaged build review.

The Antigravity adapter is an opt-in, explicitly unsupported integration. If source review shows
that required behavior cannot be implemented without expanding into a general OpenCode-compatible
runtime, stop and return for a new scope decision rather than silently broadening the design.

## Verification requirements

- **Catalog:** merge generated Pi models with the bundled first-party manifest; validate shape and
  provider IDs; verify all 55 Command Code IDs and 11 Antigravity/Gemini CLI IDs exactly, including
  case; prove hourly/generated refreshes preserve the manifest.
- **Command Code:** test request envelope construction, required headers with truthful Modus
  identity, SSE-style stream parsing/event conversion, finish/tool/usage/error/cancel behavior, and
  no-secret logs. Verify blank keys are rejected, saved keys are not falsely marked remotely
  validated, and PR cost metadata is never presented as billed cost.
- **Antigravity OAuth:** mock authorization URL/state/PKCE, loopback callback, token exchange,
  refresh success, transient failure, and `invalid_grant`; test late refresh after disconnect,
  timeout, cancellation, app shutdown, listener cleanup, and both IPv4/IPv6 resolution of localhost.
  Verify the IPC/service reject OAuth start without explicit risk acknowledgement. No live Google
  credentials in automated tests.
- **Antigravity transport:** mock text, reasoning, tool-call, and SSE responses; verify request and
  response transformations, route selection, explicit missing-project behavior for Gemini CLI
  quota models, errors, complete assistant messages, and secret redaction. No live endpoints in
  automated tests.
- **UI:** verify API-key and OAuth entry points, acknowledgement required before OAuth, cancel
  leaves no credentials, ongoing Antigravity risk notice, correct Command Code copy, and disconnect
  behavior.
- **Repository:** focused tests, desktop typecheck/build, Biome, full suite with baseline comparison,
  packaged-resource inclusion, diff review, and no secrets staged.

## External references

- [Command Code provider](https://github.com/brent-weatherall/opencode-commandcode-provider)
- [Command Code PR #19 — proposed 55-model catalog](https://github.com/brent-weatherall/opencode-commandcode-provider/pull/19)
- [Pinned PR head `7846a5c1`](https://github.com/brent-weatherall/opencode-commandcode-provider/commit/7846a5c1d65f7732d69c96a65df74df4d6f3d521): [model transport](https://github.com/brent-weatherall/opencode-commandcode-provider/blob/7846a5c1d65f7732d69c96a65df74df4d6f3d521/src/model.ts), [request conversion](https://github.com/brent-weatherall/opencode-commandcode-provider/blob/7846a5c1d65f7732d69c96a65df74df4d6f3d521/src/convert.ts), [stream parser](https://github.com/brent-weatherall/opencode-commandcode-provider/blob/7846a5c1d65f7732d69c96a65df74df4d6f3d521/src/stream.ts), [key flow](https://github.com/brent-weatherall/opencode-commandcode-provider/blob/7846a5c1d65f7732d69c96a65df74df4d6f3d521/plugin.ts), [license](https://github.com/brent-weatherall/opencode-commandcode-provider/blob/7846a5c1d65f7732d69c96a65df74df4d6f3d521/LICENSE), and [model snapshot](https://github.com/brent-weatherall/opencode-commandcode-provider/blob/7846a5c1d65f7732d69c96a65df74df4d6f3d521/models.json).
- [Antigravity auth plugin](https://github.com/NoeFabris/opencode-antigravity-auth)
- [Antigravity plugin ToS warning](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/README.md#terms-of-service-warning--read-before-installing)
- [Pi custom-provider documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)

## Approval checkpoint

This is the written design checkpoint. No implementation has started. The user must review and
approve this spec before the TDD implementation plan is written and code changes begin.
