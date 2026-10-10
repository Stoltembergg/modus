/**
 * Modus Harness Evolution — Fase 15: Rollback e Safe Mode
 * Type definitions for Version Preservation, Auto-Rollback, Safe Mode and Self-Healing Recovery.
 */

import type { PluginManifest } from "./plugin-types";

export type SafeModeLevel = "core" | "official" | "verified";

export interface PluginBackup {
  pluginId: string;
  version: string;
  manifest: PluginManifest;
  config: Record<string, unknown> | null;
  preservedAt: string;
}

export type DiagnosisIssueType =
  | "plugin_error"
  | "missing_dependencies"
  | "circular_dependency"
  | "high_failure_rate";

export type DiagnosisRecommendation =
  | "rollback_or_disable"
  | "install_dependencies"
  | "remove_one"
  | "disable";

export interface PluginDiagnosisIssue {
  type: DiagnosisIssueType;
  pluginId: string;
  severity: "low" | "medium" | "high" | "critical";
  error?: string | undefined;
  missing?: string[] | undefined;
  cycle?: string[] | undefined;
  errorRate?: number | undefined;
  recommendation: DiagnosisRecommendation;
}

export interface DiagnosisReport {
  healthy: boolean;
  issues: PluginDiagnosisIssue[];
  recommendations: string[];
  timestamp: string;
}

export type RecoveryActionType = "rolled_back" | "disabled" | "uninstalled" | "none";

export interface RecoveryAction {
  pluginId: string;
  issueType: DiagnosisIssueType;
  actionTaken: RecoveryActionType;
  targetVersion?: string | undefined;
  details?: string | undefined;
}

export interface RecoveryReport {
  recovered: boolean;
  actions: RecoveryAction[];
  remainingIssues: PluginDiagnosisIssue[];
}

export class UpdateFailedError extends Error {
  public readonly pluginId: string;
  public readonly attemptedVersion: string;
  public readonly rolledBackToVersion: string;

  constructor(
    message: string,
    pluginId: string,
    attemptedVersion: string,
    rolledBackToVersion: string,
  ) {
    super(message);
    this.name = "UpdateFailedError";
    this.pluginId = pluginId;
    this.attemptedVersion = attemptedVersion;
    this.rolledBackToVersion = rolledBackToVersion;
  }
}
