/**
 * Modus Harness Evolution — Fase 12: Plugin Tracing
 * Type definitions for plugin execution traces, health monitoring, and failure correlation.
 */

export type PluginTraceStatus = "success" | "error" | "timeout" | "cancelled";

export interface PluginTraceMetadata {
  inputSize?: number | undefined;
  outputSize?: number | undefined;
  cacheHit?: boolean | undefined;
  requestId?: string | undefined;
  [key: string]: unknown;
}

export interface PluginTrace {
  traceId: string;
  pluginId: string;
  capability: string;
  version: string;
  startTime: number;
  endTime?: number | undefined;
  durationMs?: number | undefined;
  status: PluginTraceStatus;
  error?: string | undefined;
  metadata?: PluginTraceMetadata | undefined;
}

export type PluginHealthStatus = "healthy" | "degraded" | "failing";

export interface PluginHealth {
  pluginId: string;
  status: PluginHealthStatus;
  totalCalls: number;
  errorCount: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  lastError?: string | undefined;
  lastCheck: Date;
}

export interface PluginCorrelationEvidence {
  updateTime?: Date | undefined;
  failureCount?: number | undefined;
  pattern?: string | undefined;
  errorRate?: number | undefined;
  matchedCapabilities?: string[] | undefined;
  [key: string]: unknown;
}

export interface PluginCorrelation {
  suspect: string; // Plugin ID identified as cause of failure
  confidence: number; // 0.0 to 1.0
  evidence: PluginCorrelationEvidence;
}

export interface FailureContext {
  error: unknown;
  capability?: string | undefined;
  pluginId?: string | undefined;
  timestamp?: number | undefined;
  stack?: string | undefined;
}
