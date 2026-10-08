/**
 * Modus Harness Evolution — Fase 12: Plugin Tracing
 * Health monitoring system for plugins based on execution traces, error rates, and P95 latencies.
 */

import type { PluginInstrumentation } from './plugin-instrumentation';
import type { PluginHealth, PluginHealthStatus } from './plugin-tracing-types';

export class PluginHealthMonitor {
  private instrumentation: PluginInstrumentation;

  constructor(instrumentation: PluginInstrumentation) {
    this.instrumentation = instrumentation;
  }

  /**
   * Evaluates the health of a specific plugin using its recent execution window.
   */
  public getHealth(pluginId: string, windowLimit: number = 1000): PluginHealth {
    const traces = this.instrumentation.getRecentTraces(pluginId, windowLimit);
    const totalCalls = traces.length;

    if (totalCalls === 0) {
      return {
        pluginId,
        status: 'healthy',
        totalCalls: 0,
        errorCount: 0,
        errorRate: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        lastCheck: new Date(),
      };
    }

    const failedTraces = traces.filter((t) => t.status === 'error' || t.status === 'timeout');
    const errorCount = failedTraces.length;
    const errorRate = errorCount / totalCalls;

    const durations = traces.map((t) => t.durationMs ?? 0);
    const sumDuration = durations.reduce((acc, d) => acc + d, 0);
    const avgLatencyMs = Math.round(sumDuration / totalCalls);

    const sortedDurations = [...durations].sort((a, b) => a - b);
    const p95Index = Math.floor(sortedDurations.length * 0.95);
    const p95LatencyMs = sortedDurations[p95Index] ?? avgLatencyMs;

    const lastFailed = [...traces].reverse().find((t) => t.error !== undefined);
    const lastError = lastFailed?.error;

    const status = this.determineStatus(errorRate, p95LatencyMs);

    return {
      pluginId,
      status,
      totalCalls,
      errorCount,
      errorRate: Math.round(errorRate * 1000) / 1000,
      avgLatencyMs,
      p95LatencyMs,
      lastError,
      lastCheck: new Date(),
    };
  }

  /**
   * Health status classification rule:
   * - 'failing': error rate > 10% (0.10) OR P95 latency > 5000ms
   * - 'degraded': error rate > 5% (0.05) OR P95 latency > 2000ms
   * - 'healthy': otherwise
   */
  public determineStatus(errorRate: number, p95LatencyMs: number): PluginHealthStatus {
    if (errorRate > 0.1 || p95LatencyMs > 5000) {
      return 'failing';
    }
    if (errorRate > 0.05 || p95LatencyMs > 2000) {
      return 'degraded';
    }
    return 'healthy';
  }

  /**
   * Returns a map of health status for all plugins observed in traces.
   */
  public getAllHealth(windowLimit: number = 1000): Map<string, PluginHealth> {
    const allTraces = this.instrumentation.getRecentTraces(undefined, windowLimit);
    const pluginIds = new Set<string>(allTraces.map((t) => t.pluginId));

    const result = new Map<string, PluginHealth>();
    for (const pluginId of pluginIds) {
      result.set(pluginId, this.getHealth(pluginId, windowLimit));
    }
    return result;
  }

  public isDegraded(pluginId: string): boolean {
    const health = this.getHealth(pluginId);
    return health.status === 'degraded' || health.status === 'failing';
  }
}
