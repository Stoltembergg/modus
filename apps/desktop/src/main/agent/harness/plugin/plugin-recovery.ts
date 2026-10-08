/**
 * Modus Harness Evolution — Fase 15: Rollback e Safe Mode
 * Plugin Recovery Manager: automatic self-healing, diagnosis, and issue remediation.
 */

import type { CapabilityRegistry } from '../capability/capability-registry';
import type { DependencyGraph } from './dependency-graph';
import type { PluginHealthMonitor } from './plugin-health-monitor';
import type { PluginLifecycleService } from './plugin-lifecycle-service';
import type {
  DiagnosisReport,
  PluginDiagnosisIssue,
  RecoveryAction,
  RecoveryReport,
} from './plugin-rollback-types';
import type { PluginVersionManager } from './version-manager';

export class PluginRecoveryManager {
  private service: PluginLifecycleService;
  private versionManager: PluginVersionManager;
  private registry: CapabilityRegistry;
  private graph: DependencyGraph;
  private healthMonitor?: PluginHealthMonitor | undefined;

  constructor(
    service: PluginLifecycleService,
    versionManager: PluginVersionManager,
    registry: CapabilityRegistry,
    graph: DependencyGraph,
    healthMonitor?: PluginHealthMonitor,
  ) {
    this.service = service;
    this.versionManager = versionManager;
    this.registry = registry;
    this.graph = graph;
    this.healthMonitor = healthMonitor;
  }

