# Native Command Code and Antigravity Providers Implementation Plan

> **For agentic workers:** Follow the orchestrator's specialist scheduler for delegated tasks or `superpowers:executing-plans` for inline execution. Complete tasks in checkbox order and stop at each verification gate.

**Goal:** Add Command Code's 55-model catalog and Antigravity's 11 documented models as native Modus providers without hosting OpenCode plugins.

**Architecture:** Bundle a first-party manifest separately from Pi's generated catalog and project it into unique Pi custom API registrations. Implement independent Command Code and Antigravity stream adapters; keep OAuth, credentials, and network requests in Electron main, with explicit Antigravity risk acknowledgement enforced at both UI and IPC/service layers.

**Tech Stack:** Electron main/preload/React renderer, TypeScript, `@earendil-works/pi-ai` 0.80.6, `@earendil-works/pi-coding-agent` 0.80.6, Zod, Vitest, Electron Builder.

**Spec:** `docs/superpowers/specs/2026-09-27-native-provider-integrations-design.md`

## Global Constraints

- Keep Node at `>=22.19.0`; do not upgrade Pi dependencies for this work.
- Do not build an OpenCode runtime or load OpenCode plugins.
- Command Code data comes from PR #19 head `7846a5c1d65f7732d69c96a65df74df4d6f3d521`; preserve exact IDs/case.
- Command Code uses its custom `POST /alpha/generate` protocol; do not validate a key by generating a model response.
- Never impersonate OpenCode with `x-project-slug: opencode` or its CLI version. If truthful Modus headers are rejected, stop and request a scope decision.
- Treat Command Code's PR `cost` numbers as unknown; never report them as zero/free or actual billing.
- Antigravity remains explicitly unofficial and unsupported; one account only, OAuth only, and no start without an explicit acknowledgement validated in main/IPC.
- Pin Antigravity catalog/resolver metadata to `16e0056431d0a1291ee66e5938c732720b13a851`. Use deterministic quota routes by exact ID as the user confirmed: five `antigravity-*` and six bare `gemini-*`; never retry/fallback between pools. The six Gemini CLI models are unavailable without a discovered project.
- Antigravity's source declares no per-model tool-call flag; leave it absent. Pi 0.80.6 accepts model inputs `text|image` only, so project its declared `text,image,pdf` modalities to `text,image` and do not claim PDF support.
- Use `http://localhost:51121/oauth-callback`, bind only to loopback, and clean up on cancellation, timeout, and app shutdown.
- Keep keys/tokens out of the catalog, renderer responses, logs, and errors. No live provider credentials in automated tests.
- Preserve MIT notices for any upstream code reused or adapted.
- Validation owner for all tasks: orchestrator. @designer owns user-visible layout/copy/interaction implementation; orchestrator reviews copy and runs final checks.

## File Structure

| File | Responsibility |
|---|---|
| `apps/desktop/src/main/agent/providers/native-provider-manifest.ts` | Validate/merge first-party provider metadata and retain source revision/pricing status. |
| `apps/desktop/src/main/agent/providers/commandcode-models.ts` | Pinned 55-model PR #19 snapshot; no unverified `cost` values. |
| `apps/desktop/src/main/agent/providers/commandcode-models.expected.ts` | Test-only fixture for the exact upstream metadata projection. |
| `apps/desktop/src/main/agent/providers/antigravity-models.ts` | The 11 documented Antigravity/Gemini CLI model IDs and quota route metadata. |
| `apps/desktop/src/main/agent/providers/antigravity-models.expected.ts` | Test-only fixture for exact upstream names, limits, declared variants, and modalities. |
| `apps/desktop/src/main/agent/providers/commandcode-adapter.ts` | Pi-to-Command-Code request envelope, `/alpha/generate` HTTP call, and event-stream conversion. |
| `apps/desktop/src/main/agent/providers/antigravity-oauth.ts` | PKCE, loopback callback, token exchange/refresh, Cloud project discovery, and auth lifecycle. |
| `apps/desktop/src/main/agent/providers/antigravity-adapter.ts` | Antigravity/Gemini CLI route selection and Google internal request/stream transforms. |
| `apps/desktop/src/main/agent/model-service.ts` | Register custom APIs/providers, merge manifest after every catalog load, connect/disconnect, and expose provider metadata. |
| `apps/desktop/src/shared/contracts.ts` | Typed pricing-unknown and acknowledgement/provider state exposed across Electron boundaries. |
| `apps/desktop/src/main/ipc/{schemas.ts,register-app-ipc.ts}` | Validate risk acknowledgement and enforce it before Antigravity OAuth starts. |
| `apps/desktop/src/preload/types.ts` | Typed `startProviderAuth` acknowledgement input. |
| `apps/desktop/src/main/index.ts` | Shut down Antigravity callback/auth operations on `before-quit`. |
| `apps/desktop/src/renderer/src/features/settings/{SettingsPanel.tsx,settings-provider-ui.tsx,sections/model-provider.tsx}` | Provider connection flow, honest status/pricing, risk confirmation and persistent notice. |
| `apps/desktop/src/renderer/src/features/settings/UnofficialProviderNotice.tsx` | Shared, grounded Antigravity risk disclosure and acknowledgement control. |
| `apps/desktop/src/renderer/src/features/settings/providerLogoRegistry.ts` | Map providers to existing logo assets/fallbacks; do not copy unlicensed assets. |
| `apps/desktop/resources/licenses/` and `apps/desktop/electron-builder.config.ts` | Retain and package applicable upstream MIT notices. |

## Dependency Graph

```text
Task 1: manifest/model snapshots
   ├── Task 2: Command Code conversion + stream adapter ──┐
   └── Task 3: Antigravity OAuth + project lifecycle ──┐  │
                                                       ├── Task 4: Antigravity transport
    Task 2 + Task 3 + Task 4 ────────────────────────────── Task 5: registry
    Task 5 ── Task 6: IPC/shutdown lifecycle
    Task 6 ── Task 7: settings UI (designer-owned)
    Tasks 1–7 ── Task 8: notices, packaging, full verification
```

After Task 1, Tasks 2 and 3 use disjoint files and may run in parallel. Task 4 follows Task 3 because it consumes its OAuth/project metadata contract. Registry/IPC wiring waits for both provider adapters. The settings UI waits for service contracts and IPC. Do not have two writers edit the same file concurrently.

