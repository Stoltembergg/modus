# Pi SDK Extension Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop project, user, package, and CLI-discovered Pi extensions from being imported by Modus sessions while preserving the host-approved permission extension.

**Architecture:** `PiSdkRuntime.createSessionResources()` will explicitly construct `DefaultResourceLoader` with `noExtensions: true`, the existing internal permission `extensionFactory`, and no externally supplied paths or CLI extension entries. A real-SDK fixture test proves that project and agent-directory extension modules have no top-level effects; a runtime wiring test proves production passes the restrictive options.

**Tech Stack:** TypeScript, Vitest, `@earendil-works/pi-coding-agent` 0.80.6, Node.js filesystem/temp-directory APIs.

**Spec:** `docs/superpowers/specs/2026-10-07-plugin-loading-containment-design.md`

## Global Constraints

- Block temporarily `community`, `local` and any source without trust issued by the host.
- Keep the block on Windows, macOS and Linux until equivalent isolation and adversarial validation exist on each platform.
- Future third-party extensions use an API without Node and with explicit capabilities.
- Prioritize isolation over the in-process `<0,2 ms` SLO.
- `noExtensions` does not disable `additionalExtensionPaths`, `cliEnabledExtensions` or explicit `extensionFactories`; keep only the approved internal factory.
- **AUTHORIZATION BEFORE RESOLUTION:** no external path/module specifier is resolved before the gate.
- **AUTHORIZATION BEFORE IMPORT:** no external `import()`/`require()`/factory runs before the gate.
- **TRUST IS NOT SERIALIZABLE AUTHORITY:** SQLite/settings/manifest trust does not authorize code.
- **DENIED MEANS ZERO SIDE EFFECT:** a denied extension runs no top-level code, hook, provider constructor or migration.
- This plan closes only the Pi SDK autoload path; it does not close A01–A04 or change the audit’s NO-GO.
- Preserve the pre-existing changes in `pi-sdk-runtime.ts` and `pi-sdk-runtime.test.ts`; do not stage or commit entire files. Leave implementation edits uncommitted pending user review.

---

### Task 1: Assert restrictive production loader wiring

**Files:**
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.test.ts`
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts:2143-2156`

**Interfaces:**
- Consumes: Existing test helpers `insertSession`, `createWindowStub`, `mocks.resourceLoaderOptions`.
- Produces: `createSessionResources()` always passes `noExtensions: true` and retains exactly one host-approved permission factory.

- [ ] **Step 1: Add a failing runtime-wiring regression**

Add a test named `restrictive extension loader` that creates a session through `PiSdkRuntime.prompt()` and inspects the options captured by the existing mocked `DefaultResourceLoader`:

```ts
const options = mocks.resourceLoaderOptions.at(-1) as {
  noExtensions?: boolean;
  additionalExtensionPaths?: unknown[];
  cliEnabledExtensions?: unknown[];
  extensionFactories?: unknown[];
};
expect(options.noExtensions).toBe(true);
expect(options.additionalExtensionPaths).toBeUndefined();
expect(options.cliEnabledExtensions).toBeUndefined();
expect(options.extensionFactories).toHaveLength(1);
```

Use the existing per-test `cwd`, `userData`, `insertSession()`, and default mock session so no real model or Electron process is started.

- [ ] **Step 2: Run the test and confirm it fails for the missing gate**

Run: `npx vitest run --root . apps/desktop/src/main/agent/pi-sdk-runtime.test.ts -t "restrictive extension loader"`

Expected: FAIL because the captured `noExtensions` option is currently absent (`undefined`).

- [ ] **Step 3: Set the gate in the production loader options**

In `createSessionResources()`, add `noExtensions: true` to the `DefaultResourceLoader` options. Keep the existing `extensionFactories: [createModusPermissionExtension(...)]`; do not add `additionalExtensionPaths` or `cliEnabledExtensions`.

```ts
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  noExtensions: true,
  extensionFactories: [createModusPermissionExtension(sessionId, emit, cwd)],
  settingsManager,
  appendSystemPrompt,
});
```

- [ ] **Step 4: Re-run the focused test and typecheck**

Run: `npx vitest run --root . apps/desktop/src/main/agent/pi-sdk-runtime.test.ts -t "restrictive extension loader"`

Expected: PASS with `noExtensions === true`, no external path/CLI option, and one internal factory.

Run: `npm --workspace @modus/desktop run typecheck`

Expected: exit 0.

- [ ] **Step 5: Review the task diff without staging user changes**

Run `git status --short` and review only the new test and the `noExtensions` hunk. Do not stage or commit the two files: both already contain user changes.

### Task 2: Prove no project or agent-directory module is imported

**Files:**
- Create: `apps/desktop/src/main/agent/pi-sdk-extension-containment.test.ts`

**Interfaces:**
- Consumes: The real `DefaultResourceLoader`, `SettingsManager.inMemory()`, and `ExtensionFactory` types from Pi SDK 0.80.6.
- Produces: A fixture test proving both normal discovery roots are inert under `noExtensions: true`, while an explicitly approved factory remains available.

- [ ] **Step 1: Write the sentinel fixture test**

Create isolated temporary `cwd` and `agentDir` directories. Write one `.js`/`.ts` extension with a top-level global marker under `<cwd>/.pi/extensions/` and another under `<agentDir>/extensions/`. Construct the real loader with `noExtensions: true`, `SettingsManager.inMemory()`, and one `vi.fn()` internal factory; call `reload()`.

Import `vi` from Vitest and the real Pi SDK loader/settings types; do not reuse the mocked SDK module from `pi-sdk-runtime.test.ts`.

```ts
expect((globalThis as Record<string, unknown>)[projectMarker]).toBeUndefined();
expect((globalThis as Record<string, unknown>)[agentMarker]).toBeUndefined();
expect(approvedFactory).toHaveBeenCalledTimes(1);
```

Use unique marker names per test, clear them in `finally`, and remove both temp directories with `rm(..., { recursive: true, force: true })` so the test is safe on Windows, macOS and Linux.

- [ ] **Step 2: Run the new real-SDK test**

Run: `npx vitest run --root . apps/desktop/src/main/agent/pi-sdk-extension-containment.test.ts`

Expected: PASS against the pinned SDK. If either sentinel executes, the SDK version or fixture root assumption has changed and the gate must not be treated as proven.

- [ ] **Step 3: Re-run both Pi containment regressions and typecheck**

Run: `npx vitest run --root . apps/desktop/src/main/agent/pi-sdk-runtime.test.ts apps/desktop/src/main/agent/pi-sdk-extension-containment.test.ts`

Expected: both runtime wiring and real-loader sentinel tests pass.

Run: `npm --workspace @modus/desktop run typecheck`

Expected: exit 0.

- [ ] **Step 4: Review the new test without staging user changes**

Run `git status --short` and inspect the new sentinel test. Leave all changes uncommitted pending user review.
