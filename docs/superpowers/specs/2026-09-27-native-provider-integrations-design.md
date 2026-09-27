# Native Command Code and Antigravity Provider Integration Design

## Status

The approach and scope were approved in conversation. This document is the written-spec review
checkpoint. Implementation and its TDD plan remain blocked until the user approves this document.

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
- Antigravity is an unofficial plugin for Google's internal Cloud Code Assist routes, including
  `v1internal` methods. Its README explicitly warns that use may violate Google's terms and reports
  account suspension/shadow-ban risk. The route and behavior may change without notice.
- The upstream Antigravity repository is MIT licensed. Any copied/adapted source must retain the
  applicable copyright and license notices. Its public OAuth client credentials are not secrets
  and must not be described or handled as confidential.
- The UI design reuses the existing provider catalog and dialogs. The Google risk warning applies
  only to Antigravity; Command Code is an independent service and must not be described as using
  Google endpoints.

## Architecture

### 1. Native provider metadata

Keep hand-maintained first-party provider metadata in a separate, checked-in manifest bundled with
the desktop main process. Validate it with the model-catalog schema and merge it into the runtime
catalog after loading the generated Pi catalog. Do not edit the generated `catalog/models.json` or
make the catalog generator responsible for these models. Add tests proving a generated catalog
refresh cannot remove the first-party entries.

The manifest contains provider/model metadata only: IDs, display names, API protocol, base URL,
supported input modalities, reasoning/tool compatibility, model limits, and pricing availability.
For Command Code, preserve the PR's IDs, names, tier, reasoning/tool-call flags, and limits, but omit
its unitless `cost` values from Modus cost calculations. Make catalog cost optional for these models
and carry a pricing-unknown state through the model detail/usage surfaces; never display unknown as
zero/free. If Pi's internal model type requires numeric cost, any internal placeholder must remain
tagged unknown and must not appear as a monetary estimate. Do not infer unsupported capabilities.
Keep provider-scoped IDs unchanged, including casing and slashes.

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
- Implement a dedicated Pi-compatible stream adapter for
  `POST https://api.commandcode.ai/alpha/generate` with bearer auth. Translate Pi messages, system
  prompt, tools, and generation settings into the plugin's envelope (`config`, `memory`, `taste`,
  `skills`, `permissionMode`, and `params`). Send only the conversation/tool context needed for the
  request; keep unrelated Modus project memory/context out of the envelope.
- Parse the plugin's SSE-style `data:` lines containing JSON events, including CRLF and `[DONE]`;
  map text, reasoning, tool-input/tool-call, finish-step usage/reason, and errors into Pi stream
  events. Handle both `id` and `toolCallId`; do not silently treat a truncated stream without a
  terminal event as success. Honor Pi cancellation and apply a bounded request timeout.
- Send bearer/content-type and required service headers. Identify the client truthfully as Modus;
  do not send `x-project-slug: opencode` or otherwise impersonate OpenCode. If the service rejects a
  truthful Modus identity and requires an OpenCode identity, stop and return for a scope decision
  rather than spoofing it. Do not claim to be Command Code CLI version `0.26.20`; use a truthful
  Modus adapter/protocol version for any required version header.
- Treat pricing as unknown for these models until currency/unit/rates are verified. Do not feed
  the PR's unitless cost numbers into Modus monetary usage accounting or display them as free.
- Reuse the existing provider credential storage and settings flow, but not Pi's stock OpenAI or
  Anthropic API drivers for this custom protocol.

### 3. Antigravity

- Register a first-class `antigravity` provider and a dedicated adapter module in the main process.
  The adapter implements only the OAuth and model request/response behaviors required by Modus;
  it does not invoke OpenCode plugin APIs.
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
  multiple accounts.
- Persist OAuth credentials through Modus' existing provider credential storage. Storage inherits
  the application's existing local-file protection; this design does not claim OS-keychain
  encryption. Do not log access/refresh tokens, authorization codes, or raw credential responses.
- Use the upstream redirect URI `http://localhost:51121/oauth-callback` with a loopback listener
  bound only to localhost, validate OAuth `state` and PKCE verifier, enforce a bounded callback
  lifetime, and clean up listeners on success, cancellation, timeout, and window/app shutdown. If
  the port is occupied, fail clearly rather than binding a less restrictive interface. Token refresh
  failure (including `invalid_grant`) marks the provider as disconnected and requires
  re-authentication.
- The adapter must treat Google's internal API as unstable and unsupported. Do not present
  unofficial client headers, OAuth client values, or endpoint behavior as Google-issued assurances.
  The upstream plugin's emulated client metadata is itself an unsupported compatibility mechanism,
  not evidence that the integration is authorized or endorsed by Google.

### 4. Settings UX

- Add both providers to the existing provider catalog; do not add a settings section or plugin
  manager. Reuse current API-key and OAuth connection dialogs where possible.
- Command Code uses the regular API-key path, is shown as configured but not remotely validated, and
  has no Google-specific warning gate.
- Before Antigravity OAuth begins, show a warning explaining the unofficial internal endpoints,
  the upstream ToS warning, and account-suspension risk. Require an unchecked-by-default explicit
  confirmation. Cancellation must not start OAuth or persist credentials.
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

## Implementation phases and approval gates

1. **Catalog/runtime seam and Command Code:** add the bundled manifest merge and validation,
   register the custom stream adapter, add local nonblank-key entry, and expose the 55
   case-sensitive models with unknown pricing. Gate: schema/merge tests, no-loss generated refresh
   test, exact-ID/metadata assertions, envelope/stream tests, key storage/redaction tests, and
   provider UI flow tests.
2. **Antigravity OAuth and adapter:** implement bounded loopback OAuth/PKCE and refresh, one-account
   credential lifecycle, route/model resolver, and request/SSE transformations. Gate: mocked OAuth
   state/code/refresh/error/cancel tests, model-route mapping, request payload and stream/tool
   normalization tests, no-secret logs, and clean callback teardown.
3. **Risk acknowledgement and integration hardening:** add the mandatory Antigravity warning gate,
   persistent provider detail warning, cancellation/disconnect behavior, and full integration
   regression coverage. Gate: UI tests prove no OAuth starts before acknowledgement and Command
   Code has no incorrect Google warning; desktop typecheck, Biome, focused tests, full suite, and
   packaged build review.

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
  refresh success and `invalid_grant`, timeout, cancellation, and listener cleanup. No live Google
  credentials in automated tests.
- **Antigravity transport:** mock text, reasoning, tool-call, and SSE responses; verify request and
  response transformations, route selection, errors, and secret redaction. No live endpoints in
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
