/**
 * Modus Harness Evolution — Fase 12: Plugin Tracing
 * Instrumentation wrapper for plugin execution with telemetry, timeouts, and metrics collection.
 */

import { randomUUID } from "node:crypto";
import { isFeatureFlagEnabled } from "../feature-flags";
import { HarnessObserver } from "../observability/harness-observer";
import type { PluginTrace, PluginTraceMetadata } from "./plugin-tracing-types";

export interface PluginTraceOptions {
  version?: string | undefined;
  metadata?: PluginTraceMetadata | undefined;
  timeoutMs?: number | undefined;
  sessionId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export type TraceCollector = (trace: PluginTrace) => void;

export class PluginInstrumentation {
  private recentTraces: PluginTrace[] = [];
  private readonly maxTraces: number;
  private collector?: TraceCollector | undefined;
  private versionResolver?: ((pluginId: string) => string | undefined) | undefined;

  constructor(options?: {
    maxTraces?: number;
    collector?: TraceCollector;
    versionResolver?: (pluginId: string) => string | undefined;
  }) {
    this.maxTraces = options?.maxTraces ?? 2000;
    this.collector = options?.collector;
    this.versionResolver = options?.versionResolver;
  }

  public setVersionResolver(resolver: (pluginId: string) => string | undefined): void {
    this.versionResolver = resolver;
  }

  public setCollector(collector: TraceCollector): void {
    this.collector = collector;
  }

  /**
   * Traces execution of a capability provider or plugin function.
   * Seamlessly measures latency, captures errors, enforces timeouts, and dispatches to HarnessObserver.
   */
  public async trace<T>(
    pluginId: string,
    capability: string,
    fn: (signal: AbortSignal) => Promise<T>,
    options?: PluginTraceOptions,
  ): Promise<T> {
    const traceId = randomUUID();
    const version = options?.version ?? this.versionResolver?.(pluginId) ?? "unknown";
    const startTime = Date.now();

    const trace: PluginTrace = {
      traceId,
      pluginId,
      capability,
      version,
      startTime,
      status: "success",
      metadata: options?.metadata ?? {},
    };

    const controller = new AbortController();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const onAbort = (): void => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (options?.signal?.aborted) throw this.abortError(options.signal.reason);
      const execution = Promise.resolve().then(() => fn(controller.signal));
      let result: T;

      if (options?.timeoutMs && options.timeoutMs > 0) {
        const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
          timeoutTimer = setTimeout(() => {
            resolve({ kind: "timeout" });
          }, options.timeoutMs);
        });

        const outcome = await Promise.race([
          execution.then(
            (value) => ({ kind: "success" as const, value }),
            (error: unknown) => ({ kind: "error" as const, error }),
          ),
          timeoutPromise,
        ]);
        if (outcome.kind === "timeout") {
          timedOut = true;
          const timeoutErr = new Error(
            `Plugin "${pluginId}" execution timed out after ${options.timeoutMs}ms for capability "${capability}"`,
          );
          (timeoutErr as unknown as { isPluginTimeout: boolean }).isPluginTimeout = true;
          controller.abort(timeoutErr);
          // The host may report a timeout only after cooperative work has stopped.
          // This prevents a timed-out promise from continuing side effects after
          // its caller has already observed completion.
          await execution.catch(() => undefined);
          throw timeoutErr;
        }
        if (outcome.kind === "error") throw outcome.error;
        result = outcome.value;
      } else {
        result = await execution;
      }

      if (options?.signal?.aborted) throw this.abortError(options.signal.reason);
      if (timeoutTimer) clearTimeout(timeoutTimer);

      trace.endTime = Date.now();
      trace.durationMs = trace.endTime - trace.startTime;
      trace.status = "success";

      this.recordTrace(trace, options?.sessionId);
      return result;
    } catch (error) {
      if (timeoutTimer) clearTimeout(timeoutTimer);

      const err = error as Error & { isPluginTimeout?: boolean };
      const isTimeout = timedOut || err?.isPluginTimeout === true;
      const isCancelled = !isTimeout && (options?.signal?.aborted || controller.signal.aborted);

      trace.endTime = Date.now();
      trace.durationMs = trace.endTime - trace.startTime;
      trace.status = isTimeout ? "timeout" : isCancelled ? "cancelled" : "error";
      trace.error = err?.message ?? String(error);

      this.recordTrace(trace, options?.sessionId);
      throw error;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  private abortError(reason: unknown): Error {
    if (reason instanceof Error) return reason;
    const error = new Error("Plugin execution was cancelled.");
    error.name = "AbortError";
    return error;
  }

  private recordTrace(trace: PluginTrace, sessionId?: string): void {
    this.recentTraces.push(trace);
    if (this.recentTraces.length > this.maxTraces) {
      this.recentTraces.shift();
    }

    // Custom collector hook if registered
    if (this.collector) {
      try {
        this.collector(trace);
      } catch {
        // Suppress collector errors to maintain fail-safe harness
      }
    }

    // Mirror to unified HarnessObserver singleton
    if (isFeatureFlagEnabled("MODUS_OBSERVABILITY")) {
      try {
        HarnessObserver.getInstance().recordPluginTrace(
          {
            pluginId: trace.pluginId,
            capability: trace.capability,
            version: trace.version,
            durationMs: trace.durationMs,
            status: trace.status,
            error: trace.error,
            metadata: trace.metadata,
          },
          sessionId,
        );
      } catch {
        // Fail-open
      }
    }
  }

  public getRecentTraces(pluginId?: string, limit: number = 50): PluginTrace[] {
    const list = pluginId
      ? this.recentTraces.filter((t) => t.pluginId === pluginId)
      : this.recentTraces;
    return list.slice(-limit);
  }

  public clear(): void {
    this.recentTraces = [];
  }
}
