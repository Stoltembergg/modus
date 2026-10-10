/**
 * @file capability-provenance.ts
 * Provenance tracking and execution telemetry for Capability Providers.
 */

import type {
  CapabilityExecutionTrace,
  CapabilityProvenance,
  CapabilityProviderDescriptor,
} from "./capability-types";

interface ProviderStats {
  usageCount: number;
  failureCount: number;
  totalDurationMs: number;
  lastUsed?: Date | undefined;
}

export class ProvenanceTracker {
  private traces: CapabilityExecutionTrace[] = [];
  private statsByCapabilityProvider = new Map<string, ProviderStats>();
  private readonly maxTraces: number;

  constructor(maxTraces: number = 2000) {
    this.maxTraces = maxTraces;
  }

  private getKey(capabilityId: string, providerId: string): string {
    return `${capabilityId}:${providerId}`;
  }

  public recordStart(
    traceId: string,
    capability: string,
    capabilityApiVersion: string,
    providerId: string,
    providerVersion: string,
  ): CapabilityExecutionTrace {
    const trace: CapabilityExecutionTrace = {
      traceId,
      capability,
      capabilityApiVersion,
      providerId,
      providerVersion,
      startTime: Date.now(),
    };
    this.traces.push(trace);
    if (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }
    return trace;
  }

  public recordSuccess(
    traceId: string,
    capabilityId: string,
    providerId: string,
    durationMs: number,
  ): void {
    const trace = this.traces.find((t) => t.traceId === traceId);
    if (trace) {
      trace.endTime = Date.now();
      trace.durationMs = durationMs;
      trace.success = true;
    }

    const key = this.getKey(capabilityId, providerId);
    const stats = this.statsByCapabilityProvider.get(key) ?? {
      usageCount: 0,
      failureCount: 0,
      totalDurationMs: 0,
    };
    stats.usageCount++;
    stats.totalDurationMs += durationMs;
    stats.lastUsed = new Date();
    this.statsByCapabilityProvider.set(key, stats);
  }

  public recordFailure(
    traceId: string,
    capabilityId: string,
    providerId: string,
    durationMs: number,
    error: unknown,
  ): void {
    const trace = this.traces.find((t) => t.traceId === traceId);
    if (trace) {
      trace.endTime = Date.now();
      trace.durationMs = durationMs;
      trace.success = false;
      trace.error = error instanceof Error ? error.message : String(error);
    }

    const key = this.getKey(capabilityId, providerId);
    const stats = this.statsByCapabilityProvider.get(key) ?? {
      usageCount: 0,
      failureCount: 0,
      totalDurationMs: 0,
    };
    stats.usageCount++;
    stats.failureCount++;
    stats.totalDurationMs += durationMs;
    stats.lastUsed = new Date();
    this.statsByCapabilityProvider.set(key, stats);
  }

  public getProvenance(
    capabilityId: string,
    apiVersion: string,
    activeProvider: CapabilityProviderDescriptor,
    allProviders: CapabilityProviderDescriptor[],
  ): CapabilityProvenance {
    const key = this.getKey(capabilityId, activeProvider.providerId);
    const stats = this.statsByCapabilityProvider.get(key);

    const usageCount = stats?.usageCount ?? 0;
    const failureCount = stats?.failureCount ?? 0;
    const errorRate = usageCount > 0 ? failureCount / usageCount : 0;
    const avgLatencyMs =
      usageCount > 0 && stats ? Math.round(stats.totalDurationMs / usageCount) : undefined;

    const alternatives = allProviders
      .filter((p) => p.providerId !== activeProvider.providerId)
      .map((p) => ({
        id: p.providerId,
        version: p.providerVersion,
        trustLevel: p.trustLevel,
      }));

    return {
      capability: capabilityId,
      apiVersion,
      activeProvider: {
        id: activeProvider.providerId,
        version: activeProvider.providerVersion,
        trustLevel: activeProvider.trustLevel,
      },
      alternativeProviders: alternatives,
      usageCount,
      lastUsed: stats?.lastUsed,
      errorRate,
      avgLatencyMs,
    };
  }

  public getTraces(capabilityId?: string, limit: number = 50): CapabilityExecutionTrace[] {
    const filtered = capabilityId
      ? this.traces.filter((t) => t.capability === capabilityId)
      : this.traces;
    return filtered.slice(-limit);
  }

  public clear(): void {
    this.traces = [];
    this.statsByCapabilityProvider.clear();
  }
}