## Tasks

### Task 1: Pin and validate the native provider manifest

**Files:**
- Create: `apps/desktop/src/main/agent/providers/native-provider-manifest.ts`
- Create: `apps/desktop/src/main/agent/providers/commandcode-models.ts`
- Create: `apps/desktop/src/main/agent/providers/antigravity-models.ts`
- Create: `apps/desktop/src/main/agent/providers/commandcode-models.expected.ts` (test-only pinned metadata fixture)
- Create: `apps/desktop/src/main/agent/providers/antigravity-models.expected.ts` (test-only pinned metadata fixture)
- Test: `apps/desktop/src/main/agent/providers/native-provider-manifest.test.ts`

**Interfaces:**
- Produces `COMMANDCODE_API_ID = "commandcode-alpha-generate"` and `ANTIGRAVITY_API_ID = "antigravity-cloud-code-assist"` (distinct global Pi API IDs).
- Produces `nativeProviderManifest` with `commandcode` and `antigravity` entries; Command Code includes source commit, provider-specific tier/tool flags, `pricingAvailability: "unknown"`, and text-only input.
- `native-provider-manifest.ts` re-exports `commandCodeModels` and `antigravityModels` from their dedicated data modules so the test/import surface is unambiguous.
- Each manifest model has normalized `id`, `name`, `reasoningSupported`, `contextWindow`, and `maxOutputTokens`; `tier`, `toolCallsSupported`, and `reasoningVariants` are optional. Preserve Command Code's exact `tier`, reasoning/tool flags, and limits with `pricingAvailability: "unknown"` and `input: ["text"]`. Preserve Antigravity's declared name/limits/explicit reasoning variants, exact `quotaRoute`, and `sourceModalities: ["text", "image", "pdf"]`; project Pi input only as `["text", "image"]`. Omit Antigravity `toolCallsSupported` because its source does not declare it.
- Produces `mergeNativeProviderMetadata(baseCatalog, nativeManifest)`, which rejects duplicate provider/model identities and never mutates the input catalog.
- Does not add the entries to generated `catalog/models.json` or make the Pi catalog generator own them.

- [ ] **Step 1: Write the failing snapshot/manifest tests**

