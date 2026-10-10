/**
 * Modus Harness Evolution — Fase 15: Rollback e Safe Mode
 * Safe Mode Manager: staged system initialization by trust level ('core', 'official', 'verified').
 */

import type { TrustLevel } from "../capability/capability-types";
import type { PluginLifecycleService } from "./plugin-lifecycle-service";
import type { SafeModeLevel } from "./plugin-rollback-types";

export class PluginSafeModeManager {
  private service: PluginLifecycleService;
  private active: boolean = false;
  private currentLevel: SafeModeLevel | null = null;
  private previouslyEnabledPlugins: string[] = [];
  private safeModeDisabledPlugins: string[] = [];

  constructor(service: PluginLifecycleService) {
    this.service = service;
    const persisted = service.getSafeModeState();
    this.active = persisted.level !== null;
    this.currentLevel = persisted.level;
    this.previouslyEnabledPlugins = persisted.previouslyEnabled;
    this.safeModeDisabledPlugins = persisted.disabledPlugins;
  }

  /**
   * Returns acceptable trust levels for a given safe mode level.
   */
  public getTrustLevelsForMode(level: SafeModeLevel): TrustLevel[] {
    switch (level) {
      case "core":
        return ["core"];
      case "official":
        return ["core", "official"];
      case "verified":
        return ["core", "official", "verified"];
      default:
        return ["core"];
    }
  }

  /**
   * Enters Safe Mode with the specified trust level filter.
   * Disables any currently enabled plugins that do not satisfy the trust threshold.
   */
  public async enter(
    level: SafeModeLevel = "core",
  ): Promise<{ level: SafeModeLevel; enabledPlugins: string[]; disabledPlugins: string[] }> {
    let result: Awaited<ReturnType<PluginLifecycleService["enterSafeMode"]>>;
    try {
      result = await this.service.enterSafeMode(level);
    } catch (error) {
      // The durable gate is written before providers are disabled. If a later
      // shutdown step fails, report the persisted restrictive state accurately.
      const persisted = this.service.getSafeModeState();
      this.active = persisted.level !== null;
      this.currentLevel = persisted.level;
      this.previouslyEnabledPlugins = persisted.previouslyEnabled;
      this.safeModeDisabledPlugins = persisted.disabledPlugins;
      throw error;
    }
    this.active = true;
    this.currentLevel = level;
    this.previouslyEnabledPlugins = result.previouslyEnabled;
    this.safeModeDisabledPlugins = result.disabledPlugins;

    return {
      level,
      enabledPlugins: result.enabledPlugins,
      disabledPlugins: result.disabledPlugins,
    };
  }

  /**
   * Exits Safe Mode, restoring previously active plugins.
   */
  public async exit(): Promise<{ restoredPlugins: string[] }> {
    const persisted = this.service.getSafeModeState();
    if (!this.active && persisted.level === null && persisted.previouslyEnabled.length === 0) {
      return { restoredPlugins: [] };
    }

    const restoredPlugins: string[] = [];
    const previouslyEnabled = await this.service.clearSafeMode();
    let restoreOrder = previouslyEnabled;
    try {
      const graph = this.service.getDependencyGraph();
      const cyclicIds = new Set(graph.findCycles().flat());
      const topologicalOrder = graph.topologicalSortExcluding(cyclicIds);
      restoreOrder = [...previouslyEnabled].sort(
        (left, right) => topologicalOrder.indexOf(left) - topologicalOrder.indexOf(right),
      );
    } catch {
      // Individual dependency checks below keep each restore fail-closed.
    }

    for (const pluginId of restoreOrder) {
      try {
        if (await this.service.restoreAfterSafeMode(pluginId)) {
          restoredPlugins.push(pluginId);
        }
        await this.service.markSafeModePluginRestored(pluginId);
      } catch {
        // Keep failed restores durable so a recreated manager can retry them.
      }
    }

    const remaining = this.service.getSafeModeState();
    if (remaining.level === null && remaining.previouslyEnabled.length === 0) {
      await this.service.finishSafeModeExit();
    }
    this.active = remaining.level !== null;
    this.currentLevel = remaining.level;
    this.previouslyEnabledPlugins = remaining.previouslyEnabled;
    this.safeModeDisabledPlugins = remaining.disabledPlugins;

    return { restoredPlugins };
  }

  public isActive(): boolean {
    return this.active;
  }

  public getLevel(): SafeModeLevel | null {
    return this.currentLevel;
  }

  public getStatus(): {
    active: boolean;
    level: SafeModeLevel | null;
    disabledPlugins: string[];
    previouslyEnabled: string[];
  } {
    return {
      active: this.active,
      level: this.currentLevel,
      disabledPlugins: [...this.safeModeDisabledPlugins],
      previouslyEnabled: [...this.previouslyEnabledPlugins],
    };
  }
}
