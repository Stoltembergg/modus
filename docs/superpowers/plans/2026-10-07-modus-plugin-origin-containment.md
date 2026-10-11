# Modus Plugin Origin Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit only exact, host-catalogued Modus plugin manifests to enter the loader, lifecycle store, or capability registry; deny self-declared trust and persisted untrusted plugins before hooks/providers run.

**Architecture:** Add an immutable `HostPluginCatalog` containing the statically imported internal manifests and a host-owned trust level. `PluginLoader` and `PluginLifecycleService` resolve executable manifests only through that catalog; persisted JSON is metadata, never authority. `CapabilityRegistry` rejects replacement of an existing provider on a non-replaceable capability, including replacement using the same `providerId`.

**Tech Stack:** TypeScript, Vitest, Node `node:sqlite`, existing Modus plugin loader/lifecycle/capability registry.

**Spec:** `docs/superpowers/specs/2026-10-07-plugin-loading-containment-design.md`

## Global Constraints

- Block temporarily `community`, `local` and any source without trust issued by the host.
- Keep the block on Windows, macOS and Linux until equivalent isolation and adversarial validation exist on each platform.
- Future third-party extensions use an API without Node and with explicit capabilities.
- Prioritize isolation over the in-process `<0,2 ms` SLO.
- `PluginManifest.trustLevel`, SQLite rows and serialized version manifests never grant authority.
- **AUTHORIZATION BEFORE RESOLUTION:** no external path/module specifier is resolved before the gate.
- **AUTHORIZATION BEFORE IMPORT:** no external `import()`/`require()`/factory runs before the gate.
- **TRUST IS NOT SERIALIZABLE AUTHORITY:** SQLite/settings/manifest trust does not authorize code.
- **DENIED MEANS ZERO SIDE EFFECT:** a denied plugin runs no top-level code, hook, provider constructor or migration.
- Do not claim A01–A04 are closed; this is containment only and the audit remains NO-GO for hostile extensions.
- Preserve pre-existing untracked plugin/capability files and edits; do not stage or commit full target files. Leave implementation edits uncommitted pending user review.

---

### Task 1: Add the host-owned manifest catalog and loader gate

**Files:**
- Create: `apps/desktop/src/main/agent/harness/plugin/plugin-catalog.ts`
- Create: `apps/desktop/src/main/agent/harness/plugin/plugin-catalog.test.ts`
- Create: `apps/desktop/src/main/agent/harness/plugin/plugin-test-catalog.ts`
- Modify: `apps/desktop/src/main/agent/harness/plugin/plugin-loader.ts:34-190`
- Modify: `apps/desktop/src/main/agent/harness/plugin/bootstrap.ts:6-55`
- Modify: `apps/desktop/src/main/agent/harness/plugin/plugin.test.ts`

**Interfaces:**
- Consumes: `PluginManifest`, the six statically imported internal manifests, and `CapabilityRegistry`.
- Produces: `PluginManifestCatalog.authorize(manifest)` (exact object identity), `PluginManifestCatalog.resolve(id, version)`, host-owned `HostPluginEntry.trustLevel`, `PluginLoader.authorizeManifest(manifest)`, `PluginLoader.resolveHostManifest(id, version)`, and `PluginLoader(registry, catalog = BUILT_IN_PLUGIN_CATALOG)`.

- [ ] **Step 1: Add the failing self-declared-core regression**

In a test named `rejects a self-declared core clone before provider registration or hooks`, clone a built-in manifest, preserve its ID, set `trustLevel: 'core'`, replace its implementation with a spy, and attach an `onLoad` spy. Assert that `loader.load(clone)` rejects, the hook is not called, and the capability has no provider from the clone.

Import `vi` from Vitest in this test file for the hook and implementation spies.

```ts
const onLoad = vi.fn();
const execute = vi.fn();
const forged = {
  ...memoryPluginManifest,
  trustLevel: 'core' as const,
  lifecycle: { onLoad },
  provides: memoryPluginManifest.provides.map((item) => ({
    ...item,
    implementation: { execute },
  })),
};
await expect(loader.load(forged)).rejects.toThrow(PluginValidationError);
expect(onLoad).not.toHaveBeenCalled();
expect(registry.listProviders('memory.retrieve').some((p) => p.implementation.execute === execute)).toBe(false);
```