```ts
import { describe, expect, it } from "vitest";
import { commandCodeExpectedMetadata } from "./commandcode-models.expected";
import { antigravityExpectedMetadata } from "./antigravity-models.expected";
import {
  COMMANDCODE_PR_HEAD,
  commandCodeModels,
  antigravityModels,
  mergeNativeProviderMetadata,
} from "./native-provider-manifest";

describe("native provider manifest", () => {
  it("pins all 55 Command Code IDs without normalizing case", () => {
    expect(COMMANDCODE_PR_HEAD).toBe("7846a5c1d65f7732d69c96a65df74df4d6f3d521");
    expect(commandCodeModels.map(({ id }) => id)).toEqual([
      "claude-haiku-4-5", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5",
      "claude-sonnet-4-6", "claude-sonnet-5", "claude-fable-5", "gpt-5.3-codex",
      "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol",
      "gpt-5.6-terra", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro",
      "google/gemini-3.1-flash-lite", "google/gemini-3.5-flash", "google/gemini-3.5-flash-lite",
      "google/gemini-3.6-flash", "google/gemini-3.7-flash", "meta/muse-spark-1.1",
      "meta/muse-spark-1.2", "meta/muse-spark-1.2-contributor", "MiniMaxAI/MiniMax-M2.5",
      "MiniMaxAI/MiniMax-M2.7", "MiniMaxAI/MiniMax-M3", "moonshotai/Kimi-K2.5",
      "moonshotai/Kimi-K2.6", "moonshotai/Kimi-K2.7-Code", "moonshotai/Kimi-K2.7-Code-Highspeed",
      "moonshotai/Kimi-K3", "nvidia/nemotron-3-ultra-550b-a55b", "poolside/laguna-s-2.1-free",
      "Qwen/Qwen3.6-Max-Preview", "Qwen/Qwen3.6-Plus", "Qwen/Qwen3.7-Flash",
      "Qwen/Qwen3.7-Max", "Qwen/Qwen3.7-Plus", "Qwen/Qwen3.8-Max", "sakana/fugu-ultra",
      "stepfun/Step-3.5-Flash", "stepfun/Step-3.7-Flash", "tencent/hy3-paid",
      "thinkingmachines/inkling", "thinkingmachines/inkling-small", "xai/grok-4.5", "xai/grok-4.6",
      "xiaomi/mimo-v2.5", "xiaomi/mimo-v2.5-pro", "zai-org/GLM-5", "zai-org/GLM-5.1",
      "zai-org/GLM-5.2", "zai-org/GLM-5.2-Fast", "zai-org/GLM-5.3",
    ]);
  });

  it("pins the 11 quota-specific Google model IDs", () => {
    expect(antigravityModels.map(({ id }) => id)).toEqual([
      "antigravity-gemini-3-pro", "antigravity-gemini-3.1-pro", "antigravity-gemini-3-flash",
      "antigravity-claude-sonnet-4-6", "antigravity-claude-opus-4-6-thinking",
      "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-3-pro-preview",
      "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
    ]);
    expect(antigravityModels.slice(0, 5).every((model) => model.quotaRoute === "antigravity")).toBe(true);
    expect(antigravityModels.slice(5).every((model) => model.quotaRoute === "gemini-cli")).toBe(true);
  });

  it("preserves pinned Antigravity names, limits, reasoning variants, and source modalities", () => {
    expect(antigravityModels.map(({
      id, name, quotaRoute, contextWindow, maxOutputTokens, reasoningSupported,
      reasoningVariants, sourceModalities, input,
    }) => ({
      id, name, quotaRoute, contextWindow, maxOutputTokens, reasoningSupported,
      reasoningVariants, sourceModalities, input,
    }))).toEqual(antigravityExpectedMetadata);
    expect(antigravityModels.every((model) => !("toolCallsSupported" in model))).toBe(true);
  });

  it("marks Command Code pricing unknown and rejects collisions", () => {
    expect(commandCodeModels.every((model) => model.pricingAvailability === "unknown")).toBe(true);
    expect(commandCodeModels.every((model) => !("cost" in model))).toBe(true);
    expect(() => mergeNativeProviderMetadata(
      { providers: { commandcode: [{ id: "gpt-5.4" }] } },
      { providers: { commandcode: commandCodeModels } },
    )).toThrow(/collision/i);
  });

  it("preserves the pinned display, capability, tier, and limit metadata", () => {
    expect(commandCodeModels.map(({
      id, name, tier, reasoningSupported, toolCallsSupported, contextWindow, maxOutputTokens,
    }) => ({ id, name, tier, reasoningSupported, toolCallsSupported, contextWindow, maxOutputTokens })))
      .toEqual(commandCodeExpectedMetadata);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the manifest is missing**

Run from repository root: `npx vitest run --root . apps/desktop/src/main/agent/providers/native-provider-manifest.test.ts`

Expected: FAIL with module-not-found / missing exports.

- [ ] **Step 3: Add the typed manifest and static model data**

Read Command Code `models.json` at PR head `7846a5c1d65f7732d69c96a65df74df4d6f3d521` and Antigravity catalog/resolver at commit `16e0056431d0a1291ee66e5938c732720b13a851`. Add test-only expected fixtures copied from those exact source fields (excluding Command Code `cost`) and compare all Command Code IDs/names/tiers/reasoning/tool flags/limits plus Antigravity IDs/names/fixed routes/limits/declared variants/source modalities. Antigravity's Pi projection supports only source-declared `text,image`; preserve `pdf` in `sourceModalities` only. Keep `toolCallsSupported` absent for Antigravity. Define `reasoningVariants` only for source-declared variants; do not fabricate variants from resolver defaults. In production data, omit unitless `cost` values and do not infer Command Code image support. Put all 11 Antigravity IDs in the manifest with the user-approved fixed `quotaRoute`. Implement a Zod schema for the separate manifest, unique provider/model checks, both `sourceCommit` values, and a pure merge that rejects collisions without mutating generated data; re-export both model arrays from `native-provider-manifest.ts`.

- [ ] **Step 4: Run the focused tests and verify exact IDs and metadata**

Run: `npx vitest run --root . apps/desktop/src/main/agent/providers/native-provider-manifest.test.ts`

Expected: PASS; arrays match both pinned source fixtures and exact ID order/case; pricing stays unknown; the Antigravity fixture contains no inferred tool-call flag.

- [ ] **Step 5: Commit the manifest task**

```powershell
git add apps/desktop/src/main/agent/providers/native-provider-manifest.ts apps/desktop/src/main/agent/providers/commandcode-models.ts apps/desktop/src/main/agent/providers/antigravity-models.ts apps/desktop/src/main/agent/providers/commandcode-models.expected.ts apps/desktop/src/main/agent/providers/antigravity-models.expected.ts apps/desktop/src/main/agent/providers/native-provider-manifest.test.ts
git commit -m "feat(models): add native provider manifest"
```

### Task 2: Implement the Command Code request envelope and stream adapter

**Files:**
- Create: `apps/desktop/src/main/agent/providers/commandcode-adapter.ts`
- Test: `apps/desktop/src/main/agent/providers/commandcode-adapter.test.ts`

**Interfaces:**
- `CommandCodeInput` is `{ modelId: string; systemPrompt?: string; messages: Array<{ role: string; content: unknown }>; tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>; maxTokens?: number; temperature?: number; topP?: number; topK?: number }`.
- `buildCommandCodeRequest(input, { apiKey, sessionId })` returns the URL, truthful Modus headers, and JSON body for `/alpha/generate`.
- `parseCommandCodeEvents(response)` yields normalized Command Code events from the stream; `commandCodeStream` maps them to Pi events.
- `mapCommandCodeResponse(response, modelId)` is the testable response-to-Pi stream mapper called by `commandCodeStream`.
- `commandCodeStream` implements the per-provider `ModelRegistry.registerProvider` `streamSimple` callback `(model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream`; derive the callback type from the installed registry/Pi provider interface instead of duplicating it with `any`. Return an `AssistantMessageEventStream` synchronously via `createAssistantMessageEventStream()` and push events into it.
- A terminal `finish-step` produces Pi `done` with the complete assistant message; an upstream error or incomplete stream produces Pi `error`.

- [ ] **Step 1: Write failing request-envelope tests**

```ts
it("preserves the model ID and sends only the supported conversation fields", () => {
  const request = buildCommandCodeRequest({
    modelId: "Qwen/Qwen3.7-Flash",
    systemPrompt: "Use tools when needed.",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
    maxTokens: 4096,
  }, {
    apiKey: "user_test_secret",
    sessionId: "session-1",
  });

  expect(request.url).toBe("https://api.commandcode.ai/alpha/generate");
  expect(request.headers.Authorization).toBe("Bearer user_test_secret");
  expect(request.headers["x-project-slug"]).not.toBe("opencode");
  expect(request.body.params.model).toBe("Qwen/Qwen3.7-Flash");
  expect(request.body.params.stream).toBe(true);
  expect(request.body.params.tools).toEqual([
    { name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } },
  ]);
  expect(request.body).not.toHaveProperty("memory.projectMemory");
  expect(request.body.params.messages).toEqual([{ role: "user", content: "hello" }]);
});
```

- [ ] **Step 2: Run the adapter test and confirm it fails**

Run: `npx vitest run --root . apps/desktop/src/main/agent/providers/commandcode-adapter.test.ts`

Expected: FAIL because `buildCommandCodeRequest` and `commandCodeStream` do not exist.

- [ ] **Step 3: Implement the pure request mapper**

Map the exact model ID, system prompt, user/assistant/tool messages, tools, and supported generation settings into the plugin's `config`, `memory`, `taste`, `skills`, `permissionMode`, and `params` envelope. Keep unrelated Modus memory/project metadata out. Include bearer/content type and required service headers, but identify the client truthfully as Modus; do not send OpenCode's slug/version. Set no image input until the source converter supports it.

- [ ] **Step 4: Re-run the request-envelope tests**

Run: `npx vitest run --root . apps/desktop/src/main/agent/providers/commandcode-adapter.test.ts`

Expected: PASS for the request fields, exact case-sensitive model ID, no image leakage, and no OpenCode identity.

- [ ] **Step 5: Add failing stream-parser tests for data lines and terminal events**

```ts
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of stream) result.push(item);
  return result;
}

