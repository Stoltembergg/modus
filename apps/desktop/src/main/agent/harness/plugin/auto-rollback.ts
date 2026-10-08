/**
 * Modus Harness Evolution — Fase 15: Rollback e Safe Mode
 * Auto Rollback Manager: monitors post-upgrade plugin health and executes automatic rollback upon failure.
 */

import type { PluginHealthMonitor } from './plugin-health-monitor';
import type { PluginLifecycleService } from './plugin-lifecycle-service';
import { UpdateFailedError } from './plugin-rollback-types';
import type { PluginManifest } from './plugin-types';
import type { PluginVersionManager } from './version-manager';

export interface WatchUpdateOptions {
  threshold?: number; // error rate threshold (default 0.5 = 50%)
  healthCheck?: () => Promise<{ healthy: boolean; errorRate?: number; message?: string }> | {
    healthy: boolean;
    errorRate?: number;
    message?: string;
  };
}

export class AutoRollbackManager {
  private service: PluginLifecycleService;
  private versionManager: PluginVersionManager;
  private healthMonitor?: PluginHealthMonitor | undefined;

  constructor(
    service: PluginLifecycleService,
    versionManager: PluginVersionManager,
    healthMonitor?: PluginHealthMonitor,
  ) {
    this.service = service;
    this.versionManager = versionManager;
    this.healthMonitor = healthMonitor;
  }

  /**
   * Watches an upgrade operation, preserving the previous version and rolling back
   * automatically if the post-upgrade health check fails or error rate exceeds threshold.
   */
  public async watchUpdate(
    pluginId: string,
    newManifest: PluginManifest,
    options?: WatchUpdateOptions,
  ): Promise<void> {
    const pluginRecord = this.service.getStore().getPlugin(pluginId);
    const previousVersion = pluginRecord?.version;
    const threshold = options?.threshold ?? 0.5;

    // 1. Preserve current active version before upgrading
    if (previousVersion) {
      await this.versionManager.preserveVersion(pluginId, previousVersion);
    }

    // 2. Perform the upgrade
    try {
      await this.service.upgrade(newManifest);
    } catch (err) {
      if (previousVersion) {
        try {
          await this.versionManager.rollback(pluginId, previousVersion);
        } catch {
          // Best effort rollback
        }
      }
      throw err;
    }

    // 3. Post-upgrade Health Verification
    let isFailing = false;
    let failureReason = '';
    let observedErrorRate = 0;

    if (options?.healthCheck) {
      const checkResult = await options.healthCheck();
      if (!checkResult.healthy) {
        isFailing = true;
        observedErrorRate = checkResult.errorRate ?? 1.0;
        failureReason = checkResult.message ?? `Post-upgrade health check reported failure (errorRate: ${observedErrorRate})`;
      }
    } else if (this.healthMonitor) {
      const health = this.healthMonitor.getHealth(pluginId);
      observedErrorRate = health.errorRate;
      if (health.status === 'failing' || health.errorRate > threshold) {
        isFailing = true;
        failureReason = `Observed error rate ${(health.errorRate * 100).toFixed(1)}% exceeds threshold ${(threshold * 100).toFixed(1)}%`;
      }
    }

    if (isFailing && previousVersion) {
      // 4. Trigger Automatic Rollback
      await this.versionManager.rollback(pluginId, previousVersion);

      throw new UpdateFailedError(
        `Update of '${pluginId}' to ${newManifest.version} failed post-upgrade health check (${failureReason}). Automatically rolled back to ${previousVersion}.`,
        pluginId,
        newManifest.version,
        previousVersion,
      );
    }
  }
}