- [ ] **Step 2: Run the regression and confirm the current bypass**

Run: `npx vitest run --root . apps/desktop/src/main/agent/harness/plugin/plugin.test.ts -t "self-declared core"`

Expected: FAIL because the loader currently accepts the cloned manifest and registers its provider.

- [ ] **Step 3: Define the catalog contract and built-in entries**

In `plugin-catalog.ts`, define:

```ts
export type HostPluginTrust = 'core' | 'official';
export interface HostPluginEntry {
  readonly manifest: PluginManifest;
  readonly trustLevel: HostPluginTrust;
}
export interface PluginManifestCatalog {
  authorize(manifest: PluginManifest): HostPluginEntry | undefined;
  resolve(id: string, version: string): HostPluginEntry | undefined;
}
export class HostPluginCatalog implements PluginManifestCatalog {
  constructor(entries: readonly HostPluginEntry[]);
  authorize(manifest: PluginManifest): HostPluginEntry | undefined;
  resolve(id: string, version: string): HostPluginEntry | undefined;
}
export const BUILT_IN_PLUGIN_ENTRIES: readonly HostPluginEntry[];
export const BUILT_IN_PLUGIN_CATALOG: HostPluginCatalog;
```

Key entries by `id@version`, reject duplicate keys, and make `authorize()` return an entry only when the stored manifest is the exact same object reference. Build `BUILT_IN_PLUGIN_ENTRIES` in dependency order from the six static imports currently in `bootstrap.ts`; set trust in each entry, not from `manifest.trustLevel`.

Add `plugin-catalog.test.ts` for exact-object authorization, clone rejection, host-derived trust, and duplicate-key rejection. Add `plugin-test-catalog.ts` as test-only code implementing `PluginManifestCatalog`; its `add(manifest, trustLevel)` method is used only by test fixtures, never imported by production.

- [ ] **Step 4: Gate loading before validation, dependency checks, registration, or hooks**

Give `PluginLoader` a `PluginManifestCatalog` parameter with `BUILT_IN_PLUGIN_CATALOG` as the default. Add `authorizeManifest(manifest)` to return the authorized `HostPluginEntry` or throw `PluginValidationError`, and `resolveHostManifest(id, version)` to return only the entry’s manifest. At the beginning of `load(manifest)`, call `authorizeManifest(manifest)` before `validateManifest()`, `checkDependencies()`, provider registration, or `lifecycle.onLoad()`. Use the returned host trust level for capability creation and `CapabilityProvider.trustLevel`; do not use the manifest field as authority.

Change `bootstrap.ts` to consume `BUILT_IN_PLUGIN_ENTRIES` instead of maintaining a second trust list. Keep its dependency order and continue loading all six built-ins.

Keep production imports of plugin implementations static and host-owned. Verify module-resolution call sites with `rg -n 'import\s*\(|require\s*\(|createRequire|jiti' apps/desktop/src/main/agent/harness/plugin`. The current sole match is the fixed-literal `await import('node:fs')` in `plugin-cli.ts:525`, used to read WASM bytes for inspection; it is not an external JS plugin importer. Preserve the fixed specifier and do not add an arbitrary path/module-specifier loader in this tranche.

- [ ] **Step 5: Run loader and bootstrap tests**

Run: `npx vitest run --root . apps/desktop/src/main/agent/harness/plugin/plugin.test.ts apps/desktop/src/main/agent/harness/plugin/plugin-catalog.test.ts`

Expected: the forged clone is rejected before provider/hook effects, and all built-in plugin tests still pass.

- [ ] **Step 6: Review this task diff without staging user files**

Run `git status --short` and review the catalog/loader/bootstrap changes without staging the pre-existing untracked files.

### Task 2: Protect non-replaceable providers from same-ID replacement

**Files:**
- Modify: `apps/desktop/src/main/agent/harness/capability/capability-registry.ts:57-92`
- Modify: `apps/desktop/src/main/agent/harness/capability/capability-registry.test.ts`

**Interfaces:**
- Consumes: Existing `CapabilityProvider`, `Capability.replaceable`, and `CapabilityConflictError`.
- Produces: A registration invariant that a non-replaceable capability’s existing provider cannot be changed by reusing the same `providerId`.