it("maps text, reasoning, tool calls, usage, and finish-step to a complete Pi message", async () => {
  const response = new Response([
    `data: ${JSON.stringify({ type: "text-delta", delta: "hello" })}\r\n`,
    `data: ${JSON.stringify({ type: "reasoning-delta", delta: "check" })}\r\n`,
    `data: ${JSON.stringify({ type: "tool-call", toolCallId: "call-1", name: "read", arguments: "{}" })}\r\n`,
    `data: ${JSON.stringify({ type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 4, outputTokens: 2 } })}\r\n`,
    "data: [DONE]\r\n",
  ].join(""));
  const events = await collect(mapCommandCodeResponse(response, "Qwen/Qwen3.7-Flash"));

  expect(events.at(-1)?.type).toBe("done");
  expect(events.at(-1)?.message.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "call-1" }));
});

it("emits Pi error on EOF without finish-step", async () => {
  const response = new Response(`data: ${JSON.stringify({ type: "text-delta", delta: "partial" })}\n`);
  const events = await collect(mapCommandCodeResponse(response, "Qwen/Qwen3.7-Flash"));
  expect(events.at(-1)?.type).toBe("error");
});

it("maps an upstream error event to Pi error", async () => {
  const response = new Response(`data: ${JSON.stringify({ type: "error", message: "invalid request" })}\n`);
  const events = await collect(mapCommandCodeResponse(response, "Qwen/Qwen3.7-Flash"));
  expect(events.at(-1)?.type).toBe("error");
});
```

- [ ] **Step 6: Run stream tests red, implement parser/stream mapping, then run green**

Run before implementation: `npx vitest run --root . apps/desktop/src/main/agent/providers/commandcode-adapter.test.ts`

Expected first: FAIL for unimplemented event mapping. Implement CRLF and `data:` line parsing, `[DONE]`, text/reasoning/tool-input/tool-call/usage/error events, both `id` and `toolCallId`, abort propagation, bounded timeout, and complete Pi terminal events using `createAssistantMessageEventStream()`, `push()`, and `end()`. `commandCodeStream` returns synchronously while its async request/parser work runs; every terminal event must use Pi's exact `done`/`error` union and complete `AssistantMessage`. Re-run the same command; expected final: PASS, including EOF-without-`finish-step` => `error`.

- [ ] **Step 7: Commit the Command Code adapter**

```powershell
git add apps/desktop/src/main/agent/providers/commandcode-adapter.ts apps/desktop/src/main/agent/providers/commandcode-adapter.test.ts
git commit -m "feat(models): add Command Code stream adapter"
```

### Task 3: Implement Antigravity OAuth, project discovery, and credential lifecycle

**Files:**
- Create: `apps/desktop/src/main/agent/providers/antigravity-oauth.ts`
- Test: `apps/desktop/src/main/agent/providers/antigravity-oauth.test.ts`

**Interfaces:**
- `createAntigravityOAuthProvider(deps)` returns the Pi-compatible OAuth hooks and a lifecycle handle used by cancellation/shutdown.
- `shutdownAntigravityAuth()` closes all local callback listeners and invalidates active operation generations.
- Credential metadata includes the discovered Cloud project ID where available; it is stored through Pi `AuthStorage`, not through renderer IPC or a parallel plaintext file.

- [ ] **Step 1: Write failing OAuth URL/state/PKCE tests**

Assert the authorize URL uses the upstream redirect URI `http://localhost:51121/oauth-callback`, PKCE S256, the required scopes, a unique state, and `access_type=offline`. Assert callback state mismatch, missing code, and expired operation return sanitized errors and close the listener.

- [ ] **Step 2: Run OAuth tests red**

Run: `npx vitest run --root . apps/desktop/src/main/agent/providers/antigravity-oauth.test.ts`

Expected: FAIL because the OAuth service/exports do not exist.

- [ ] **Step 3: Implement loopback authorization and token exchange**

Bind only to `localhost`/loopback on port `51121`; never fall back to `0.0.0.0`. Validate state and PKCE before exchanging the code at Google's token endpoint. Inject `fetch`, clock, and callback-server factory so tests use mocks; redact tokens and codes from errors/logs.

- [ ] **Step 4: Add failing token-refresh and project-discovery tests**

Test successful refresh, permanent `invalid_grant`, transient HTTP/network failure, `loadCodeAssist` returning a project ID, and no usable project. Assert transient failures preserve refresh credentials; permanent rejection requests re-auth; six Gemini CLI quota models become unavailable without a project ID; do not substitute a project ID.

- [ ] **Step 5: Run OAuth lifecycle tests red, implement guarded refresh, run green**

Run: `npx vitest run --root . apps/desktop/src/main/agent/providers/antigravity-oauth.test.ts`

Implement a monotonically increasing credential/operation generation; after every awaited refresh/discovery operation, reject stale results if the account was disconnected or replaced. Close listeners on callback, cancel, timeout, and shutdown. Verify both IPv4 and IPv6 resolution of `localhost` in loopback tests. Re-run; expected: PASS.

- [ ] **Step 6: Commit OAuth service**

```powershell
git add apps/desktop/src/main/agent/providers/antigravity-oauth.ts apps/desktop/src/main/agent/providers/antigravity-oauth.test.ts
git commit -m "feat(models): add Antigravity OAuth lifecycle"
```

### Task 4: Implement Antigravity model routing and stream conversion

**Files:**
- Create: `apps/desktop/src/main/agent/providers/antigravity-adapter.ts`
- Test: `apps/desktop/src/main/agent/providers/antigravity-adapter.test.ts`

**Consumes:** Task 1's model/quota manifest and Task 3's access-token/project metadata.

**Produces:** `antigravityStream` for Pi's custom `streamSimple` API ID; route selection is based on the exact model metadata, not fuzzy/case-normalized IDs.

- [ ] **Step 1: Write failing route/request-transform tests**

