/**
 * @file plugin-dependency-types.ts
 * Types and contracts for Fase 14 — Dependency Intelligence.
 */

export interface DependencyNode {
  pluginId: string;
  version: string;
  provides: string[];
  requiresCapabilities: string[];
  requiresPlugins: string[];
  dependencies: string[]; // Plugins that this plugin directly depends on
  dependents: string[]; // Plugins that depend directly on this plugin
}

export type BlastRadiusSeverity = "none" | "low" | "medium" | "high" | "critical";

export interface TransitiveDependent {
  pluginId: string;
  via: string[];
}

export interface BlastRadius {
  targetPluginId: string;
  directDependents: string[];
  transitiveDependents: TransitiveDependent[];
  totalAffected: number;
  severity: BlastRadiusSeverity;
  critical: boolean;
  message: string;
}

export class CircularDependencyError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Circular dependency detected: ${cycle.join(" -> ")}`);
    this.name = "CircularDependencyError";
  }
}

export interface PluginUpdate {
  pluginId: string;
  currentVersion: string;
  targetVersion: string;
}

export interface UpdatePlan {
  phases: PluginUpdate[][];
  totalPhases: number;
  totalUpdates: number;
  estimatedDurationSec: number;
}
