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
    const allowedTrusts = this.getTrustLevelsForMode(level);
    const allPlugins = await this.service.list();

    const currentlyEnabled = allPlugins.filter((p) => p.state === "enabled");

    // Only record previous enabled baseline if not already in safe mode
    if (!this.active) {
      this.previouslyEnabledPlugins = currentlyEnabled.map((p) => p.id);
      this.safeModeDisabledPlugins = [];
    }

    const enabledPlugins: string[] = [];
    const disabledPlugins: string[] = [];

    for (const plugin of currentlyEnabled) {
      if (!allowedTrusts.includes(plugin.trust_level)) {
        await this.service.disable(plugin.id);
        disabledPlugins.push(plugin.id);
        if (!this.safeModeDisabledPlugins.includes(plugin.id)) {
          this.safeModeDisabledPlugins.push(plugin.id);
        }
      } else {
        enabledPlugins.push(plugin.id);
      }
    }

    this.active = true;
    this.currentLevel = level;

    return {
      level,
      enabledPlugins,
      disabledPlugins,
    };
  }

  /**
   * Exits Safe Mode, restoring previously active plugins.
   */
  public async exit(): Promise<{ restoredPlugins: string[] }> {
    if (!this.active) {
      return { restoredPlugins: [] };
    }

    const restoredPlugins: string[] = [];

    for (const pluginId of this.previouslyEnabledPlugins) {
      const plugin = this.service.getStore().getPlugin(pluginId);
      if (plugin && plugin.state !== "enabled") {
        try {
          await this.service.enable(pluginId);
          restoredPlugins.push(pluginId);
        } catch {
          // If enabling fails (e.g. broken plugin), skip
        }
      }
    }

    this.active = false;
    this.currentLevel = null;
    this.previouslyEnabledPlugins = [];
    this.safeModeDisabledPlugins = [];

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
