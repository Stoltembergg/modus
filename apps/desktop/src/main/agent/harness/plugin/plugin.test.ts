import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PiSdkRuntime } from '../../pi-sdk-runtime';
import { CapabilityRegistry, resetCapabilityRegistry } from '../capability/capability-registry';
import { HOST_CAPABILITY_REGISTRATION_AUTHORITY } from '../capability/capability-registration-authority';
import { CapabilityConflictError } from '../capability/capability-types';
import { registerCoreCapabilities } from '../capability/core-capabilities';
import { resetFeatureFlagOverrides, setFeatureFlagOverrides } from '../feature-flags';
import { bootstrapModusPlugins } from './bootstrap';
import { PluginLoader } from './plugin-loader';
import type { PluginManifest } from './plugin-types';
import {
  PluginDependencyError,
  PluginLifecycleError,
  PluginValidationError,
} from './plugin-types';
import { contextEnginePluginManifest } from './plugins/context-engine-plugin';
import { failureIntelPluginManifest } from './plugins/failure-intel-plugin';
import { groupsPluginManifest } from './plugins/groups-plugin';
import { memoryPluginManifest, memoryStore } from './plugins/memory-plugin';
import { modelRouterPluginManifest } from './plugins/model-router-plugin';
import { verifierPluginManifest } from './plugins/verifier-plugin';
import { BUILT_IN_PLUGIN_ENTRIES } from './plugin-catalog';
import { TestPluginCatalog } from './plugin-test-catalog';

