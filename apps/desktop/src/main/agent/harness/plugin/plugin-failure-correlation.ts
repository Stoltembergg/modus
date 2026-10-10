/**
 * Modus Harness Evolution — Fase 12: Plugin Tracing
 * Failure correlation system for attributing runtime errors to specific plugins via timing and pattern analysis.
 */

import type { PluginHealthMonitor } from "./plugin-health-monitor";
import type { PluginInstrumentation } from "./plugin-instrumentation";
import type { PluginStateStore } from "./plugin-state-store";
import type { FailureContext, PluginCorrelation } from "./plugin-tracing-types";

export class PluginFailureCorrelation {
  private instrumentation: PluginInstrumentation;
  private store?: PluginStateStore | undefined;
  private healthMonitor?: PluginHealthMonitor | undefined;

  constructor(
    instrumentation: PluginInstrumentation,
    store?: PluginStateStore,
    healthMonitor?: PluginHealthMonitor,
  ) {
    this.instrumentation = instrumentation;
    this.store = store;
    this.healthMonitor = healthMonitor;
  }

  /**
   * Analyzes an observed failure and correlates it with likely suspect plugins.
   */
  public analyze(failure: FailureContext): PluginCorrelation | null {
    const errorStr = failure.error instanceof Error ? failure.error.message : String(failure.error);
    const stackStr =
      failure.stack ?? (failure.error instanceof Error ? failure.error.stack : "") ?? "";
    const failureTime = failure.timestamp ?? Date.now();

    const candidateScores = new Map<
      string,
      { confidence: number; evidence: Record<string, unknown> }
    >();

    // 1. Direct explicit plugin ID or name mention in error message or stack trace
    const recentTraces = this.instrumentation.getRecentTraces(undefined, 200);
    const observedPluginIds = new Set<string>(recentTraces.map((t) => t.pluginId));

    if (failure.pluginId && observedPluginIds.has(failure.pluginId)) {
      candidateScores.set(failure.pluginId, {
        confidence: 0.95,
        evidence: {
          pattern: "explicit_plugin_failure",
          error: errorStr,
        },
      });
    }

    for (const pluginId of observedPluginIds) {
      if (
        (errorStr.includes(pluginId) || stackStr.includes(pluginId)) &&
        !candidateScores.has(pluginId)
      ) {
        candidateScores.set(pluginId, {
          confidence: 0.9,
          evidence: {
            pattern: "error_or_stack_contains_plugin_id",
            pluginId,
            error: errorStr,
          },
        });
      }
    }

    // 2. Capability match: if capability was specified, check active traces for that capability
    if (failure.capability) {
      const capTraces = recentTraces.filter((t) => t.capability === failure.capability);
      for (const trace of capTraces) {
        const existing = candidateScores.get(trace.pluginId);
        const isErrorTrace = trace.status === "error" || trace.status === "timeout";
        const conf = isErrorTrace ? 0.8 : 0.65;
        if (!existing || existing.confidence < conf) {
          candidateScores.set(trace.pluginId, {
            confidence: conf,
            evidence: {
              pattern: "capability_provider_execution",
              capability: failure.capability,
              providerId: trace.pluginId,
              traceStatus: trace.status,
            },
          });
        }
      }
    }

    // 3. Timing correlation with recent plugin updates (from PluginStateStore)
    if (this.store) {
      try {
        const plugins = this.store.listPlugins();
        for (const p of plugins) {
          const events = this.store.getEvents(p.id, 20);
          const updateEvent = events.find(
            (e) => e.event_type === "upgraded" || e.event_type === "installed",
          );
          if (updateEvent) {
            const updateTime = new Date(updateEvent.timestamp).getTime();
            const timeDiff = failureTime - updateTime;
            // If the failure occurred within 30 minutes after an upgrade or install
            if (timeDiff >= 0 && timeDiff < 30 * 60 * 1000) {
              const pluginTraces = recentTraces.filter((t) => t.pluginId === p.id);
              const postUpdateFailures = pluginTraces.filter(
                (t) =>
                  (t.status === "error" || t.status === "timeout") && t.startTime >= updateTime,
              );

              if (postUpdateFailures.length > 0) {
                const conf = 0.85;
                const existing = candidateScores.get(p.id);
                if (!existing || existing.confidence < conf) {
                  candidateScores.set(p.id, {
                    confidence: conf,
                    evidence: {
                      pattern: "failures_started_after_update",
                      updateTime: new Date(updateEvent.timestamp),
                      failureCount: postUpdateFailures.length,
                      eventType: updateEvent.event_type,
                    },
                  });
                }
              }
            }
          }
        }
      } catch {
        // Fallback gracefully if store is unavailable
      }
    }

    // 4. Degradation check via HealthMonitor
    if (this.healthMonitor) {
      for (const pluginId of observedPluginIds) {
        const health = this.healthMonitor.getHealth(pluginId);
        if (health.status === "failing" || health.status === "degraded") {
          const existing = candidateScores.get(pluginId);
          const conf = health.status === "failing" ? 0.75 : 0.6;
          if (!existing || existing.confidence < conf) {
            candidateScores.set(pluginId, {
              confidence: conf,
              evidence: {
                pattern: "plugin_health_degraded",
                status: health.status,
                errorRate: health.errorRate,
                p95LatencyMs: health.p95LatencyMs,
              },
            });
          }
        }
      }
    }

    // Find candidate with highest confidence
    let topSuspect: string | null = null;
    let topScore = -1;
    let topEvidence: Record<string, unknown> = {};

    for (const [id, score] of candidateScores.entries()) {
      if (score.confidence > topScore) {
        topScore = score.confidence;
        topSuspect = id;
        topEvidence = score.evidence;
      }
    }

    if (!topSuspect || topScore <= 0) {
      return null;
    }

    return {
      suspect: topSuspect,
      confidence: topScore,
      evidence: topEvidence,
    };
  }
}