  /**
   * Diagnoses the health of the entire plugin subsystem.
   */
  public async diagnose(): Promise<DiagnosisReport> {
    const issues: PluginDiagnosisIssue[] = [];
    const plugins = await this.service.list();

    // 1. Check for plugins in error state
    for (const p of plugins) {
      if (p.state === 'error') {
        const events = this.service.getStore().getEvents(p.id, 5);
        const lastErrorEvent = events.find((e) => e.event_type.includes('error'));
        const errorDetail = (lastErrorEvent?.details?.['error'] as string) ?? 'Plugin in error state';

        issues.push({
          type: 'plugin_error',
          pluginId: p.id,
          severity: 'high',
          error: errorDetail,
          recommendation: 'rollback_or_disable',
        });
      }
    }

    // 2. Check for missing dependencies for enabled plugins
    for (const p of plugins) {
      if (p.state === 'enabled') {
        const manifest = this.service.resolveManifest(p.id, p.version);
        if (manifest?.requires) {
          const missing: string[] = [];

          // Missing required plugins
          if (manifest.requires.plugins) {
            for (const requiredPluginId of manifest.requires.plugins) {
              const reqRecord = this.service.getStore().getPlugin(requiredPluginId);
              if (!reqRecord || reqRecord.state === 'disabled' || reqRecord.state === 'error') {
                missing.push(`plugin:${requiredPluginId}`);
              }
            }
          }

          // Missing required capabilities
          if (manifest.requires.capabilities) {
            for (const reqCap of manifest.requires.capabilities) {
              const provider = this.registry.getActiveProvider(reqCap.capability);
              if (!provider) {
                missing.push(`capability:${reqCap.capability}`);
              }
            }
          }

          if (missing.length > 0) {
            issues.push({
              type: 'missing_dependencies',
              pluginId: p.id,
              severity: 'medium',
              missing,
              recommendation: 'install_dependencies',
            });
          }
        }
      }
    }

    // 3. Check for circular dependencies
    if (this.graph.hasCycles()) {
      const cycles = this.graph.findCycles();
      for (const cycle of cycles) {
        issues.push({
          type: 'circular_dependency',
          pluginId: cycle[0] ?? 'unknown',
          severity: 'critical',
          cycle,
          recommendation: 'remove_one',
        });
      }
    }

    // 4. Check for high failure rate via health monitor
    if (this.healthMonitor) {
      for (const p of plugins) {
        if (p.state === 'enabled') {
          const health = this.healthMonitor.getHealth(p.id);
          if (health.totalCalls > 0 && health.errorRate > 0.5) {
            issues.push({
              type: 'high_failure_rate',
              pluginId: p.id,
              severity: 'high',
              errorRate: health.errorRate,
              error: health.lastError ?? `High error rate (${(health.errorRate * 100).toFixed(1)}%)`,
              recommendation: 'rollback_or_disable',
            });
          }
        }
      }
    }

    const recommendations = this.generateRecommendations(issues);

    return {
      healthy: issues.length === 0,
      issues,
      recommendations,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Executes automatic recovery actions based on diagnosis.
   */
  public async recover(options?: { dryRun?: boolean }): Promise<RecoveryReport> {
    const diagnosis = await this.diagnose();
    const actions: RecoveryAction[] = [];

    if (diagnosis.healthy || options?.dryRun) {
      return {
        recovered: diagnosis.healthy,
        actions,
        remainingIssues: diagnosis.issues,
      };
    }

    for (const issue of diagnosis.issues) {
      switch (issue.recommendation) {
        case 'rollback_or_disable': {
          const plugin = this.service.getStore().getPlugin(issue.pluginId);
          const currentVersion = plugin?.version;
          const versions = await this.versionManager.listVersions(issue.pluginId);
          const candidates = versions.filter((v) => v.version !== currentVersion);

          if (candidates.length > 0 && candidates[0]) {
            const targetVersion = candidates[0].version;
            try {
              await this.versionManager.rollback(issue.pluginId, targetVersion);
              actions.push({
                pluginId: issue.pluginId,
                issueType: issue.type,
                actionTaken: 'rolled_back',
                targetVersion,
                details: `Rolled back to previous version ${targetVersion}`,
              });
            } catch (err) {
              await this.service.disable(issue.pluginId).catch(() => undefined);
              actions.push({
                pluginId: issue.pluginId,
                issueType: issue.type,
                actionTaken: 'disabled',
                details: `Rollback failed (${err instanceof Error ? err.message : String(err)}), disabled plugin`,
              });
            }
          } else {
            await this.service.disable(issue.pluginId).catch(() => undefined);
            actions.push({
              pluginId: issue.pluginId,
              issueType: issue.type,
              actionTaken: 'disabled',
              details: 'No previous backup version available to rollback, disabled plugin',
            });
          }
          break;
        }

        case 'remove_one': {
          // Circular dependency: disable the identified plugin to break the cycle
          await this.service.disable(issue.pluginId).catch(() => undefined);
          actions.push({
            pluginId: issue.pluginId,
            issueType: issue.type,
            actionTaken: 'disabled',
            details: `Disabled plugin to break circular dependency cycle: ${issue.cycle?.join(' -> ')}`,
          });
          break;
        }

        case 'install_dependencies': {
          // Disable dependent plugin temporarily until dependencies are resolved
          await this.service.disable(issue.pluginId).catch(() => undefined);
          actions.push({
            pluginId: issue.pluginId,
            issueType: issue.type,
            actionTaken: 'disabled',
            details: `Disabled plugin due to missing dependencies: ${issue.missing?.join(', ')}`,
          });
          break;
        }

        case 'disable': {
          await this.service.disable(issue.pluginId).catch(() => undefined);
          actions.push({
            pluginId: issue.pluginId,
            issueType: issue.type,
            actionTaken: 'disabled',
            details: 'Disabled plugin',
          });
          break;
        }
      }
    }

    const postDiagnosis = await this.diagnose();

    return {
      recovered: postDiagnosis.healthy,
      actions,
      remainingIssues: postDiagnosis.issues,
    };
  }

  private generateRecommendations(issues: PluginDiagnosisIssue[]): string[] {
    const list: string[] = [];
    for (const issue of issues) {
      if (issue.recommendation === 'rollback_or_disable') {
        list.push(`Rollback '${issue.pluginId}' to previous version, or disable it.`);
      } else if (issue.recommendation === 'remove_one') {
        list.push(`Break circular dependency cycle involving '${issue.pluginId}'.`);
      } else if (issue.recommendation === 'install_dependencies') {
        list.push(`Install missing dependencies for '${issue.pluginId}': ${issue.missing?.join(', ')}`);
      }
    }
    return list;
  }
}