- [ ] **Step 1: Add the same-ID hostile replacement regression**

In a test named `rejects replacement by the same provider ID on a non-replaceable capability`, register a local `agent.loop` capability with `replaceable: false` and a trusted provider. Then register a second provider with the same ID and a different `implementation.execute`. Assert `CapabilityConflictError`, the original implementation remains active, and the provider list remains unchanged.

```ts
const implementation = { execute: () => 'core' };
registry.registerCapability({
  id: 'agent.loop', apiVersion: '1.0', replaceable: false,
  dependencies: [], metadata: { description: 'Core loop' },
});
registry.registerProvider({
  providerId: '@modus/core-loop', providerVersion: '1.0.0',
  capabilityId: 'agent.loop', capabilityApiVersion: '1.0', trustLevel: 'core',
  permissions: {}, implementation, registeredAt: new Date(), metadata: {},
});
expect(() => registry.registerProvider({
  providerId: '@modus/core-loop', providerVersion: '1.0.0',
  capabilityId: 'agent.loop', capabilityApiVersion: '1.0', trustLevel: 'community',
  permissions: {}, implementation: { execute: () => 'hijacked' },
  registeredAt: new Date(), metadata: {},
})).toThrow(CapabilityConflictError);
expect(registry.getActiveProvider('agent.loop')?.implementation).toBe(implementation);
expect(registry.listProviders('agent.loop')).toHaveLength(1);
```

- [ ] **Step 2: Run the regression and confirm it fails**

Run: `npx vitest run --root . apps/desktop/src/main/agent/harness/capability/capability-registry.test.ts -t "same provider ID"`

Expected: FAIL because the current registry replaces the entry at the matching provider ID.

- [ ] **Step 3: Reject replacement of an existing non-replaceable provider**

In `registerProvider()`, before assigning `list[existingIndex]`, throw `CapabilityConflictError` when the capability is non-replaceable and the new provider has a different implementation object. Do not mutate `list`, `providers`, or `activeProviders` on rejection. Keep current multi-provider behavior for replaceable capabilities.

- [ ] **Step 4: Run the registry suite and review the diff**

Run: `npx vitest run --root . apps/desktop/src/main/agent/harness/capability/capability-registry.test.ts`

Expected: PASS, including existing provider-switching and non-replaceable tests.

Run `git status --short` and inspect only the same-ID guard and regression; leave it uncommitted.

### Task 3: Stop persisted manifests from granting trust or restoring code

**Files:**
- Modify: `apps/desktop/src/main/agent/harness/plugin/plugin-lifecycle-service.ts:43-75,139-165,171-213,272-329,352-410,493-523`
- Modify: `apps/desktop/src/main/agent/harness/plugin/version-manager.ts:24-63,69-106`
- Modify: `apps/desktop/src/main/agent/harness/plugin/plugin-lifecycle.test.ts`
- Modify: `apps/desktop/src/main/agent/harness/plugin/plugin-rollback.test.ts`

**Interfaces:**
- Consumes: `PluginLoader.authorizeManifest(manifest)` and `PluginLoader.resolveHostManifest(id, version)` from Task 1.
- Produces: Lifecycle install/upgrade/downgrade and startup sync that use only catalog object references; SQLite data never supplies executable authority.

- [ ] **Step 1: Add failing install and restart regressions**

Add tests named `rejects an uncatalogued core manifest before install side effects` and `does not restore a persisted plugin outside the host catalog`. Assert that an uncatalogued manifest with `trustLevel: 'core'` is rejected by `install()` before `PluginStateStore.getPlugin(id)` becomes non-null, before provider registration, and before any hook. Separately seed an `enabled` SQLite record/version for an uncatalogued manifest, call `syncOnStartup()`, and assert the plugin is not loaded, its hook is untouched, no provider exists, and the record is changed to `error` with a sync diagnostic.

- [ ] **Step 2: Run lifecycle regressions and confirm current behavior**

Run: `npx vitest run --root . apps/desktop/src/main/agent/harness/plugin/plugin-lifecycle.test.ts -t "uncatalogued|persisted plugin"`

Expected: FAIL because current service rehydrates persisted manifests and accepts self-declared trust.

- [ ] **Step 3: Use the loader catalog as the only executable manifest source**

