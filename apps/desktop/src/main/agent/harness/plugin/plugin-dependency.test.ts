import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PiSdkRuntime } from '../../pi-sdk-runtime';
import { CapabilityRegistry } from '../capability/capability-registry';
import {
  resetFeatureFlagOverrides,
  setFeatureFlagOverrides,
  validateFeatureFlags,
} from '../feature-flags';
import { DependencyGraph } from './dependency-graph';
import { executePluginCli } from './plugin-cli';
import {
  CircularDependencyError,
  type PluginUpdate,
} from './plugin-dependency-types';
import { PluginLifecycleService } from './plugin-lifecycle-service';
import { PluginLoader } from './plugin-loader';
import { PluginStateStore } from './plugin-state-store';
import { PluginLifecycleError, type PluginManifest } from './plugin-types';
import { UpdatePlanner } from './update-planner';
import { TestPluginCatalog } from './plugin-test-catalog';

describe('Fase 14 — Dependency Intelligence', () => {
  let db: DatabaseSync;
  let store: PluginStateStore;
  let registry: CapabilityRegistry;
  let loader: PluginLoader;
  let service: PluginLifecycleService;
  let catalog: TestPluginCatalog;

  const mockImpl = { execute: () => ({ success: true }) };
  const mockPerms = { required: {} };

  const baseMemoryPlugin: PluginManifest = {
    id: '@modus/memory',
    name: 'Memory Plugin',
    version: '1.0.0',
    author: 'Modus Team',
    description: 'Provides memory capabilities',
    trustLevel: 'core',
    provides: [{ capability: 'memory.query', apiVersion: '1.0', implementation: mockImpl }],
    requires: { modus: '>=0.8.0' },
    permissions: mockPerms,
  };

  const modelRouterPlugin: PluginManifest = {
    id: '@modus/model-router',
    name: 'Model Router',
    version: '1.0.0',
    author: 'Modus Team',
    description: 'Routes models',
    trustLevel: 'core',
    provides: [{ capability: 'model.route', apiVersion: '1.0', implementation: mockImpl }],
    requires: { modus: '>=0.8.0' },
    permissions: mockPerms,
  };

  const contextEnginePlugin: PluginManifest = {
    id: '@modus/context-engine',
    name: 'Context Engine',
    version: '1.0.0',
    author: 'Modus Team',
    description: 'Builds context',
    trustLevel: 'core',
    provides: [{ capability: 'context.build', apiVersion: '1.0', implementation: mockImpl }],
    requires: {
      modus: '>=0.8.0',
      capabilities: [{ capability: 'memory.query', version: '^1.0' }],
      plugins: ['@modus/model-router'],
    },
    permissions: mockPerms,
  };

  const verifierPlugin: PluginManifest = {
    id: '@modus/verifier',
    name: 'Verifier Plugin',
    version: '1.0.0',
    author: 'Modus Team',
    description: 'Verifies steps',
    trustLevel: 'core',
    provides: [{ capability: 'verification.check', apiVersion: '1.0', implementation: mockImpl }],
    requires: {
      modus: '>=0.8.0',
      capabilities: [{ capability: 'context.build', version: '^1.0' }],
    },
    permissions: mockPerms,
  };

  const hyperplanPlugin: PluginManifest = {
    id: '@modus/hyperplan',
    name: 'Hyperplan Plugin',
    version: '1.0.0',
    author: 'Modus Team',
    description: 'Creates execution plans',
    trustLevel: 'core',
    provides: [{ capability: 'plan.generate', apiVersion: '1.0', implementation: mockImpl }],
    requires: {
      modus: '>=0.8.0',
      capabilities: [{ capability: 'context.build', version: '^1.0' }],
    },
    permissions: mockPerms,
  };

  beforeEach(() => {
    resetFeatureFlagOverrides();
    db = new DatabaseSync(':memory:');
    store = new PluginStateStore(db);
    registry = new CapabilityRegistry();
    catalog = new TestPluginCatalog();
    for (const manifest of [baseMemoryPlugin, modelRouterPlugin, contextEnginePlugin, verifierPlugin, hyperplanPlugin]) {
      catalog.add(manifest);
    }
    loader = new PluginLoader(registry, catalog);
    service = new PluginLifecycleService(store, loader, registry);
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    try {
      store.close();
    } catch {
      // Ignored if already closed
    }
  });

  describe('14.1 — Dependency Graph Construction & Links', () => {
    it('correctly maps capability provisions and requirements to plugin dependencies', () => {
      const graph = new DependencyGraph();
      graph.addPlugin(baseMemoryPlugin);
      graph.addPlugin(modelRouterPlugin);
      graph.addPlugin(contextEnginePlugin);

      const memNode = graph.getPlugin('@modus/memory');
      const routerNode = graph.getPlugin('@modus/model-router');
      const ctxNode = graph.getPlugin('@modus/context-engine');

      expect(memNode).toBeDefined();
      expect(routerNode).toBeDefined();
      expect(ctxNode).toBeDefined();

      // context-engine depends on memory (via capability memory.query) and model-router (via plugin requirement)
      expect(ctxNode?.dependencies).toContain('@modus/memory');
      expect(ctxNode?.dependencies).toContain('@modus/model-router');

      // memory and model-router have context-engine as dependent
      expect(memNode?.dependents).toContain('@modus/context-engine');
      expect(routerNode?.dependents).toContain('@modus/context-engine');
    });

    it('updates links when plugins are removed or rebuilt', () => {
      const graph = new DependencyGraph();
      graph.rebuild([baseMemoryPlugin, modelRouterPlugin, contextEnginePlugin]);

      expect(graph.getPlugin('@modus/memory')?.dependents).toContain('@modus/context-engine');

      graph.removePlugin('@modus/context-engine');
      expect(graph.getPlugin('@modus/memory')?.dependents).toHaveLength(0);
      expect(graph.getPlugin('@modus/context-engine')).toBeUndefined();
    });
  });

  describe('14.2 — Blast Radius Calculation', () => {
    it('computes direct and transitive blast radius accurately', () => {
      const graph = new DependencyGraph();
      graph.rebuild([
        baseMemoryPlugin,
        modelRouterPlugin,
        contextEnginePlugin,
        verifierPlugin,
        hyperplanPlugin,
      ]);

      const blast = graph.calculateBlastRadius('@modus/memory');

      expect(blast.targetPluginId).toBe('@modus/memory');
      // Direct dependent: @modus/context-engine
      expect(blast.directDependents).toEqual(['@modus/context-engine']);

      // Transitive dependents: @modus/verifier and @modus/hyperplan (both depend on context-engine)
      const transitiveIds = blast.transitiveDependents.map((t) => t.pluginId);
      expect(transitiveIds).toContain('@modus/verifier');
      expect(transitiveIds).toContain('@modus/hyperplan');

      expect(blast.totalAffected).toBe(3);
      expect(blast.severity).toBe('medium');
      expect(blast.critical).toBe(true);
    });

    it('returns none severity for standalone leaf plugin with no dependents', () => {
      const graph = new DependencyGraph();
      graph.rebuild([baseMemoryPlugin, modelRouterPlugin, contextEnginePlugin, verifierPlugin]);

      const blast = graph.calculateBlastRadius('@modus/verifier');
      expect(blast.totalAffected).toBe(0);
      expect(blast.severity).toBe('none');
      expect(blast.critical).toBe(false);
      expect(blast.directDependents).toHaveLength(0);
      expect(blast.transitiveDependents).toHaveLength(0);
    });
  });

  describe('14.3 — Circular Dependency Detection & Topological Sort', () => {
    it('detects direct circular dependency and identifies the cycle', () => {
      const graph = new DependencyGraph();

      const pluginA: PluginManifest = {
        id: 'plugin-a',
        name: 'A',
        version: '1.0.0',
        author: 'T',
        description: 'A',
        trustLevel: 'community',
        provides: [{ capability: 'cap.a', apiVersion: '1.0', implementation: mockImpl }],
        requires: { modus: '>=0.8.0', plugins: ['plugin-b'] },
        permissions: mockPerms,
      };

      const pluginB: PluginManifest = {
        id: 'plugin-b',
        name: 'B',
        version: '1.0.0',
        author: 'T',
        description: 'B',
        trustLevel: 'community',
        provides: [{ capability: 'cap.b', apiVersion: '1.0', implementation: mockImpl }],
        requires: { modus: '>=0.8.0', plugins: ['plugin-a'] },
        permissions: mockPerms,
      };

      graph.rebuild([pluginA, pluginB]);
      expect(graph.hasCycles()).toBe(true);

      const cycles = graph.findCycles();
      expect(cycles.length).toBeGreaterThan(0);
      expect(cycles[0]).toContain('plugin-a');
      expect(cycles[0]).toContain('plugin-b');

      expect(() => graph.topologicalSort()).toThrow(CircularDependencyError);
    });

    it('produces valid topological sort order when graph is acyclic', () => {
      const graph = new DependencyGraph();
      graph.rebuild([
        baseMemoryPlugin,
        modelRouterPlugin,
        contextEnginePlugin,
        verifierPlugin,
      ]);

      expect(graph.hasCycles()).toBe(false);
      const sorted = graph.topologicalSort();

      // Dependencies must appear before dependents
      const memIndex = sorted.indexOf('@modus/memory');
      const ctxIndex = sorted.indexOf('@modus/context-engine');
      const verIndex = sorted.indexOf('@modus/verifier');

      expect(memIndex).toBeLessThan(ctxIndex);
      expect(ctxIndex).toBeLessThan(verIndex);
    });
  });

  describe('14.4 — Topological Update Planner & Phase Parallelization', () => {
    it('plans updates in topological dependency phases with parallel grouping', () => {
      const graph = new DependencyGraph();
      graph.rebuild([
        baseMemoryPlugin,
        modelRouterPlugin,
        contextEnginePlugin,
        verifierPlugin,
      ]);

      const planner = new UpdatePlanner();
      const updates: PluginUpdate[] = [
        { pluginId: '@modus/verifier', currentVersion: '1.0.0', targetVersion: '1.1.0' },
        { pluginId: '@modus/memory', currentVersion: '1.0.0', targetVersion: '1.1.0' },
        { pluginId: '@modus/model-router', currentVersion: '1.0.0', targetVersion: '1.2.0' },
        { pluginId: '@modus/context-engine', currentVersion: '1.0.0', targetVersion: '1.3.0' },
      ];

      const plan = planner.planUpdates(updates, graph);

      expect(plan.totalUpdates).toBe(4);
      expect(plan.phases.length).toBeGreaterThanOrEqual(2);

      // Phase 1 must contain memory and model-router (independent roots) in parallel
      const phase1Ids = plan.phases[0]!.map((u) => u.pluginId);
      expect(phase1Ids).toContain('@modus/memory');
      expect(phase1Ids).toContain('@modus/model-router');

      // Subsequent phases must contain context-engine then verifier
      const laterPhases = plan.phases.slice(1).flatMap((p) => p.map((u) => u.pluginId));
      expect(laterPhases.indexOf('@modus/context-engine')).toBeLessThan(
        laterPhases.indexOf('@modus/verifier'),
      );
    });
  });

  describe('14.5 — Accidental Uninstall Prevention & CLI Commands', () => {
    it('blocks uninstall of a plugin that has active dependents unless forced', async () => {
      await service.install(baseMemoryPlugin);
      await service.install(contextEnginePlugin);

      // Attempting to uninstall memory without force must throw
      await expect(service.uninstall('@modus/memory')).rejects.toThrow(PluginLifecycleError);
      await expect(service.uninstall('@modus/memory')).rejects.toThrow(
        /is required by @modus\/context-engine/,
      );

      // Still installed
      expect(store.getPlugin('@modus/memory')).not.toBeNull();

      // Forcing uninstall succeeds
      await service.uninstall('@modus/memory', { force: true });
      expect(store.getPlugin('@modus/memory')).toBeNull();
    });

    it('executes blast-radius CLI command and outputs structured report', async () => {
      await service.install(baseMemoryPlugin);
      await service.install(modelRouterPlugin);
      await service.install(contextEnginePlugin);

      const cliResult = await executePluginCli(['blast-radius', '@modus/memory'], service);

      expect(cliResult.success).toBe(true);
      expect(cliResult.command).toBe('blast-radius');
      expect(cliResult.output).toContain('Removing @modus/memory would affect:');
      expect(cliResult.output).toContain('Direct dependents:');
      expect(cliResult.output).toContain('@modus/context-engine');
      expect(cliResult.output).toContain('Severity: LOW');
    });

    it('executes blast-radius CLI with --json option', async () => {
      await service.install(baseMemoryPlugin);
      await service.install(contextEnginePlugin);

      const cliResult = await executePluginCli(
        ['blast-radius', '@modus/memory', '--json'],
        service,
      );

      expect(cliResult.success).toBe(true);
      const parsed = JSON.parse(cliResult.output);
      expect(parsed.targetPluginId).toBe('@modus/memory');
      expect(parsed.directDependents).toContain('@modus/context-engine');
    });

    it('executes tree CLI command displaying ASCII dependency structure', async () => {
      await service.install(baseMemoryPlugin);
      await service.install(contextEnginePlugin);

      const cliResult = await executePluginCli(['tree'], service);
      expect(cliResult.success).toBe(true);
      expect(cliResult.output).toContain('@modus/memory@1.0.0');
      expect(cliResult.output).toContain('provides: memory.query');
      expect(cliResult.output).toContain('required by:');
      expect(cliResult.output).toContain('@modus/context-engine');
    });

    it('executes plan-updates CLI command', async () => {
      await service.install(baseMemoryPlugin);
      await service.install(contextEnginePlugin);

      const cliResult = await executePluginCli(
        ['plan-updates', '@modus/memory@1.1.0', '@modus/context-engine@1.3.0'],
        service,
      );
      expect(cliResult.success).toBe(true);
      expect(cliResult.output).toContain('Update plan:');
      expect(cliResult.output).toContain('Phase 1');
      expect(cliResult.output).toContain('@modus/memory 1.0.0');
      expect(cliResult.output).toContain('Estimated duration:');
    });

    it('rejects plan-updates CLI without explicit targets instead of inventing versions', async () => {
      await service.install(baseMemoryPlugin);

      const cliResult = await executePluginCli(['plan-updates'], service);
      expect(cliResult.success).toBe(false);
      expect(cliResult.error).toContain('Missing update targets');
    });
  });

  describe('14.7 — Fase 14 review regressions: graph freshness & planner totality', () => {
    const capManifest = (version: string, provides: string[]): PluginManifest => ({
      id: '@test/svc',
      name: 'Svc',
      version,
      author: 'Test',
      description: 'Test',
      trustLevel: 'official',
      provides: provides.map((capability) => ({
        capability,
        apiVersion: '1.0',
        implementation: { execute: async () => ({}) },
      })),
      requires: { modus: '>=0.8.0' },
      permissions: { required: {} },
    });

    it('refreshes the graph node on downgrade instead of keeping the rolled-back version', async () => {
      const v1 = capManifest('1.0.0', ['cap.a']);
      const v2 = capManifest('2.0.0', ['cap.b']);
      catalog.add(v1);
      catalog.add(v2);
      await service.install(v1);
      await service.enable('@test/svc');
      await service.upgrade(v2);
      expect(service.getDependencyGraph().getPlugin('@test/svc')?.provides).toEqual(['cap.b']);

      await service.downgrade('@test/svc', '1.0.0');

      const node = service.getDependencyGraph().getPlugin('@test/svc');
      expect(node?.version).toBe('1.0.0');
      expect(node?.provides).toEqual(['cap.a']);
    });

    it('retains host catalog resolution after uninstall', async () => {
      const manifest = capManifest('1.0.0', ['cap.a']);
      catalog.add(manifest);
      await service.install(manifest);
      await service.uninstall('@test/svc');

      expect(service.resolveManifest('@test/svc', '1.0.0')).toBe(manifest);
      expect(service.resolveManifest('@test/svc')).toBe(manifest);
    });

    it('plans updates across cyclic graphs without throwing', () => {
      const graph = new DependencyGraph();
      const mk = (id: string, req: string[]): PluginManifest => ({
        id,
        name: id,
        version: '1.0.0',
        author: 'T',
        description: 'T',
        trustLevel: 'community',
        provides: [{ capability: `cap.${id}`, apiVersion: '1.0', implementation: { execute: () => ({}) } }],
        requires: { modus: '>=0.8.0', plugins: req },
        permissions: { required: {} },
      });
      graph.rebuild([mk('a', ['b']), mk('b', ['a'])]);
      expect(graph.hasCycles()).toBe(true);

      const planner = new UpdatePlanner();
      const plan = planner.planUpdates(
        [
          { pluginId: 'a', currentVersion: '1.0.0', targetVersion: '1.1.0' },
          { pluginId: 'b', currentVersion: '1.0.0', targetVersion: '1.1.0' },
        ],
        graph,
      );
      expect(plan.totalUpdates).toBe(2);
      expect(plan.phases.length).toBeGreaterThan(0);
      expect(plan.phases.flat().length).toBe(2);
    });
  });

  describe('14.6 — Feature Flags & Runtime Integration', () => {
    it('validates feature flag dependencies for MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE', () => {
      const errors = validateFeatureFlags({
        MODUS_USE_KERNEL: true,
        MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE: true,
        MODUS_PLUGINS: false,
      });
      expect(errors).toContain(
        'MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE requires MODUS_PLUGINS to be enabled',
      );

      const kernelErrors = validateFeatureFlags({
        MODUS_USE_KERNEL: false,
        MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE: true,
      });
      expect(kernelErrors).toContain(
        'MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE requires MODUS_USE_KERNEL to be enabled',
      );
    });

    it('accesses live dependency graph through PiSdkRuntime', () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_CAPABILITY_REGISTRY: true,
        MODUS_PLUGINS: true,
        MODUS_PLUGIN_LIFECYCLE: true,
        MODUS_PLUGIN_DEPENDENCY_INTELLIGENCE: true,
      });

      const runtime = new PiSdkRuntime();
      const graph = runtime.getDependencyGraph();
      expect(graph).toBeInstanceOf(DependencyGraph);
    });
  });
});