Assert exact `quotaRoute` dispatch: five `antigravity-*` IDs use Antigravity quota and six bare `gemini-*` IDs use Gemini CLI quota. Verify the actual route selection in the request without assuming distinct hostnames; exact model IDs and discovered project ID are preserved. Assert missing project makes Gemini CLI models unavailable and never substitutes Antigravity, and quota/HTTP errors never retry across pools. Assert tools and reasoning parameters map from Pi context using the pinned resolver behavior.

- [ ] **Step 2: Run the adapter test red**

Run: `npx vitest run --root . apps/desktop/src/main/agent/providers/antigravity-adapter.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement request routing and transforms**

Use a unique API ID `antigravity-cloud-code-assist`; implement the specific `v1internal` route/payload transforms from Antigravity commit `16e0056431d0a1291ee66e5938c732720b13a851` needed for the 11 models. Follow `quotaRoute` exactly; do not implement the upstream `cli_first` pool preference or any cross-pool fallback. Preserve tool pairing, thinking/signature fields, image input only where both the source model and Pi can represent it. Do not expose project credentials or unrelated workspace context.

- [ ] **Step 4: Add failing JSON/SSE response and error tests**

Cover non-streaming JSON and SSE event handling, text/reasoning/tool-call deltas, finish/usage conversion, malformed events, no terminal event, abort, HTTP error status, and sanitized errors. Assert emitted Pi `done` includes the full assistant message and failures end in Pi `error`.

- [ ] **Step 5: Implement response normalization and run tests green**

Run: `npx vitest run --root . apps/desktop/src/main/agent/providers/antigravity-adapter.test.ts`

Expected: PASS for both routes, transformations, errors, abort, and terminal event handling. No live Google requests or credentials.

- [ ] **Step 6: Commit Antigravity transport**

```powershell
git add apps/desktop/src/main/agent/providers/antigravity-adapter.ts apps/desktop/src/main/agent/providers/antigravity-adapter.test.ts
git commit -m "feat(models): add Antigravity model adapter"
```

### Task 5: Register native providers and preserve them across catalog refresh

**Files:**
- Modify: `apps/desktop/src/main/agent/model-service.ts`
- Modify: `apps/desktop/src/shared/contracts.ts`
- Test: `apps/desktop/src/main/agent/model-service.test.ts`

**Consumes:** Tasks 1–4's manifest, custom API IDs, stream adapters, and OAuth hooks.

**Produces:** First-party providers rebuilt on every `refreshRegistry()`/remote catalog update; Command Code connection method is API key only; Antigravity connection method is OAuth only; pricing status is typed as `ModelProviderInfo.pricingAvailability?: "published" | "unknown"`.

- [ ] **Step 1: Write failing registry-merge tests**

Test both providers appear before and after a remote catalog refresh; an existing OpenAI provider still uses Pi's stock API; a collision with a remote provider/model is rejected; the first-party manifest is not written to the remote catalog cache; Command Code model IDs retain case; pricing status is `unknown`.

- [ ] **Step 2: Run `model-service` tests red**

Run: `npx vitest run --root . apps/desktop/src/main/agent/model-service.test.ts`

Expected: FAIL because first-party providers are filtered out or metadata is absent.

- [ ] **Step 3: Add manifest-to-Pi registration projection**

Keep the existing generated catalog schema unchanged. Add a dedicated projection path that registers first-party providers after every bundled/cached/fetched catalog application. Supply Pi-required numeric placeholders only to Pi's model registry; carry `pricingAvailability: "unknown"` in Modus metadata so renderer/usage UI never treats placeholder zero as free. For each native provider, call `ModelRegistry.registerProvider` with its unique `api`, `streamSimple` callback, and projected `models`; the callback is the supported runtime seam and ModelRegistry binds it into Pi's compat registry by API ID, then re-applies it after refresh. Ensure every projected model's `api` matches the provider's unique API ID. Do not call `registerApiProvider` directly, edit `pi-sdk-runtime.ts`, or persist stream callbacks in `models.json`. Unregister stale first-party provider configs without touching Pi built-ins or user custom providers.

- [ ] **Step 4: Add failing Command Code key tests**

Test trimming/rejection of blank keys, saving nonblank keys to `AuthStorage`, no network/fetch during connection, no key in `models.json` or provider detail, and connection state labeled not remotely validated. Test `listProviderConnectionMethods("commandcode")` returns only API key and `listProviderConnectionMethods("antigravity")` returns only OAuth.

- [ ] **Step 5: Run the focused registry tests red, implement connection projection, run green**

Run: `npx vitest run --root . apps/desktop/src/main/agent/model-service.test.ts`

Expected final: PASS for provider rebuild, refresh preservation, unique custom APIs, stock-provider isolation, credential storage, exact IDs, pricing unknown, and no remote key probe.

- [ ] **Step 6: Commit registry integration**

```powershell
git add apps/desktop/src/main/agent/model-service.ts apps/desktop/src/shared/contracts.ts apps/desktop/src/main/agent/model-service.test.ts
git commit -m "feat(models): register native providers"
```

### Task 6: Guard Antigravity OAuth at IPC and own shutdown lifecycle

**Files:**
- Modify: `apps/desktop/src/main/agent/model-service.ts`
- Modify: `apps/desktop/src/main/ipc/schemas.ts`
- Modify: `apps/desktop/src/main/ipc/register-app-ipc.ts`
- Modify: `apps/desktop/src/preload/types.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/src/main/ipc/schemas.test.ts`
- Test: `apps/desktop/src/main/ipc/register-app-ipc.test.ts`
- Test: `apps/desktop/src/main/agent/model-service.test.ts`

**Interfaces:** The preload/IPC payload is `{ provider: string; riskAcknowledged?: true }`. The main service adds an options parameter `{ riskAcknowledged?: true }` to `startProviderAuth(provider, openExternal, options)`. For `provider === "antigravity"`, both Zod/IPC and the main service require `riskAcknowledged === true`; all other existing providers retain their current behavior. `shutdownProviderAuthOperations()` cancels operations and closes Antigravity listeners.

- [ ] **Step 1: Write failing schema and service guard tests**

Assert `{provider:"antigravity"}` and `{provider:"antigravity", riskAcknowledged:false}` are rejected, `{provider:"antigravity", riskAcknowledged:true}` parses, and normal provider auth still parses without the new field. Assert a direct service call without acknowledgement throws before browser launch/listener creation.

- [ ] **Step 2: Run IPC/service tests red**

Run: `npx vitest run --root . apps/desktop/src/main/ipc/schemas.test.ts apps/desktop/src/main/ipc/register-app-ipc.test.ts apps/desktop/src/main/agent/model-service.test.ts`

Expected: FAIL because the schema and service do not enforce acknowledgement.

- [ ] **Step 3: Add provider-specific acknowledgement validation**

Extend `providerAuthStartSchema` with optional literal-true `riskAcknowledged` and a provider-specific refinement for `antigravity`. Pass the parsed field through the IPC handler and preload type. Re-check in `startProviderAuth` before registering OAuth or opening a browser; do not rely on renderer gating.

- [ ] **Step 4: Add failing lifecycle/shutdown tests**

Assert cancel closes callback listener, `before-quit` calls `shutdownProviderAuthOperations()`, a late refresh cannot restore credentials after disconnect, and a transient refresh error does not delete the refresh token.

- [ ] **Step 5: Implement teardown and re-auth state, then run tests green**

Wire `shutdownProviderAuthOperations()` into `app.on("before-quit")`; on permanent `invalid_grant`, clear the rejected credential/mark re-auth required, but retain credentials on transient network failures. Re-run the tests above; expected: PASS.

- [ ] **Step 6: Commit guarded OAuth lifecycle**

```powershell
git add apps/desktop/src/main/agent/model-service.ts apps/desktop/src/main/ipc/schemas.ts apps/desktop/src/main/ipc/register-app-ipc.ts apps/desktop/src/preload/types.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc/schemas.test.ts apps/desktop/src/main/ipc/register-app-ipc.test.ts apps/desktop/src/main/agent/model-service.test.ts
git commit -m "feat(models): guard Antigravity OAuth lifecycle"
```

### Task 7: Implement provider settings UX (designer-owned)

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx`
- Modify: `apps/desktop/src/renderer/src/features/settings/settings-provider-ui.tsx`
- Modify: `apps/desktop/src/renderer/src/features/settings/sections/model-provider.tsx`
- Modify: `apps/desktop/src/renderer/src/features/settings/providerLogoRegistry.ts`
- Create: `apps/desktop/src/renderer/src/features/settings/UnofficialProviderNotice.tsx`
- Test: `apps/desktop/src/renderer/src/features/settings/model-provider.test.tsx`
- Modify/Test: `apps/desktop/src/renderer/src/features/settings/settingsNavigation.test.tsx`
- Modify/Test: `apps/desktop/src/renderer/src/features/settings/providerLimits.test.ts`