Remove the service’s mutable `manifestCatalog` executable fallback. Make `resolveManifest(id, version)` delegate to `loader.resolveHostManifest(id, version)`. Remove constructor rehydration of version-record manifests. Keep `registerManifest()` only as a dependency-graph update: it must call `loader.authorizeManifest(manifest)` before `dependencyGraph.addPlugin(manifest)` and must not store/authorize executable objects. Before `install()` or `upgrade()` validates or changes the store, call `loader.authorizeManifest(manifest)`. In `downgrade()`, resolve the target from the host catalog and do not fall back to `versionRecord.manifest`; reject before unloading the current version or changing the store if the target is not catalogued.

In `syncOnStartup()`, if a persisted enabled record has no exact host catalog entry, do not call `load()` or `enable()`. Mark the record `error`, write a `sync_error` event, and continue booting.

- [ ] **Step 4: Remove serialized-manifest execution from rollback**

Change `PluginVersionManager.preserveVersion()` to require `service.resolveManifest(pluginId, version)` and remove its fallback to `PluginStateStore.getVersion(...).manifest`. Change `rollback()` to resolve the target again with `service.resolveManifest(pluginId, targetVersion)` and throw if absent; never pass `backup.manifest` from SQLite to `registerManifest()` or `downgrade()`.

```ts
if (!this.service.resolveManifest(pluginId, targetVersion)) {
  throw new PluginLifecycleError(`Cannot rollback untrusted or unavailable version ${pluginId}@${targetVersion}`);
}
await this.service.downgrade(pluginId, targetVersion);
```

- [ ] **Step 5: Update lifecycle fixture catalogs and run regressions**

Use the test-only `TestPluginCatalog` from Task 1 for each test-created `PluginLoader` and `PluginLifecycleService`; add exactly the fixture manifest objects and versions used in that test before invoking the loader/service. Run:

`npx vitest run --root . --no-file-parallelism --maxWorkers=1 --testTimeout=20000 apps/desktop/src/main/agent/harness/plugin/plugin-lifecycle.test.ts apps/desktop/src/main/agent/harness/plugin/plugin-rollback.test.ts`

Expected: PASS for trusted test fixtures; uncatalogued install/startup/rollback attempts have zero plugin side effects.

- [ ] **Step 6: Review this task diff without staging user files**

Run `git status --short` and review lifecycle, rollback and test changes. Do not stage or commit the pre-existing untracked plugin files.

### Task 4: Keep the remaining plugin suites on explicit test catalogs

**Files:**
- Modify: `apps/desktop/src/main/agent/harness/plugin/plugin-dependency.test.ts`
- Modify: `apps/desktop/src/main/agent/harness/plugin/plugin.test.ts`

**Interfaces:**
- Consumes: `PluginManifestCatalog` and the existing per-test manifest fixtures.
- Produces: Synthetic tests explicitly add exact fixture objects to `TestPluginCatalog`; production defaults remain the six built-ins only.

- [ ] **Step 1: Inject the test-only catalog into dependency fixtures**

In `plugin-dependency.test.ts`, add `baseMemoryPlugin`, `modelRouterPlugin`, `contextEnginePlugin`, `verifierPlugin`, and `hyperplanPlugin` to the test catalog before constructing the loader/service. Whenever a test constructs another manifest/version, call `catalog.add(exactManifestObject)` before `loader.load()`, `service.install()`, `service.upgrade()` or `service.downgrade()`. In `plugin.test.ts`, keep the default catalog for the six built-ins and use `TestPluginCatalog` for any synthetic manifest passed to `load()`. The WASM CLI tests only inspect embedded modules and must not add a third-party manifest to a catalog.

- [ ] **Step 2: Run the entire focused plugin/capability suite**

Run: `npx vitest run --root . --no-file-parallelism --maxWorkers=1 --testTimeout=20000 apps/desktop/src/main/agent/harness/plugin apps/desktop/src/main/agent/harness/capability/capability-registry.test.ts`

Expected: PASS; no test treats `trustLevel` or SQLite serialization as authority.

- [ ] **Step 3: Run typecheck and review the diff**

Run: `npm --workspace @modus/desktop run typecheck`

Expected: exit 0.

Run `git status --short`; leave all changes uncommitted pending user review.
