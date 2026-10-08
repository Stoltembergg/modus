/**
 * Modus Harness Evolution — Fase 10: Modus Internal Plugins
 * Type contracts for plugin descriptors, requirements, provisions, and lifecycle hooks.
 */

import type {
  CapabilityImplementation,
  PluginPermissions,
  TrustLevel,
} from "../capability/capability-types";

export interface CapabilityRequirement {
  capability: string; // e.g., "memory.retrieve"
  version: string; // semver range, e.g., "^1.0", "1.0", ">=1.0"
}

export interface CapabilityProvision {
  capability: string; // e.g., "memory.retrieve"
  apiVersion: string; // e.g., "1.0"
  implementation?: CapabilityImplementation | undefined;
  config?: Record<string, unknown> | undefined;
}

export interface PluginLifecycleHooks {
  onLoad?: (() => Promise<void> | void) | undefined;
  onUnload?: (() => Promise<void> | void) | undefined;
  onEnable?: (() => Promise<void> | void) | undefined;
  onDisable?: (() => Promise<void> | void) | undefined;
}

export interface PluginManifest {
  id: string; // e.g. "@modus/memory", "@modus/model-router"
  name: string; // e.g. "Modus Memory Service"
  version: string; // semver format, e.g. "1.0.0"
  author: string;
  description: string;
  trustLevel: TrustLevel; // 'core' | 'official' | 'verified' | 'community' | 'local'

  provides: CapabilityProvision[];
  requires: {
    modus: string; // e.g. ">=0.8.0"
    capabilities?: CapabilityRequirement[] | undefined;
    plugins?: string[] | undefined;
  };

  permissions: {
    required: PluginPermissions;
    optional?: PluginPermissions | undefined;
    reason?: Record<string, string> | undefined;
  };

  lifecycle?: PluginLifecycleHooks | undefined;
}

export type PluginStatus = "unloaded" | "loaded" | "enabled" | "disabled" | "error";

export interface LoadedPlugin {
  manifest: PluginManifest;
  status: PluginStatus;
  loadedAt: Date;
  implementations: Record<string, CapabilityImplementation>;
  error?: string | undefined;
}

export class PluginValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginValidationError";
  }
}

export class PluginDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginDependencyError";
  }
}

export class PluginLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginLifecycleError";
  }
}