**Owner:** @designer implements the interaction and visual details using the approved spec and existing `ProviderConfigDialogShell`; orchestrator reviews copy and validates behavior.

- [ ] **Step 1: Write failing settings tests**

Test Command Code's catalog summary (`55 models · API key · pricing unknown`, then `55 models · key saved · unverified` when configured), its `API key saved — not verified` detail label, `pricing unknown` chip and pricing preamble, and absence of Google copy or `$0`/`Free`/numeric cost placeholders. Test that Antigravity's catalog row shows `11 models · OAuth only · unofficial endpoints` plus a warning glyph/tooltip, offers OAuth but no API-key path, and shows the persistent warning only while configured. Assert the warning/interstitial identify the integration as unofficial, state the terms/account-action risk, and do not promise safety. Test the interstitial's unchecked-by-default checkbox, disabled primary action until checked, cancel-without-auth, and confirmed `riskAcknowledged: true`; verify the warning remains after successful OAuth and disappears after disconnect. Extend provider-limits coverage to prove unknown-priced Command Code models do not enter cost/budget totals or render synthetic zero pricing.

- [ ] **Step 2: Run the settings test red**

Run: `npx vitest run --root . apps/desktop/src/renderer/src/features/settings/model-provider.test.tsx apps/desktop/src/renderer/src/features/settings/settingsNavigation.test.tsx apps/desktop/src/renderer/src/features/settings/providerLimits.test.ts`

Expected: FAIL because the providers and warning/status surfaces are not wired.

- [ ] **Step 3: Implement the minimal provider catalog and credential statuses**

Use the existing provider row and detail dialogs. Set the catalog summaries to `55 models · API key · pricing unknown` / `55 models · key saved · unverified` for Command Code and `11 models · OAuth only · unofficial endpoints` / `11 models · signed in` for Antigravity, according to configuration state. Add a `pricing unknown` chip and the line `Pricing is not published for these models and is not shown to avoid implying any cost.` in Command Code details; ensure these models are excluded from cost/budget totals and show no zero/free placeholder. Show the configured key as `API key saved — not verified`. Add the Antigravity warning glyph and hover text `Uses unofficial Google internal endpoints. See the risk notice in Configure.` Use existing logo aliases/fallbacks; do not add external assets without a verified license.

- [ ] **Step 4: Add the Antigravity acknowledgement interstitial and persistent warning**

Use the existing dialog shell and warning styling. Add an unchecked-by-default interstitial before the existing OAuth dialog. Ground its copy in the spec: the provider uses unofficial internal Cloud Code Assist endpoints, including undocumented methods; upstream warns of terms-of-service and account-suspension/restriction risk; Modus cannot guarantee an outcome or make the integration supported, legal, or safe. Only the explicit confirmation calls the preload method with `riskAcknowledged: true`; cancellation closes without invoking auth or persisting credentials. Keep a compact `Unofficial provider` notice in configured Antigravity details. Keep the Antigravity connection OAuth-only and expose disconnect; Command Code receives no Google-related copy.

- [ ] **Step 5: Run settings tests green and review copy**

Run: `npx vitest run --root . apps/desktop/src/renderer/src/features/settings/model-provider.test.tsx apps/desktop/src/renderer/src/features/settings/settingsNavigation.test.tsx apps/desktop/src/renderer/src/features/settings/providerLimits.test.ts`

Expected: PASS for catalog/detail states, method visibility, labels, risk gating, no-start-on-cancel, persistent warning/disconnect behavior, and no false cost or budget total. Orchestrator verifies copy against the upstream warning before accepting the UI lane.