describe('Fase 10 — Modus Internal Plugins', () => {
  let registry: CapabilityRegistry;
  let loader: PluginLoader;
  let catalog: TestPluginCatalog;

  beforeEach(() => {
    resetCapabilityRegistry();
    memoryStore.clear();
    registry = new CapabilityRegistry();
    catalog = new TestPluginCatalog();
    for (const entry of BUILT_IN_PLUGIN_ENTRIES) catalog.add(entry.manifest, entry.trustLevel);
    loader = new PluginLoader(registry, catalog);
    registerCoreCapabilities(registry);
    resetFeatureFlagOverrides();
  });

  describe('10.1 — Plugin Manifest & Descriptor Validation', () => {
    it('validates a correct manifest without error', () => {
      expect(() => loader.validateManifest(memoryPluginManifest)).not.toThrow();
    });

    it('rejects manifest without valid id', () => {
      const invalid = { ...memoryPluginManifest, id: '' };
      expect(() => loader.validateManifest(invalid)).toThrow(PluginValidationError);
    });

    it('rejects manifest with invalid trustLevel', () => {
      const invalid = { ...memoryPluginManifest, trustLevel: 'untrusted' as any };
      expect(() => loader.validateManifest(invalid)).toThrow(PluginValidationError);
    });

    it('rejects manifest with empty provides', () => {
      const invalid = { ...memoryPluginManifest, provides: [] };
      expect(() => loader.validateManifest(invalid)).toThrow(PluginValidationError);
    });

  it('rejects manifest with missing provision implementation', () => {
      const invalid: any = {
        ...memoryPluginManifest,
        provides: [
          {
            capability: 'memory.retrieve',
            apiVersion: '1.0',
            implementation: undefined,
          },
        ],
      };
      expect(() => loader.validateManifest(invalid)).toThrow(PluginValidationError);
    });
  });

  it('rejects a self-declared core clone before provider registration or hooks', async () => {
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
  });

  describe('10.2 — Dependency Checking & Resolution', () => {
    it('succeeds when all capability dependencies are satisfied', () => {
      // verifier requires context.resolve which is already registered in registry
      expect(() => loader.checkDependencies(verifierPluginManifest)).not.toThrow();
    });

    it('throws PluginDependencyError if a required capability is missing from the registry', () => {
      const emptyRegistry = new CapabilityRegistry();
      const emptyLoader = new PluginLoader(emptyRegistry);

      expect(() => emptyLoader.checkDependencies(verifierPluginManifest)).toThrow(
        PluginDependencyError,
      );
    });

    it('throws PluginDependencyError if a required plugin is missing or inactive', () => {
      const pluginWithReq: PluginManifest = {
        id: '@test/dependent',
        name: 'Dependent Plugin',
        version: '1.0.0',
        author: 'Test',
        description: 'Test',
        trustLevel: 'local',
        provides: [
          {
            capability: 'memory.retrieve',
            apiVersion: '1.0',
            implementation: { execute: () => [] },
          },
        ],
        requires: {
          modus: '>=0.8.0',
          plugins: ['@test/nonexistent-plugin'],
        },
        permissions: { required: {} },
      };

      expect(() => loader.checkDependencies(pluginWithReq)).toThrow(PluginDependencyError);
    });
  });

  describe('10.3 — Phase 10A Piloto 1: @modus/memory (Stateful Capability)', () => {
    it('loads @modus/memory, stores, retrieves and compacts memories', async () => {
      await loader.load(memoryPluginManifest);
      const loaded = loader.getPlugin('@modus/memory');
      expect(loaded).toBeDefined();
      expect(loaded?.status).toBe('loaded');

      // Test memory.store
      const storeRes = await registry.execute<any, any>('memory.store', {
        id: 'mem-1',
        category: 'architecture',
        content: 'Use atomic file writes for stores',
        tags: ['storage', 'safety'],
      });
      expect(storeRes.id).toBe('mem-1');

      await registry.execute<any, any>('memory.store', {
        id: 'mem-2',
        category: 'performance',
        content: 'Cache bounded summaries across turns',
        tags: ['caching'],
      });

      // Test memory.retrieve by keyword
      const results = await registry.execute<any, any>('memory.retrieve', {
        query: 'atomic',
      });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('mem-1');

      // Test memory.compact
      const compactRes = await registry.execute<any, any>('memory.compact', {
        maxRetain: 1,
      });
      expect(compactRes.prunedCount).toBe(1);
      expect(compactRes.remainingCount).toBe(1);

      // Verify execution provenance
      const provenance = registry.getProvenance('memory.store');
      expect(provenance.usageCount).toBe(2);
      expect(provenance.activeProvider.id).toBe('@modus/memory');
    });
  });

  describe('10.4 — Phase 10A Piloto 2: @modus/model-router (Stateless Capability)', () => {
    it('loads @modus/model-router and routes tasks dynamically', async () => {
      await loader.load(modelRouterPluginManifest);

      // 1. Complex task routes to sonnet
      const complexSelect = await registry.execute<any, any>('model.select', {
        task: 'Refactor entire distributed messaging layer',
        complexity: 'complex',
      });
      expect(complexSelect.selectedModel).toBe('claude-3-7-sonnet');

      // 2. Simple task routes to flash
      const simpleSelect = await registry.execute<any, any>('model.select', {
        task: 'Print hello world',
        complexity: 'simple',
      });
      expect(simpleSelect.selectedModel).toBe('gemini-3.8-flash');

      // 3. Explicit preference respected
      const customSelect = await registry.execute<any, any>('model.select', {
        task: 'General coding',
        preferredModel: 'deepseek-v3',
      });
      expect(customSelect.selectedModel).toBe('deepseek-v3');

      // 4. Model routing strategy
      const routeDecision = await registry.execute<any, any>('model.route', {
        task: 'Build plan and spec verification',
        complexity: 'complex',
      });
      expect(routeDecision.target).toBe('subagent_mesh');
      expect(routeDecision.speculativeVerification).toBe(true);
    });
  });

  describe('10.5 — Phase 10A Piloto 3: @modus/verifier (Complex Orchestration)', () => {
    it('loads @modus/verifier and assesses verification criteria', async () => {
      await loader.load(verifierPluginManifest);

      // 1. All passed -> verified
      const verifiedRes = await registry.execute<any, any>('verification.assess', {
        sessionId: 'sess-1',
        runId: 'run-1',
        required: true,
        checks: [
          { id: '1', name: 'unit-tests', status: 'passed' },
          { id: '2', name: 'typecheck', status: 'passed' },
        ],
      });
      expect(verifiedRes.status).toBe('verified');
      expect(verifiedRes.passedCount).toBe(2);

      // 2. Any failed -> failed
      const failedRes = await registry.execute<any, any>('verification.assess', {
        sessionId: 'sess-1',
        runId: 'run-1',
        required: true,
        checks: [
          { id: '1', name: 'unit-tests', status: 'passed' },
          { id: '2', name: 'typecheck', status: 'failed' },
        ],
      });
      expect(failedRes.status).toBe('failed');
      expect(failedRes.failedCount).toBe(1);

      // 3. Run checks
      const checks = await registry.execute<any, any>('verification.run', {
        checks: [{ name: 'vitest', command: 'npm test' }],
      });
      expect(checks.length).toBe(1);
      expect(checks[0].status).toBe('passed');
    });
  });

  describe('10.6 — Phase 10B: Additional Internal Plugins (@modus/context-engine, @modus/failure-intel, @modus/groups)', () => {
    it('loads and executes @modus/context-engine', async () => {
      await loader.load(contextEnginePluginManifest);

      const resolved = await registry.execute<any, any>('context.resolve', {
        query: 'authentication security flow',
      });
      expect(resolved.items.length).toBeGreaterThan(0);

      const filtered = await registry.execute<any, any>('context.filter', {
        items: resolved.items,
        maxTokens: 50, // lower than item size (150)
      });
      expect(filtered.droppedCount).toBe(1);
      expect(filtered.filtered.length).toBe(0);
    });

    it('loads and executes @modus/failure-intelligence', async () => {
      await loader.load(failureIntelPluginManifest);

      const syntaxDiag = await registry.execute<any, any>('failure.classify', {
        error: 'SyntaxError: Unexpected token in JSON at position 42',
      });
      expect(syntaxDiag.category).toBe('syntax');
      expect(syntaxDiag.recoverable).toBe(true);

      const recovery = await registry.execute<any, any>('failure.recover', {
        error: 'SyntaxError',
        attempts: 1,
      });
      expect(recovery.shouldContinue).toBe(true);
    });

    it('loads and executes @modus/groups', async () => {
      await loader.load(groupsPluginManifest);

      const posted = await registry.execute<any, any>('groups.mailbox', {
        action: 'post',
        sender: 'architect',
        recipient: 'coder',
        body: 'Implement auth module',
      });
      expect(posted.id).toBeDefined();

      const messages = await registry.execute<any, any>('groups.mailbox', {
        action: 'read',
        recipient: 'coder',
      });
      expect(messages.length).toBe(1);
      expect(messages[0].body).toBe('Implement auth module');
    });
  });

  describe('10.7 — Plugin Lifecycle Management (Enable/Disable/Unload)', () => {
    it('toggles plugin lifecycle states cleanly', async () => {
      let loadCount = 0;
      let enableCount = 0;
      let disableCount = 0;
      let unloadCount = 0;

      const lifecyclePlugin: PluginManifest = {
        id: '@test/lifecycle',
        name: 'Lifecycle Tester',
        version: '1.0.0',
        author: 'Test',
        description: 'Test',
        trustLevel: 'local',
        provides: [
          {
            capability: 'memory.retrieve',
            apiVersion: '1.0',
            implementation: { execute: () => ['lifecycle-res'] },
          },
        ],
        requires: { modus: '>=0.8.0' },
        permissions: { required: {} },
        lifecycle: {
          onLoad: () => {
            loadCount++;
          },
          onEnable: () => {
            enableCount++;
          },
          onDisable: () => {
            disableCount++;
          },
          onUnload: () => {
            unloadCount++;
          },
        },
      };

      catalog.add(lifecyclePlugin);
      await loader.load(lifecyclePlugin);
      expect(loadCount).toBe(1);

      await loader.enable('@test/lifecycle');
      expect(enableCount).toBe(1);
      expect(loader.getPlugin('@test/lifecycle')?.status).toBe('enabled');

      await loader.disable('@test/lifecycle');
      expect(disableCount).toBe(1);
      expect(loader.getPlugin('@test/lifecycle')?.status).toBe('disabled');

      await loader.unload('@test/lifecycle');
      expect(unloadCount).toBe(1);
      expect(loader.getPlugin('@test/lifecycle')).toBeUndefined();
    });
  });

  describe('10.8 — Full Topological Bootstrap Sequence', () => {
    it('bootstraps all 6 Modus internal plugins in strict dependency order', async () => {
      const freshRegistry = new CapabilityRegistry();
      const result = await bootstrapModusPlugins(freshRegistry);

      expect(result.loadedPlugins).toEqual([
        '@modus/memory',
        '@modus/model-router',
        '@modus/context-engine',
        '@modus/verifier',
        '@modus/failure-intelligence',
        '@modus/groups',
      ]);

      expect(result.loader.listPlugins().length).toBe(6);

      // Verify all active providers point to our loaded internal plugins
      expect(freshRegistry.getActiveProvider('memory.retrieve')?.providerId).toBe('@modus/memory');
      expect(freshRegistry.getActiveProvider('model.select')?.providerId).toBe('@modus/model-router');
      expect(freshRegistry.getActiveProvider('context.resolve')?.providerId).toBe('@modus/context-engine');
      expect(freshRegistry.getActiveProvider('verification.assess')?.providerId).toBe('@modus/verifier');
      expect(freshRegistry.getActiveProvider('failure.classify')?.providerId).toBe('@modus/failure-intelligence');
      expect(freshRegistry.getActiveProvider('groups.mailbox')?.providerId).toBe('@modus/groups');
    });
  });

  describe('10.9 — PiSdkRuntime Integration & Feature Flags', () => {    it('exposes PluginLoader and executes bootstrap with MODUS_PLUGINS enabled', async () => {
      setFeatureFlagOverrides({
        MODUS_CAPABILITY_REGISTRY: true,
        MODUS_PLUGINS: true,
      });

      const runtime = new PiSdkRuntime();
      await runtime.waitForPlugins();

      const pLoader = runtime.getPluginLoader();
      expect(pLoader).toBeDefined();

      // Bootstrap was triggered in constructor
      const plugins = pLoader.listPlugins();
      expect(plugins.length).toBe(6);

      const capReg = runtime.getCapabilityRegistry();
      const selectResult = await capReg.execute<any, any>('model.select', {
        task: 'quick query',
        complexity: 'simple',
      });
      expect(selectResult.selectedModel).toBe('gemini-3.8-flash');
    });
  });

  describe('10.10 — Fase 10 review regressions: truthful lifecycle & version checks', () => {
    const echoPlugin: PluginManifest = {
      id: '@test/echo',
      name: 'Echo',
      version: '1.0.0',
      author: 'Test',
      description: 'Test',
      trustLevel: 'local',
      provides: [
        {
          capability: 'memory.retrieve',
          apiVersion: '1.0',
          implementation: { execute: async () => ['echo-result'] },
        },
      ],
      requires: { modus: '>=0.8.0' },
      permissions: { required: {} },
    };

    it('unload removes providers and falls back to remaining ones', async () => {
      catalog.add(echoPlugin);
      await loader.load(echoPlugin);
      await loader.enable('@test/echo');
      expect(registry.getActiveProvider('memory.retrieve')?.providerId).toBe('@test/echo');

      await loader.unload('@test/echo');

      expect(registry.listProviders('memory.retrieve').length).toBe(1);
      expect(registry.getActiveProvider('memory.retrieve')?.providerId).toBe('@modus/memory');
      // Core stub serves again instead of the unloaded plugin.
      const out = await registry.execute<any, any>('memory.retrieve', { query: 'x' });
      expect(out.status).toBe('ok');
    });

    it('disable steps the provider down and enable reactivates it', async () => {
      catalog.add(echoPlugin);
      await loader.load(echoPlugin);
      await loader.enable('@test/echo');
      expect(registry.getActiveProvider('memory.retrieve')?.providerId).toBe('@test/echo');

      await loader.disable('@test/echo');
      expect(loader.getPlugin('@test/echo')?.status).toBe('disabled');
      expect(registry.getActiveProvider('memory.retrieve')?.providerId).toBe('@modus/memory');

      await loader.enable('@test/echo');
      expect(registry.getActiveProvider('memory.retrieve')?.providerId).toBe('@test/echo');
    });

    it('rolls back all registrations when onLoad fails without clearing quarantine', async () => {
      const failing: PluginManifest = {
        ...echoPlugin,
        id: '@test/load-failure',
        provides: [{ capability: 'test.transaction.created', apiVersion: '1.0', implementation: { execute: () => 'partial' } }],
        lifecycle: { onLoad: () => { throw new Error('load failed'); } },
      };
      catalog.add(failing, 'official');
      registry.quarantineProvider(failing.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      await expect(loader.load(failing)).rejects.toThrow('onLoad lifecycle hook failed');

      expect(registry.getCapability('test.transaction.created')).toBeUndefined();
      expect(registry.listProviders('test.transaction.created')).toEqual([]);
      expect(registry.isProviderQuarantined(failing.id)).toBe(true);
    });

    it('restores a pre-existing same-ID provider when its replacement load fails', async () => {
      registry.registerProvider({
        providerId: '@test/preexisting', providerVersion: '0.9.0', capabilityId: 'memory.retrieve',
        capabilityApiVersion: '1.0', trustLevel: 'official', permissions: {},
        implementation: { execute: () => ['original'] }, registeredAt: new Date(), metadata: {},
      }, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      registry.activateProvider('memory.retrieve', '@test/preexisting');
      const failing: PluginManifest = {
        ...echoPlugin,
        id: '@test/preexisting',
        lifecycle: { onLoad: () => { throw new Error('load failed'); } },
      };
      catalog.add(failing, 'official');

      await expect(loader.load(failing)).rejects.toThrow('onLoad lifecycle hook failed');

      expect(await registry.execute('memory.retrieve', {})).toEqual(['original']);
    });

    it('rejects a concurrent load for the same plugin ID and releases the reservation after failure', async () => {
      const pluginId = '@test/concurrent-load';
      let enterHook!: () => void;
      let rejectHook!: (error: Error) => void;
      const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
      const hookGate = new Promise<void>((_resolve, reject) => { rejectHook = reject; });
      let hookCalls = 0;
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [{ capability: 'test.transaction.concurrent', apiVersion: '1.0', implementation: { execute: () => 'loaded' } }],
        lifecycle: { onLoad: () => {
          hookCalls += 1;
          if (hookCalls === 1) {
            enterHook();
            return hookGate;
          }
          return undefined;
        } },
      };
      catalog.add(manifest, 'official');

      const firstLoad = loader.load(manifest);
      await hookEntered;
      await expect(loader.load(manifest)).rejects.toThrow('already loading');
      rejectHook(new Error('first load failed'));
      await expect(firstLoad).rejects.toThrow('onLoad lifecycle hook failed');

      await expect(loader.load(manifest)).resolves.toMatchObject({ status: 'loaded' });
      expect(await registry.execute('test.transaction.concurrent', {})).toBe('loaded');
    });

    it('shares the in-flight plugin ID reservation across loaders for one registry', async () => {
      const pluginId = '@test/cross-loader-concurrent-load';
      const capability = 'test.transaction.cross-loader';
      let enterHook!: () => void;
      let rejectHook!: (error: Error) => void;
      const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
      const hookGate = new Promise<void>((_resolve, reject) => { rejectHook = reject; });
      let hookCalls = 0;
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [{ capability, apiVersion: '1.0', implementation: { execute: () => 'loaded' } }],
        lifecycle: { onLoad: () => {
          hookCalls += 1;
          if (hookCalls === 1) {
            enterHook();
            return hookGate;
          }
          return undefined;
        } },
      };
      catalog.add(manifest, 'official');
      const secondLoader = new PluginLoader(registry, catalog);

      const firstLoad = loader.load(manifest);
      await hookEntered;
      await expect(secondLoader.load(manifest)).rejects.toThrow('already loading');
      rejectHook(new Error('first load failed'));
      await expect(firstLoad).rejects.toThrow('onLoad lifecycle hook failed');

      await expect(secondLoader.load(manifest)).resolves.toMatchObject({ status: 'loaded' });
      expect(await registry.execute(capability, {})).toBe('loaded');
    });

    it('shares loaded plugin ownership across loaders for one registry', async () => {
      const pluginId = '@test/cross-loader-loaded-owner';
      const capability = 'test.transaction.cross-loader-loaded';
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [{ capability, apiVersion: '1.0', implementation: { execute: () => 'original' } }],
      };
      catalog.add(manifest, 'official');
      const secondLoader = new PluginLoader(registry, catalog);

      const loaded = await loader.load(manifest);

      await expect(secondLoader.load(manifest)).rejects.toThrow('already loaded');
      expect(secondLoader.getPlugin(pluginId)).toBe(loaded);
      expect(secondLoader.listPlugins()).toContain(loaded);
      expect(await registry.execute(capability, {})).toBe('original');
    });

    it('refuses to clear shared ownership while a loaded provider is live', async () => {
      const pluginId = '@test/clear-live-plugin';
      const capability = 'test.transaction.clear-live';
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [{ capability, apiVersion: '1.0', implementation: { execute: () => 'still serving' } }],
      };
      catalog.add(manifest, 'official');
      const secondLoader = new PluginLoader(registry, catalog);
      const loaded = await loader.load(manifest);

      expect(() => secondLoader.clear()).toThrow(PluginLifecycleError);

      expect(loader.getPlugin(pluginId)).toBe(loaded);
      expect(secondLoader.getPlugin(pluginId)).toBe(loaded);
      expect(await registry.execute(capability, {})).toBe('still serving');
    });

    it('serializes cross-loader unloads and blocks reload until unload hooks finish', async () => {
      const pluginId = '@test/cross-loader-unload';
      const capability = 'test.transaction.cross-loader-unload';
      let enterHook!: () => void;
      let releaseHook!: () => void;
      const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
      const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
      let unloadCalls = 0;
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [{ capability, apiVersion: '1.0', implementation: { execute: () => 'loaded' } }],
        lifecycle: { onUnload: () => {
          unloadCalls += 1;
          if (unloadCalls === 1) {
            enterHook();
            return hookGate;
          }
          return undefined;
        } },
      };
      catalog.add(manifest, 'official');
      const secondLoader = new PluginLoader(registry, catalog);
      await loader.load(manifest);

      const firstUnload = loader.unload(pluginId);
      await hookEntered;
      await expect(secondLoader.unload(pluginId)).rejects.toThrow('already unloading');
      await expect(secondLoader.load(manifest)).rejects.toThrow('already loaded');

      releaseHook();
      await firstUnload;
      await expect(secondLoader.load(manifest)).resolves.toMatchObject({ status: 'loaded' });
    });

    it('blocks unload and clear across loaders while onEnable is pending', async () => {
      const pluginId = '@test/pending-enable';
      const capability = 'test.transaction.pending-enable';
      let enterHook!: () => void;
      let releaseHook!: () => void;
      const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
      const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [{ capability, apiVersion: '1.0', implementation: { execute: () => 'still owned' } }],
        lifecycle: { onEnable: () => { enterHook(); return hookGate; } },
      };
      catalog.add(manifest, 'official');
      const secondLoader = new PluginLoader(registry, catalog);
      const loaded = await loader.load(manifest);

      const enable = loader.enable(pluginId);
      await hookEntered;
      await expect(secondLoader.unload(pluginId)).rejects.toThrow('already enabling');
      expect(() => secondLoader.clear()).toThrow(PluginLifecycleError);
      expect(secondLoader.getPlugin(pluginId)).toBe(loaded);
      expect(await registry.execute(capability, {})).toBe('still owned');

      releaseHook();
      await enable;
      expect(secondLoader.getPlugin(pluginId)?.status).toBe('enabled');
      expect(await registry.execute(capability, {})).toBe('still owned');
    });

    it('rolls back by the authorized ID when the manifest ID changes during onLoad', async () => {
      const authorizedId = '@test/mutated-manifest-id';
      const capability = 'test.transaction.mutable-id';
      let enterHook!: () => void;
      let releaseHook!: () => void;
      const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
      const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
      let hookCalls = 0;
      const manifest: PluginManifest = {
        ...echoPlugin,
        id: authorizedId,
        provides: [{ capability, apiVersion: '1.0', implementation: { execute: () => 'loaded' } }],
        lifecycle: { onLoad: () => {
          hookCalls += 1;
          if (hookCalls === 1) {
            enterHook();
            return hookGate;
          }
          return undefined;
        } },
      };
      catalog.add(manifest, 'official');

      const firstLoad = loader.load(manifest);
      await hookEntered;
      manifest.id = '@test/mutated-manifest-id-during-hook';
      releaseHook();

      await expect(firstLoad).rejects.toThrow('manifest identity changed during load');
      expect(registry.getCapability(capability)).toBeUndefined();
      expect(registry.listProviders(capability)).toEqual([]);

      manifest.id = authorizedId;
      await expect(loader.load(manifest)).resolves.toMatchObject({ status: 'loaded' });
      expect(await registry.execute(capability, {})).toBe('loaded');
    });

    it('restores the captured executor when a pre-existing implementation is mutated during onLoad', async () => {
      const capability = 'test.transaction.executor-snapshot';
      const pluginId = '@test/mutated-executor';
      const originalImplementation = { execute: () => 'original' };
      registry.registerCapability({ id: capability, apiVersion: '1.0', replaceable: true, dependencies: [], metadata: {} });
      registry.registerProvider({
        providerId: pluginId, providerVersion: '1', capabilityId: capability,
        capabilityApiVersion: '1.0', trustLevel: 'official', permissions: {},
        implementation: originalImplementation, registeredAt: new Date(), metadata: {},
      }, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      registry.activateProvider(capability, pluginId);

      let enterHook!: () => void;
      let rejectHook!: (error: Error) => void;
      const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
      const hookGate = new Promise<void>((_resolve, reject) => { rejectHook = reject; });
      const failing: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [{ capability, apiVersion: '1.0', implementation: { execute: () => 'replacement' } }],
        lifecycle: { onLoad: () => { enterHook(); return hookGate; } },
      };
      catalog.add(failing, 'official');

      const load = loader.load(failing);
      await hookEntered;
      originalImplementation.execute = () => 'mutated';
      rejectHook(new Error('load failed'));
      await expect(load).rejects.toThrow('onLoad lifecycle hook failed');

      expect(await registry.execute(capability, {})).toBe('original');
    });

    it('rolls back earlier providers when a later non-replaceable registration fails', async () => {
      const lockedCapability = 'test.transaction.locked';
      registry.registerCapability({ id: lockedCapability, apiVersion: '1.0', replaceable: false, dependencies: [], metadata: {} });
      registry.registerProvider({
        providerId: '@test/locked-owner', providerVersion: '1', capabilityId: lockedCapability,
        capabilityApiVersion: '1.0', trustLevel: 'core', permissions: {},
        implementation: { execute: () => 'owner' }, registeredAt: new Date(), metadata: {},
      }, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      const failing: PluginManifest = {
        ...echoPlugin,
        id: '@test/registration-failure',
        provides: [
          { capability: 'test.transaction.created', apiVersion: '1.0', implementation: { execute: () => 'partial' } },
          { capability: lockedCapability, apiVersion: '1.0', implementation: { execute: () => 'blocked' } },
        ],
      };
      catalog.add(failing, 'official');
      registry.quarantineProvider(failing.id, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      await expect(loader.load(failing)).rejects.toThrow(CapabilityConflictError);

      expect(registry.getCapability('test.transaction.created')).toBeUndefined();
      expect(registry.listProviders('test.transaction.created')).toEqual([]);
      expect(registry.getActiveProvider(lockedCapability)?.providerId).toBe('@test/locked-owner');
      expect(registry.isProviderQuarantined(failing.id)).toBe(true);
    });

    it('preserves the registration error and fully rolls back a mixed same-ID transaction', async () => {
      const replaceableCapability = 'test.transaction.replaceable';
      const lockedCapability = 'test.transaction.same-id-locked';
      const pluginId = '@test/mixed-registration-failure';
      registry.registerCapability({ id: replaceableCapability, apiVersion: '1.0', replaceable: true, dependencies: [], metadata: {} });
      registry.registerCapability({ id: lockedCapability, apiVersion: '1.0', replaceable: false, dependencies: [], metadata: {} });
      registry.registerProvider({
        providerId: pluginId, providerVersion: '1', capabilityId: replaceableCapability,
        capabilityApiVersion: '1.0', trustLevel: 'official', permissions: {},
        implementation: { execute: () => 'original' }, registeredAt: new Date(), metadata: {},
      }, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      registry.registerProvider({
        providerId: pluginId, providerVersion: '1', capabilityId: lockedCapability,
        capabilityApiVersion: '1.0', trustLevel: 'official', permissions: {},
        implementation: { execute: () => 'locked owner' }, registeredAt: new Date(), metadata: {},
      }, HOST_CAPABILITY_REGISTRATION_AUTHORITY);
      registry.activateProvider(replaceableCapability, pluginId);
      registry.quarantineProvider('@test/keep-quarantine', HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      const failing: PluginManifest = {
        ...echoPlugin,
        id: pluginId,
        provides: [
          { capability: 'test.transaction.created', apiVersion: '1.0', implementation: { execute: () => 'partial' } },
          { capability: replaceableCapability, apiVersion: '1.0', implementation: { execute: () => 'replacement' } },
          { capability: lockedCapability, apiVersion: '1.0', implementation: { execute: () => 'different implementation' } },
        ],
      };
      catalog.add(failing, 'official');

      let thrown: unknown;
      try {
        await loader.load(failing);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CapabilityConflictError);
      expect((thrown as Error).message).toContain('marked non-replaceable');
      expect(registry.getCapability('test.transaction.created')).toBeUndefined();
      expect(registry.listProviders('test.transaction.created')).toEqual([]);
      expect(await registry.execute(replaceableCapability, {})).toBe('original');
      expect(registry.getProviderRegistration(lockedCapability, pluginId, HOST_CAPABILITY_REGISTRATION_AUTHORITY)?.implementation.execute({})).toBe('locked owner');
      expect(registry.isProviderQuarantined('@test/keep-quarantine')).toBe(true);
      expect(registry.isProviderQuarantined(pluginId)).toBe(false);
    });

    it('rejects capability requirements with incompatible major versions', () => {
      const mismatch: PluginManifest = {
        ...echoPlugin,
        id: '@test/mismatch',
        requires: {
          modus: '>=0.8.0',
          capabilities: [{ capability: 'memory.retrieve', version: '^2.0' }],
        },
      };
      expect(() => loader.checkDependencies(mismatch)).toThrow(PluginDependencyError);

      const match: PluginManifest = {
        ...echoPlugin,
        id: '@test/match',
        requires: {
          modus: '>=0.8.0',
          capabilities: [{ capability: 'memory.retrieve', version: '^1.0' }],
        },
      };
      expect(() => loader.checkDependencies(match)).not.toThrow();
    });

    it('refuses to remove the last provider of a non-replaceable capability', () => {
      const solo = new CapabilityRegistry();
      solo.registerCapability({
        id: 'agent.loop',
        apiVersion: '1.0',
        replaceable: false,
        dependencies: [],
        metadata: {},
      });
      solo.registerProvider({
        providerId: '@modus/core-loop',
        providerVersion: '1.0.0',
        capabilityId: 'agent.loop',
        capabilityApiVersion: '1.0',
        trustLevel: 'core',
        permissions: {},
        implementation: { execute: () => 'loop' },
        registeredAt: new Date(),
        metadata: {},
      }, HOST_CAPABILITY_REGISTRATION_AUTHORITY);

      expect(() => solo.unregisterProvider('agent.loop', '@modus/core-loop')).toThrow(
        CapabilityConflictError,
      );
      expect(solo.getActiveProvider('agent.loop')?.providerId).toBe('@modus/core-loop');
    });
  });
});
