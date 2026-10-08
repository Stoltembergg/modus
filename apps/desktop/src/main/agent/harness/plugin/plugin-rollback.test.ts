/**
 * Modus Harness Evolution — Fase 15: Rollback e Safe Mode Tests
 * Comprehensive test suite for Version Preservation, Auto-Rollback, Safe Mode,
 * Self-Healing Recovery, CLI Commands, Feature Flags and PiSdkRuntime integration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../capability/capability-registry';
import {
  resetFeatureFlagOverrides,
  setFeatureFlagOverrides,
  validateFeatureFlags,
} from '../feature-flags';
import { AutoRollbackManager } from './auto-rollback';
import { DependencyGraph } from './dependency-graph';
import { executePluginCli } from './plugin-cli';
import { PluginHealthMonitor } from './plugin-health-monitor';
import { PluginInstrumentation } from './plugin-instrumentation';
import { PluginLifecycleService } from './plugin-lifecycle-service';
import { PluginLoader } from './plugin-loader';
import { PluginRecoveryManager } from './plugin-recovery';
import { UpdateFailedError } from './plugin-rollback-types';
import { PluginStateStore } from './plugin-state-store';
import type { PluginManifest } from './plugin-types';
import { PluginSafeModeManager } from './safe-mode';
import { PluginVersionManager } from './version-manager';
import { TestPluginCatalog } from './plugin-test-catalog';
import { PiSdkRuntime } from '../../pi-sdk-runtime';

describe('Fase 15 — Rollback e Safe Mode', () => {
  let store: PluginStateStore;
  let registry: CapabilityRegistry;
  let loader: PluginLoader;
  let service: PluginLifecycleService;
  let versionManager: PluginVersionManager;
  let safeModeManager: PluginSafeModeManager;
  let instrumentation: PluginInstrumentation;
  let healthMonitor: PluginHealthMonitor;
  let autoRollbackManager: AutoRollbackManager;
  let recoveryManager: PluginRecoveryManager;
  let catalog: TestPluginCatalog;

  const pluginV1: PluginManifest = {
    id: '@modus/test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    author: 'Modus Team',
    description: 'Test plugin v1',
    trustLevel: 'core',
    provides: [
      {
        capability: 'test.run',
        apiVersion: '1.0',
        implementation: {
          execute: async () => ({ v: 1 }),
        },
      },
    ],
    requires: { modus: '>=0.8.0' },
    permissions: { required: {} },
  };

  const pluginV2: PluginManifest = {
    id: '@modus/test-plugin',
    name: 'Test Plugin',
    version: '2.0.0',
    author: 'Modus Team',
    description: 'Test plugin v2',
    trustLevel: 'core',
    provides: [
      {
        capability: 'test.run',
        apiVersion: '1.0',
        implementation: {
          execute: async () => ({ v: 2 }),
        },
      },
    ],
    requires: { modus: '>=0.8.0' },
    permissions: { required: {} },
  };

  beforeEach(() => {
    resetFeatureFlagOverrides();
    store = new PluginStateStore(':memory:');
    registry = new CapabilityRegistry();
    registry.registerCapability({
      id: 'test.run',
      apiVersion: '1.0',
      replaceable: true,
      dependencies: [],
      metadata: { description: 'Test capability' },
    });
    catalog = new TestPluginCatalog();
    catalog.add(pluginV1);
    catalog.add(pluginV2);
    loader = new PluginLoader(registry, catalog);
    service = new PluginLifecycleService(store, loader, registry);
    versionManager = service.getVersionManager();
    safeModeManager = service.getSafeModeManager();
    instrumentation = new PluginInstrumentation();
    healthMonitor = new PluginHealthMonitor(instrumentation);
    autoRollbackManager = new AutoRollbackManager(service, versionManager, healthMonitor);
    recoveryManager = new PluginRecoveryManager(
      service,
      versionManager,
      registry,
      service.getDependencyGraph(),
      healthMonitor,
    );
  });

  afterEach(async () => {
    resetFeatureFlagOverrides();
    for (const p of loader.listPlugins()) {
      await loader.unload(p.manifest.id).catch(() => undefined);
    }
    store.close();
  });

  describe('15.1 — Version Preservation & Version Manager', () => {
    it('rejects rollback to a persisted manifest outside the host catalog', async () => {
      const onLoad = vi.fn();
      const persistedManifest: PluginManifest = {
        ...pluginV1,
        id: '@attacker/persisted-plugin',
        lifecycle: { onLoad },
      };
      const now = new Date().toISOString();
      store.savePlugin({
        id: persistedManifest.id,
        version: persistedManifest.version,
        state: 'enabled',
        trust_level: 'core',
        installed_at: now,
        last_enabled: now,
        config: null,
      });
      store.saveVersion(persistedManifest.id, persistedManifest.version, persistedManifest, now);

      await expect(versionManager.rollback(persistedManifest.id, persistedManifest.version))
        .rejects.toThrow(/untrusted or unavailable version/i);
      expect(loader.getPlugin(persistedManifest.id)).toBeUndefined();
      expect(registry.listProviders('test.run')).toHaveLength(0);
      expect(onLoad).not.toHaveBeenCalled();
      expect(store.getPlugin(persistedManifest.id)?.state).toBe('enabled');
    });

    it('preserves active version before an upgrade or change', async () => {
      await service.install(pluginV1, { theme: 'dark' });

      const backup = await versionManager.preserveVersion('@modus/test-plugin');
      expect(backup.pluginId).toBe('@modus/test-plugin');
      expect(backup.version).toBe('1.0.0');
      expect(backup.config).toEqual({ theme: 'dark' });
      expect(backup.preservedAt).toBeDefined();

      const versions = await versionManager.listVersions('@modus/test-plugin');
      expect(versions.length).toBeGreaterThanOrEqual(1);
      expect(versions[0]?.version).toBe('1.0.0');
    });

    it('rolls back to a target version successfully', async () => {
      await service.install(pluginV1);
      await service.enable('@modus/test-plugin');

      await versionManager.preserveVersion('@modus/test-plugin');
      await service.upgrade(pluginV2);

      const statusAfterUpgrade = await service.status('@modus/test-plugin');
      expect(statusAfterUpgrade?.version).toBe('2.0.0');

      await versionManager.rollback('@modus/test-plugin', '1.0.0');

      const statusAfterRollback = await service.status('@modus/test-plugin');
      expect(statusAfterRollback?.version).toBe('1.0.0');
      expect(statusAfterRollback?.state).toBe('enabled');
    });

    it('throws descriptive error when target rollback version is not found', async () => {
      await service.install(pluginV1);
      await expect(versionManager.rollback('@modus/test-plugin', '9.9.9')).rejects.toThrow(
        /untrusted or unavailable version/i,
      );
    });

    it('identifies the latest backup version excluding the current version', async () => {
      await service.install(pluginV1);
      await versionManager.preserveVersion('@modus/test-plugin', '1.0.0');
      await service.upgrade(pluginV2);
      await versionManager.preserveVersion('@modus/test-plugin', '2.0.0');

      const latestPrior = await versionManager.getLatestBackup('@modus/test-plugin', '2.0.0');
      expect(latestPrior?.version).toBe('1.0.0');
    });
  });

  describe('15.2 — Automatic Rollback on Failure', () => {
    it('preserves version and completes upgrade when health check succeeds', async () => {
      await service.install(pluginV1);
      await service.enable('@modus/test-plugin');

      await autoRollbackManager.watchUpdate('@modus/test-plugin', pluginV2, {
        healthCheck: async () => ({ healthy: true, errorRate: 0 }),
      });

      const report = await service.status('@modus/test-plugin');
      expect(report?.version).toBe('2.0.0');
    });

    it('automatically rolls back and throws UpdateFailedError when health check fails', async () => {
      await service.install(pluginV1);
      await service.enable('@modus/test-plugin');

      await expect(
        autoRollbackManager.watchUpdate('@modus/test-plugin', pluginV2, {
          threshold: 0.5,
          healthCheck: async () => ({
            healthy: false,
            errorRate: 0.8,
            message: 'High error spike after initialization',
          }),
        }),
      ).rejects.toThrow(UpdateFailedError);

      const report = await service.status('@modus/test-plugin');
      expect(report?.version).toBe('1.0.0');
    });

    it('automatically rolls back via healthMonitor error rate threshold', async () => {
      await service.install(pluginV1);
      await service.enable('@modus/test-plugin');

      // Record simulated errors in health monitor for plugin
      for (let i = 0; i < 6; i++) {
        await instrumentation.trace('@modus/test-plugin', 'test.run', async () => {
          throw new Error('Crash');
        }).catch(() => {});
      }
      for (let i = 0; i < 4; i++) {
        await instrumentation.trace('@modus/test-plugin', 'test.run', async () => ({ ok: true }));
      }

      await expect(
        autoRollbackManager.watchUpdate('@modus/test-plugin', pluginV2, { threshold: 0.5 }),
      ).rejects.toThrow(UpdateFailedError);

      const report = await service.status('@modus/test-plugin');
      expect(report?.version).toBe('1.0.0');
    });

    it('rolls back when upgrade throws during deployment', async () => {
      await service.install(pluginV1);
      await service.enable('@modus/test-plugin');

      // Invalid manifest (missing name)
      const brokenManifest = { ...pluginV2, version: '' } as unknown as PluginManifest;

      await expect(
        autoRollbackManager.watchUpdate('@modus/test-plugin', brokenManifest),
      ).rejects.toThrow();

      const report = await service.status('@modus/test-plugin');
      expect(report?.version).toBe('1.0.0');
    });
  });

  describe('15.3 — Safe Mode (Staged Degradation)', () => {
    const corePlugin: PluginManifest = {
      id: '@test/core',
      name: 'Core Svc',
      version: '1.0.0',
      author: 'T',
      description: 'T',
      trustLevel: 'core',
      provides: [
        { capability: 'cap.core', apiVersion: '1.0', implementation: { execute: async () => ({}) } },
      ],
      requires: { modus: '>=0.8.0' },
      permissions: { required: {} },
    };

    const officialPlugin: PluginManifest = {
      id: '@test/official',
      name: 'Official Svc',
      version: '1.0.0',
      author: 'T',
      description: 'T',
      trustLevel: 'official',
      provides: [
        { capability: 'cap.official', apiVersion: '1.0', implementation: { execute: async () => ({}) } },
      ],
      requires: { modus: '>=0.8.0' },
      permissions: { required: {} },
    };

    const communityPlugin: PluginManifest = {
      id: '@test/community',
      name: 'Community Svc',
      version: '1.0.0',
      author: 'T',
      description: 'T',
      trustLevel: 'community',
      provides: [
        { capability: 'cap.community', apiVersion: '1.0', implementation: { execute: async () => ({}) } },
      ],
      requires: { modus: '>=0.8.0' },
      permissions: { required: {} },
    };

    beforeEach(async () => {
      catalog.add(corePlugin);
      catalog.add(officialPlugin, 'official');
      catalog.add(communityPlugin, 'official');
      registry.registerCapability({ id: 'cap.core', apiVersion: '1.0', replaceable: true, dependencies: [], metadata: { description: 'Core cap' } });
      registry.registerCapability({ id: 'cap.official', apiVersion: '1.0', replaceable: true, dependencies: [], metadata: { description: 'Official cap' } });
      registry.registerCapability({ id: 'cap.community', apiVersion: '1.0', replaceable: true, dependencies: [], metadata: { description: 'Community cap' } });

      await service.install(corePlugin);
      await service.install(officialPlugin);
      await service.install(communityPlugin);
      await service.enable('@test/core');
      await service.enable('@test/official');
      await service.enable('@test/community');
    });

    it('enters safe mode "core" disabling official and community plugins', async () => {
      const res = await safeModeManager.enter('core');

      expect(res.level).toBe('core');
      expect(res.enabledPlugins).toEqual(['@test/core']);
      expect(res.disabledPlugins).toContain('@test/official');
      expect(res.disabledPlugins).toContain('@test/community');

      const coreStatus = await service.status('@test/core');
      const offStatus = await service.status('@test/official');
      const commStatus = await service.status('@test/community');

      expect(coreStatus?.state).toBe('enabled');
      expect(offStatus?.state).toBe('disabled');
      expect(commStatus?.state).toBe('disabled');
    });

    it('enters safe mode "official" allowing core and official plugins', async () => {
      const res = await safeModeManager.enter('official');

      expect(res.level).toBe('official');
      expect(res.enabledPlugins).toContain('@test/core');
      expect(res.enabledPlugins).toContain('@test/official');
      expect(res.disabledPlugins).toEqual([]);
    });

    it('exits safe mode restoring previously active plugins', async () => {
      await safeModeManager.enter('core');
      expect(safeModeManager.isActive()).toBe(true);

      const exitRes = await safeModeManager.exit();
      expect(exitRes.restoredPlugins).toContain('@test/official');
      expect(exitRes.restoredPlugins).toContain('@test/community');
      expect(safeModeManager.isActive()).toBe(false);

      const offStatus = await service.status('@test/official');
      const commStatus = await service.status('@test/community');
      expect(offStatus?.state).toBe('enabled');
      expect(commStatus?.state).toBe('enabled');
    });

    it('tracks status accurately', async () => {
      expect(safeModeManager.getStatus().active).toBe(false);

      await safeModeManager.enter('core');
      const status = safeModeManager.getStatus();
      expect(status.active).toBe(true);
      expect(status.level).toBe('core');
      expect(status.disabledPlugins.length).toBe(2);
    });
  });

  describe('15.4 — Self-Healing Diagnosis & Recovery', () => {
    it('diagnoses plugins in error state', async () => {
      await service.install(pluginV1);
      store.updatePluginState('@modus/test-plugin', 'error');

      const report = await recoveryManager.diagnose();
      expect(report.healthy).toBe(false);
      expect(report.issues.length).toBe(1);
      expect(report.issues[0]?.type).toBe('plugin_error');
      expect(report.issues[0]?.recommendation).toBe('rollback_or_disable');
    });

    it('diagnoses missing plugin and capability dependencies', async () => {
      const depPlugin: PluginManifest = {
        id: '@test/dependent',
        name: 'Dependent',
        version: '1.0.0',
        author: 'T',
        description: 'T',
        trustLevel: 'official',
        provides: [
          { capability: 'test.run', apiVersion: '1.0', implementation: { execute: async () => ({}) } },
        ],
        requires: {
          modus: '>=0.8.0',
          plugins: ['@test/non-existent'],
          capabilities: [{ capability: 'missing.cap', version: '^1.0.0' }],
        },
        permissions: { required: {} },
      };

      catalog.add(depPlugin);
      await service.install(depPlugin);
      // Force enabled state in store to simulate startup misconfiguration
      store.updatePluginState('@test/dependent', 'enabled');

      const report = await recoveryManager.diagnose();
      expect(report.healthy).toBe(false);
      const depIssue = report.issues.find((i) => i.type === 'missing_dependencies');
      expect(depIssue).toBeDefined();
      expect(depIssue?.missing).toContain('plugin:@test/non-existent');
      expect(depIssue?.missing).toContain('capability:missing.cap');
    });

    it('diagnoses circular dependencies', async () => {
      const pA: PluginManifest = {
        id: '@test/a',
        name: 'A',
        version: '1.0.0',
        author: 'T',
        description: 'T',
        trustLevel: 'community',
        provides: [{ capability: 'cap.a', apiVersion: '1.0', implementation: { execute: () => ({}) } }],
        requires: { modus: '>=0.8.0', plugins: ['@test/b'] },
        permissions: { required: {} },
      };
      const pB: PluginManifest = {
        id: '@test/b',
        name: 'B',
        version: '1.0.0',
        author: 'T',
        description: 'T',
        trustLevel: 'community',
        provides: [{ capability: 'cap.b', apiVersion: '1.0', implementation: { execute: () => ({}) } }],
        requires: { modus: '>=0.8.0', plugins: ['@test/a'] },
        permissions: { required: {} },
      };

      service.getDependencyGraph().rebuild([pA, pB]);

      const report = await recoveryManager.diagnose();
      expect(report.healthy).toBe(false);
      const circIssue = report.issues.find((i) => i.type === 'circular_dependency');
      expect(circIssue).toBeDefined();
    });

    it('diagnoses high failure rate via health monitor', async () => {
      await service.install(pluginV1);
      await service.enable('@modus/test-plugin');

      for (let i = 0; i < 10; i++) {
        await instrumentation.trace('@modus/test-plugin', 'test.run', async () => {
          throw new Error('Err');
        }).catch(() => {});
      }

      const report = await recoveryManager.diagnose();
      expect(report.healthy).toBe(false);
      const failIssue = report.issues.find((i) => i.type === 'high_failure_rate');
      expect(failIssue).toBeDefined();
      expect(failIssue?.errorRate).toBe(1.0);
    });

    it('executes automated recovery: rolls back to previous version when backup exists', async () => {
      await service.install(pluginV1);
      await service.enable('@modus/test-plugin');
      await versionManager.preserveVersion('@modus/test-plugin', '1.0.0');

      await service.upgrade(pluginV2);
      store.updatePluginState('@modus/test-plugin', 'error');

      const recovery = await recoveryManager.recover();
      expect(recovery.actions.length).toBe(1);
      expect(recovery.actions[0]?.actionTaken).toBe('rolled_back');
      expect(recovery.actions[0]?.targetVersion).toBe('1.0.0');

      const status = await service.status('@modus/test-plugin');
      expect(status?.version).toBe('1.0.0');
    });

    it('executes automated recovery: disables plugin if no backup exists', async () => {
      await service.install(pluginV1);
      store.updatePluginState('@modus/test-plugin', 'error');

      const recovery = await recoveryManager.recover();
      expect(recovery.actions.length).toBe(1);
      expect(recovery.actions[0]?.actionTaken).toBe('disabled');

      const status = await service.status('@modus/test-plugin');
      expect(status?.state).toBe('disabled');
    });

    it('supports dry-run recovery without executing mutations', async () => {
      await service.install(pluginV1);
      store.updatePluginState('@modus/test-plugin', 'error');

      const report = await recoveryManager.recover({ dryRun: true });
      expect(report.actions.length).toBe(0);
      expect(report.remainingIssues.length).toBe(1);

      const status = await service.status('@modus/test-plugin');
      expect(status?.state).toBe('error');
    });
  });

  describe('15.5 — CLI Commands Integration', () => {
    it('executes rollback command', async () => {
      await service.install(pluginV1);
      await service.enable('@modus/test-plugin');
      await versionManager.preserveVersion('@modus/test-plugin', '1.0.0');
      await service.upgrade(pluginV2);

      const res = await executePluginCli(['rollback', '@modus/test-plugin', '1.0.0'], service);
      expect(res.success).toBe(true);
      expect(res.output).toContain("rolled back to version 1.0.0");

      const status = await service.status('@modus/test-plugin');
      expect(status?.version).toBe('1.0.0');
    });

    it('executes safe-mode and safe-mode --exit commands', async () => {
      const enterRes = await executePluginCli(['safe-mode', 'core'], service);
      expect(enterRes.success).toBe(true);
      expect(enterRes.output).toContain('Modus Safe Mode (core)');

      const exitRes = await executePluginCli(['safe-mode', '--exit'], service);
      expect(exitRes.success).toBe(true);
      expect(exitRes.output).toContain('Safe Mode disabled');
    });

    it('executes diagnose command and returns human-readable and json output', async () => {
      const diagHuman = await executePluginCli(['diagnose'], service);
      expect(diagHuman.success).toBe(true);
      expect(diagHuman.output).toContain('Plugin System Diagnosis');

      const diagJson = await executePluginCli(['diagnose', '--json'], service);
      expect(diagJson.success).toBe(true);
      const parsed = JSON.parse(diagJson.output);
      expect(parsed.healthy).toBe(true);
    });

    it('executes recover command', async () => {
      await service.install(pluginV1);
      store.updatePluginState('@modus/test-plugin', 'error');

      const recRes = await executePluginCli(['recover'], service);
      expect(recRes.success).toBe(true);
      expect(recRes.output).toContain('Plugin Recovery Execution:');
      expect(recRes.output).toContain('@modus/test-plugin');
    });
  });

  describe('15.6 — Feature Flags & Runtime Integration', () => {
    it('validates feature flag dependencies for MODUS_PLUGIN_ROLLBACK_SAFE_MODE', () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: false,
        MODUS_PLUGINS: true,
        MODUS_PLUGIN_ROLLBACK_SAFE_MODE: true,
      });

      const errors = validateFeatureFlags();
      expect(errors).toContain(
        'MODUS_PLUGIN_ROLLBACK_SAFE_MODE requires MODUS_USE_KERNEL to be enabled',
      );
    });

    it('accesses versionManager, safeModeManager, recoveryManager and autoRollbackManager through PiSdkRuntime', () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_CAPABILITY_REGISTRY: true,
        MODUS_PLUGINS: true,
        MODUS_PLUGIN_LIFECYCLE: true,
        MODUS_PLUGIN_ROLLBACK_SAFE_MODE: true,
      });

      const runtime = new PiSdkRuntime();
      expect(runtime.getPluginVersionManager()).toBeInstanceOf(PluginVersionManager);
      expect(runtime.getPluginSafeModeManager()).toBeInstanceOf(PluginSafeModeManager);
      expect(runtime.getPluginRecoveryManager()).toBeInstanceOf(PluginRecoveryManager);
      expect(runtime.getAutoRollbackManager()).toBeInstanceOf(AutoRollbackManager);
    });
  });
});