- [ ] **Step 6: Commit the provider UX**

```powershell
git add apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx apps/desktop/src/renderer/src/features/settings/settings-provider-ui.tsx apps/desktop/src/renderer/src/features/settings/sections/model-provider.tsx apps/desktop/src/renderer/src/features/settings/providerLogoRegistry.ts apps/desktop/src/renderer/src/features/settings/UnofficialProviderNotice.tsx apps/desktop/src/renderer/src/features/settings/model-provider.test.tsx apps/desktop/src/renderer/src/features/settings/settingsNavigation.test.tsx apps/desktop/src/renderer/src/features/settings/providerLimits.test.ts
git commit -m "feat(settings): add provider connection disclosures"
```

### Task 8: Preserve upstream notices and verify the full desktop build

**Files:**
- Create: `apps/desktop/resources/licenses/commandcode-provider-MIT.txt`
- Create: `apps/desktop/resources/licenses/antigravity-auth-MIT.txt`
- Modify: `apps/desktop/electron-builder.config.ts`
- Test/update: provider adapter and model service tests as required by integration findings.

- [ ] **Step 1: Add the exact upstream MIT license texts**

Copy each license from the pinned Command Code provider revision and Antigravity commit `16e0056431d0a1291ee66e5938c732720b13a851`, retaining copyright/permission text. Add the license directory to Electron Builder `extraResources`; do not bundle OAuth tokens, `.env`, or provider keys.

- [ ] **Step 2: Run focused tests for both adapters, registry, IPC, and UI**

Run:

```powershell
npx vitest run --root . apps/desktop/src/main/agent/providers/native-provider-manifest.test.ts apps/desktop/src/main/agent/providers/commandcode-adapter.test.ts apps/desktop/src/main/agent/providers/antigravity-oauth.test.ts apps/desktop/src/main/agent/providers/antigravity-adapter.test.ts apps/desktop/src/main/agent/model-service.test.ts apps/desktop/src/main/ipc/schemas.test.ts apps/desktop/src/main/ipc/register-app-ipc.test.ts apps/desktop/src/renderer/src/features/settings/model-provider.test.tsx apps/desktop/src/renderer/src/features/settings/settingsNavigation.test.tsx apps/desktop/src/renderer/src/features/settings/providerLimits.test.ts
```

Expected: all selected tests pass; no live Command Code or Google credentials are used.

- [ ] **Step 3: Run repository lint/type checks and the complete desktop suite**

Run: `npm run check`

Then run: `npm --workspace @modus/desktop run test`

Expected: Biome, typecheck, and all desktop Vitest tests pass. Compare any baseline failures before attributing them to this change.

- [ ] **Step 4: Build and package the desktop app**

Run: `npm --workspace @modus/desktop run build`

Then, where the Windows packaging prerequisites are available, run: `npm --workspace @modus/desktop run package:win`

Expected: Electron main bundle contains the manifest/adapters and the packaged resources contain both MIT notices. If packaging cannot run because a pre-existing native/toolchain prerequisite is missing, report that exact limitation without claiming package verification.

- [ ] **Step 5: Enforce the Command Code truthful-identity stop condition**

Do not use user credentials or perform a live request unless the user explicitly provides/authorizes a test key. If a later authorized request rejects a truthful Modus header and requires `x-project-slug: opencode` or OpenCode CLI version, stop; do not spoof the identity. Report the incompatibility and request a scope decision.

- [ ] **Step 6: Review final diff and commit**

Run `git diff --check`, inspect `git status --short`, confirm only intended provider/settings/license files are staged, and verify no credentials are present. Commit with `feat(models): add Command Code and Antigravity providers` only after all available checks pass.

## Execution Handoff

After approval of this plan and the user's execution-mode choice, implementation can proceed in two independent specialist lanes after Task 1:

1. **Delegated lanes (recommended):** @fixer handles Command Code adapter + registry tasks; a separate @fixer handles Antigravity OAuth/transport with disjoint files; @designer owns Task 7. The orchestrator owns shared integration, reviews, IPC guard and final validation. Do not run overlapping writers on `model-service.ts` concurrently.
2. **Inline execution:** execute non-visual tasks in this session, one task and verification gate at a time; route Task 7 to @designer as required for user-facing UI work.

The truthful-header compatibility gate, Antigravity OAuth acknowledgement gate, and full-suite verification are mandatory in either mode.

## PR Review Remediation (2026-09-27)

**Approved scope:** Keep both providers. Do not send `x-project-slug: opencode` or claim an OpenCode identity. Keep the truthful Modus slug; if a later authorized request proves that the service rejects it, stop and ask for a scope decision. Do not use live credentials during automated verification.

**Verification evidence path:** Add literal pinned-protocol fixtures for Command Code requests/events and Antigravity response envelopes; add controlled interaction tests for acknowledgement reopening and credential disconnect races; test shutdown against a stalled loopback connection. Run the affected provider/settings tests, desktop typecheck, full desktop suite, desktop build, Windows package, and `git diff --check`. No live provider request is part of this plan. The Antigravity Gemini `functionResponse` input translation follows the pinned helper's `name`/`id`/`response.result` shape, but its Pi-to-functionResponse conversion is not established by that source and must be disclosed as unverified without a live authorized check.

**Work graph:** R1 (Command Code), R2 (Antigravity), and R3 (settings acknowledgement) own disjoint files and can run independently. R4 (auth disconnect/shutdown) waits for an independent design check of Pi AuthStorage cancellation semantics, then owns the remaining service/OAuth files. Orchestrator owns integration, final review, and verification.

### R1: Align Command Code wire conversion and sanitize failures

**Files:** `apps/desktop/src/main/agent/providers/commandcode-adapter.ts` and its `.test.ts`.

- [ ] Add failing fixture tests from pinned commit `7846a5c1d65f7732d69c96a65df74df4d6f3d521` for `params.system`, `max_tokens`, function tools (`type: "function"`, `input_schema`), memory/taste strings, `skills: null`, standard permission mode, `toolName`/`input` response events, and the provider's `role: "tool"`/`tool-result` continuation message.
- [ ] Match the pinned payload and non-identity service headers. Keep `x-project-slug: modus` and Modus client identity; never copy the upstream OpenCode slug. Convert provider error events/HTTP failures to fixed sanitized messages that do not forward arbitrary response text.
- [ ] Run `npx vitest run --root . apps/desktop/src/main/agent/providers/commandcode-adapter.test.ts`; verify the fixture tests fail before production changes and pass afterward.

### R2: Parse Antigravity envelopes and preserve incremental/tool turns

**Files:** `apps/desktop/src/main/agent/providers/antigravity-adapter.ts` and its `.test.ts`.

- [ ] Add failing tests with pinned response-envelope fixtures `{ response: { candidates, usageMetadata }, traceId }` for text, thinking, function calls, usage, malformed events, and terminal events; assert Pi text/thinking/tool-call deltas as chunks arrive as well as a complete final message.
- [ ] Preserve tool-call name/ID and translate a following Pi tool result into the Google-style `functionResponse` part (`name`, matching `id`, and `response.result`) used by the pinned helper representation. Do not claim the pinned plugin proves the Pi-to-Gemini conversion; keep this limitation explicit.
- [ ] Map Claude Opus `max` to the pinned 32,768 thinking budget and 64,000 output-token behavior. Keep exact quota routes and no cross-pool retry.
- [ ] Run `npx vitest run --root . apps/desktop/src/main/agent/providers/antigravity-adapter.test.ts`; verify new fixture tests fail before implementation and pass afterward.

### R3: Reset risk acknowledgement on every dialog open

**Files:** `apps/desktop/src/renderer/src/features/settings/sections/model-provider.tsx` and `model-provider.test.tsx`.

- [ ] Add a real-interaction regression: acknowledge, cancel/close while the dialog owner remains mounted, reopen, then verify the checkbox is unchecked and Continue is disabled until a fresh click.
- [ ] Reset acknowledgement state on close/reopen without changing the approved disclosure copy or layout; preserve the SettingsPanel-to-preload payload test.
- [ ] Run the focused settings test and desktop typecheck.

### R4: Make disconnect and shutdown invalidate pending auth safely

**Files:** `apps/desktop/src/main/agent/model-service.ts`, `model-service.test.ts`, `providers/antigravity-oauth.ts`, and `antigravity-oauth.test.ts`.

- [ ] Establish whether Pi `AuthStorage.login()` persists credentials before or after its abort signal settles. Add a deferred-login regression proving disconnect leaves credentials/config cleared and stale completion cannot undo disconnect or erase a newer login.
- [ ] Cancel/invalidate provider auth operations before disconnect clears credentials; use generation/serialization or lock-backed cleanup appropriate to verified AuthStorage behavior.
- [ ] Start the shutdown budget before listener teardown and ensure active loopback sockets are force-closed or bounded within that overall deadline; test with a stalled connection and a short injected deadline.
- [ ] Run focused OAuth/model-service tests, then the full desktop suite.

## Final Review Remediation (2026-09-27)

**Approved OAuth identity:** Use only the user-provided public Google Desktop OAuth client ID registered for Modus. Do not reuse the pinned Antigravity application's client ID or secret. Google Desktop PKCE uses no `client_secret`; remove the runtime environment-variable dependency and omit that request field. Do not make a live OAuth request or claim the unofficial endpoints are approved.

**Work graph:** R7 (Command Code Pi message/header/event correction) and R8 (Antigravity native OAuth/tool-result/reasoning/refresh-disconnect correction) have disjoint write ownership and may run in parallel. The pinned Antigravity reasoning catalog research is a dependency for R8's reasoning changes. Orchestrator owns final full-suite/typecheck/build/package checks, review, commit, and PR.

### R7: Correct Command Code identity and actual Pi tool-result conversion

**Files:** `apps/desktop/src/main/agent/providers/commandcode-adapter.ts` and its `.test.ts` only.

- [ ] Add failing tests using actual Pi `ToolResultMessage` shape (`role: "toolResult"`, top-level `toolCallId`, `toolName`, `isError`, `content`) for success and error results; convert them to the pinned Command Code `role: "tool"`/`tool-result` continuation format.
- [ ] Replace the false `x-command-code-version: 0.26.20` value with a truthful Modus adapter/protocol version as required by the approved design; preserve `x-project-slug: modus` and never send an OpenCode identity. Compatibility of this truthful version with the live service remains unverified; if rejected, stop rather than impersonate the CLI.
- [ ] Add regression coverage for complete `tool-input-start` → delta → end Pi event sequencing, including `toolcall_start` before `toolcall_end`.
- [ ] Run the focused adapter tests RED→GREEN and verify no provider response text can leak through sanitized errors.

### R8: Make Antigravity usable with Modus identity and real Pi messages

**Files:** `model-service.ts` / `.test.ts`, `providers/antigravity-oauth.ts` / `.test.ts`, `providers/antigravity-adapter.ts` / `.test.ts`, plus IPC/preload contract files if disconnect must become asynchronous.

- [ ] Configure OAuth with the provided public Modus Desktop client ID, remove the client-secret/environment dependency, and omit `client_secret` in authorization-code and refresh requests. Add tests for packaged/default configuration without environment variables.
- [ ] Add failing adapter tests using actual Pi `ToolResultMessage` role/fields/content, covering success and error, and map into the approved but still live-unverified Google `functionResponse` representation. Do not test only synthetic `role: "tool"` input.
- [ ] Implement only source-confirmed model-specific reasoning options (Gemini level mappings and Claude Opus 8,192/32,768 budgets); hide unsupported generic levels and test the exposed settings options and emitted wire requests. Do not invent numeric budgets.
- [ ] Serialize disconnect with Pi's async auth-file lock. Invalidate sign-ins immediately, wait for a refresh already holding the lock, remove credentials under the lock, reload storage, and prevent a new login from racing the removal. Reject refresh completions invalidated by disconnect/new credentials.
- [ ] Add deterministic tests using the real AuthStorage refresh path and deferred HTTP response: refresh holds file lock, disconnect waits, completion leaves disk/memory disconnected; also prove post-disconnect login works and stale refresh rejects.
- [ ] Re-run focused OAuth/model-service/adapter tests, typecheck, full desktop suite, build, Windows package, `git diff --check`, and final read-only review.
