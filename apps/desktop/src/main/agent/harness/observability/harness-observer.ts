import type {
  AlertRegression,
  CompactionMetrics,
  HarnessMetrics,
  PerformanceMetrics,
  PluginTracingMetrics,
  PromptSectionsMetrics,
  RepeatGuardsMetrics,
  ResponsePolicyMetrics,
  SessionHarnessMetrics,
  SystemHealthStatus,
  TelemetryEvent,
  TelemetryEventType,
  ToolResultsMetrics,
} from "./harness-metrics";

/**
 * HarnessObserver
 * Central singleton for real-time observability, event recording, and metrics aggregation
 * across all harness subsystems.
 */
export class HarnessObserver {
  private static instance: HarnessObserver | null = null;

  private startTime: number = Date.now();
  private telemetryOptIn: boolean = true;
  private maxStoredEvents: number = 1000;

  // Aggregate subsystem counters
  private promptTokensSaved = 0;
  private promptSkippedSections = 0;
  private promptTotalSectionsSent = 0;

  private spilledResults = 0;
  private totalRetrievalLatencyMs = 0;
  private retrievalCount = 0;
  private spilledBytes = 0;

  private compactionPrunedBytes = 0;
  private compactionEvents = 0;
  private compactionTokensSaved = 0;
  private actualCompactionCount = 0;

  private guardFalsePositives = 0;
  private guardBlockedLoops = 0;
  private guardCircuitBreakerTrips = 0;

  private responseCriticalSectionsOmitted = 0;
  private responseViolationsDetected = 0;
  private responseCharactersSaved = 0;
  private responseFormattedCount = 0;

  private hookDurationsMs: number[] = [];
  private initialMemoryUsageBytes = process.memoryUsage().heapUsed;

  // Plugin Tracing & Metrics (Fase 12)
  private pluginDurationsMs: number[] = [];
  private pluginExecutions = 0;
  private pluginFailures = 0;
  private activePlugins = new Set<string>();

  // Last mirrored ResponsePolicyRegistry totals, for delta computation.
  private lastMirroredResponseTotals = {
    violationsDetected: 0,
    totalFormatted: 0,
    charactersSaved: 0,
  };

  // Session-level tracking
  private sessionMetrics = new Map<string, SessionHarnessMetrics>();

  // Ring buffer for recent telemetry events
  private recentEvents: TelemetryEvent[] = [];

  private constructor() {}

  static getInstance(): HarnessObserver {
    if (!HarnessObserver.instance) {
      HarnessObserver.instance = new HarnessObserver();
    }
    return HarnessObserver.instance;
  }

  static resetInstance(): void {
    HarnessObserver.instance = null;
  }

  clear(): void {
    this.promptTokensSaved = 0;
    this.promptSkippedSections = 0;
    this.promptTotalSectionsSent = 0;
    this.spilledResults = 0;
    this.totalRetrievalLatencyMs = 0;
    this.retrievalCount = 0;
    this.spilledBytes = 0;
    this.compactionPrunedBytes = 0;
    this.compactionEvents = 0;
    this.compactionTokensSaved = 0;
    this.actualCompactionCount = 0;
    this.guardFalsePositives = 0;
    this.guardBlockedLoops = 0;
    this.guardCircuitBreakerTrips = 0;
    this.responseCriticalSectionsOmitted = 0;
    this.responseViolationsDetected = 0;
    this.responseCharactersSaved = 0;
    this.responseFormattedCount = 0;
    this.hookDurationsMs = [];
    this.pluginDurationsMs = [];
    this.pluginExecutions = 0;
    this.pluginFailures = 0;
    this.activePlugins.clear();
    this.sessionMetrics.clear();
    this.recentEvents = [];
  }

  setTelemetryOptIn(enabled: boolean): void {
    this.telemetryOptIn = enabled;
  }

  isTelemetryOptedIn(): boolean {
    return this.telemetryOptIn;
  }

  private emitEvent(
    type: TelemetryEventType,
    data: Record<string, any>,
    sessionId?: string,
    runId?: string,
  ): void {
    if (!this.telemetryOptIn) return;

    const event: TelemetryEvent = {
      type,
      timestamp: Date.now(),
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      data,
    };

    this.recentEvents.push(event);
    if (this.recentEvents.length > this.maxStoredEvents) {
      this.recentEvents.shift();
    }
  }

  private ensureSession(sessionId: string): SessionHarnessMetrics {
    let session = this.sessionMetrics.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        turnCount: 0,
        totalDurationMs: 0,
        tokensSaved: 0,
        spilledResults: 0,
        hookExecutions: 0,
        guardBlocks: 0,
        policyViolations: 0,
        lastActiveTimestamp: Date.now(),
      };
      this.sessionMetrics.set(sessionId, session);
    }
    session.lastActiveTimestamp = Date.now();
    return session;
  }

  // --- Hook Performance Tracking ---
  recordHookExecution(
    phase: string,
    hookName: string,
    durationMs: number,
    success: boolean,
    error?: string,
    sessionId?: string,
  ): void {
    this.hookDurationsMs.push(durationMs);
    if (this.hookDurationsMs.length > 5000) {
      this.hookDurationsMs.shift();
    }

    if (sessionId) {
      const session = this.ensureSession(sessionId);
      session.hookExecutions++;
    }

    this.emitEvent(
      "harness.hook.executed",
      { phase, hookName, durationMs, success, error },
      sessionId,
    );
  }

  // --- Tool Result Spill Tracking ---
  recordToolResultSpill(
    toolName: string,
    bytes: number,
    spillId?: string,
    sessionId?: string,
  ): void {
    this.spilledResults++;
    this.spilledBytes += bytes;

    if (sessionId) {
      const session = this.ensureSession(sessionId);
      session.spilledResults++;
      // Rough token estimate: ~4 bytes per token
      session.tokensSaved += Math.floor(bytes / 4);
    }

    this.emitEvent("harness.tool.spilled", { toolName, bytes, spillId }, sessionId);
  }

  recordToolResultRetrieval(durationMs: number, sessionId?: string): void {
    this.totalRetrievalLatencyMs += durationMs;
    this.retrievalCount++;
    this.emitEvent("harness.tool.retrieved", { durationMs }, sessionId);
  }

  // --- Compaction Pruning Tracking ---
  recordCompactionPruning(prunedBytes: number, savedTokens: number, sessionId?: string): void {
    this.compactionEvents++;
    this.compactionPrunedBytes += prunedBytes;
    this.compactionTokensSaved += savedTokens;

    if (sessionId) {
      const session = this.ensureSession(sessionId);
      session.tokensSaved += savedTokens;
    }

    this.emitEvent("harness.compaction.pruned", { prunedBytes, savedTokens }, sessionId);
  }

  /**
   * Records a real (non-pruned) compaction run. Tracked separately from
   * pruning events so the avoidance ratio in snapshot() can actually vary
   * instead of being a constant.
   */
  recordActualCompaction(sessionId?: string): void {
    this.actualCompactionCount++;

    if (sessionId) {
      this.ensureSession(sessionId);
    }
  }

  // --- Prompt Sections Tracking ---
  recordPromptSections(
    sent: string[],
    skipped: string[],
    tokensSaved: number,
    sessionId?: string,
  ): void {
    this.promptTotalSectionsSent += sent.length;
    this.promptSkippedSections += skipped.length;
    this.promptTokensSaved += tokensSaved;

    if (sessionId) {
      const session = this.ensureSession(sessionId);
      session.tokensSaved += tokensSaved;
    }

    this.emitEvent(
      "harness.prompt.compiled",
      { sentCount: sent.length, skippedCount: skipped.length, tokensSaved },
      sessionId,
    );
  }

  // --- Repeat Guards Tracking ---
  recordRepeatGuardTrigger(
    toolName: string,
    guardType: string,
    isFalsePositive: boolean = false,
    sessionId?: string,
  ): void {
    this.guardBlockedLoops++;
    if (guardType === "circuit_breaker") {
      this.guardCircuitBreakerTrips++;
    }
    if (isFalsePositive) {
      this.guardFalsePositives++;
    }

    if (sessionId) {
      const session = this.ensureSession(sessionId);
      session.guardBlocks++;
    }

    this.emitEvent("harness.guard.tripped", { toolName, guardType, isFalsePositive }, sessionId);
  }

  // --- Response Policy Tracking ---
  recordResponsePolicyEvaluation(
    violation: boolean,
    formatted: boolean,
    charsSaved: number,
    criticalOmitted: number = 0,
    sessionId?: string,
  ): void {
    if (violation) this.responseViolationsDetected++;
    if (formatted) this.responseFormattedCount++;
    this.responseCharactersSaved += charsSaved;
    this.responseCriticalSectionsOmitted += criticalOmitted;

    if (sessionId) {
      const session = this.ensureSession(sessionId);
      if (violation) session.policyViolations++;
      // Rough token estimate: ~4 chars per token
      session.tokensSaved += Math.floor(charsSaved / 4);
    }

    this.emitEvent(
      "harness.response.formatted",
      { violation, formatted, charsSaved, criticalOmitted },
      sessionId,
    );
  }

  /**
   * Mirrors cumulative ResponsePolicyRegistry totals into the observer.
   * Delta-based: only evaluations recorded since the last mirror call are
   * added, and a registry reset simply re-baselines without double counting.
   * criticalOmitted stays 0 here — the formatter never omits critical
   * paragraphs by construction (Phase 7 invariant) and the registry tracks
   * no omission counter.
   */
  mirrorResponsePolicyMetrics(
    totals: { violationsDetected: number; totalFormatted: number; charactersSaved: number },
    sessionId?: string,
  ): void {
    const fresh = {
      violationsDetected: Math.max(0, totals.violationsDetected),
      totalFormatted: Math.max(0, totals.totalFormatted),
      charactersSaved: Math.max(0, totals.charactersSaved),
    };
    const added = {
      violationsDetected: Math.max(
        0,
        fresh.violationsDetected - this.lastMirroredResponseTotals.violationsDetected,
      ),
      totalFormatted: Math.max(
        0,
        fresh.totalFormatted - this.lastMirroredResponseTotals.totalFormatted,
      ),
      charactersSaved: Math.max(
        0,
        fresh.charactersSaved - this.lastMirroredResponseTotals.charactersSaved,
      ),
    };
    this.lastMirroredResponseTotals = fresh;

    if (
      added.violationsDetected === 0 &&
      added.totalFormatted === 0 &&
      added.charactersSaved === 0
    ) {
      return;
    }

    this.responseViolationsDetected += added.violationsDetected;
    this.responseFormattedCount += added.totalFormatted;
    this.responseCharactersSaved += added.charactersSaved;

    if (sessionId) {
      const session = this.ensureSession(sessionId);
      session.policyViolations += added.violationsDetected;
      // Rough token estimate: ~4 chars per token
      session.tokensSaved += Math.floor(added.charactersSaved / 4);
    }

    this.emitEvent(
      "harness.response.formatted",
      {
        violation: added.violationsDetected > 0,
        formatted: added.totalFormatted > 0,
        charsSaved: added.charactersSaved,
        criticalOmitted: 0,
        mirrored: true,
      },
      sessionId,
    );
  }

  // --- Plugin Tracing (Fase 12) ---
  recordPluginTrace(
    trace: {
      pluginId: string;
      capability: string;
      version: string;
      durationMs?: number | undefined;
      status: "success" | "error" | "timeout";
      error?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
    },
    sessionId?: string,
  ): void {
    this.pluginExecutions++;
    this.activePlugins.add(trace.pluginId);

    const duration = trace.durationMs ?? 0;
    this.pluginDurationsMs.push(duration);
    if (this.pluginDurationsMs.length > 5000) {
      this.pluginDurationsMs.shift();
    }

    const isFailure = trace.status !== "success";
    if (isFailure) {
      this.pluginFailures++;
    }

    const eventType = isFailure ? "harness.plugin.failed" : "harness.plugin.executed";
    this.emitEvent(
      eventType,
      {
        pluginId: trace.pluginId,
        capability: trace.capability,
        version: trace.version,
        durationMs: duration,
        status: trace.status,
        error: trace.error,
        metadata: trace.metadata,
      },
      sessionId,
    );
  }

  // --- Session Turn Tracking ---
  recordSessionTurn(sessionId: string, durationMs: number): void {
    const session = this.ensureSession(sessionId);
    session.turnCount++;
    session.totalDurationMs += durationMs;
  }

  getSessionMetrics(sessionId: string): SessionHarnessMetrics | undefined {
    return this.sessionMetrics.get(sessionId);
  }

  getAllSessions(): SessionHarnessMetrics[] {
    return Array.from(this.sessionMetrics.values());
  }

  getRecentEvents(limit: number = 50): TelemetryEvent[] {
    return this.recentEvents.slice(-limit);
  }

  /**
   * Generates a snapshot of unified HarnessMetrics matching the contract in REVISAO-SUMARIO.md
   */
  snapshot(): HarnessMetrics {
    const promptSections: PromptSectionsMetrics = {
      tokensSaved: this.promptTokensSaved,
      skippedSections: this.promptSkippedSections,
      totalSectionsSent: this.promptTotalSectionsSent,
    };

    const toolResults: ToolResultsMetrics = {
      spilledResults: this.spilledResults,
      retrievalLatency:
        this.retrievalCount > 0 ? this.totalRetrievalLatencyMs / this.retrievalCount : 0,
      spilledBytes: this.spilledBytes,
    };

    // Share of compaction demand absorbed by pruning (avoids a full compaction).
    const totalCompactionDemand = this.compactionEvents + this.actualCompactionCount;
    const reductionPercent =
      totalCompactionDemand === 0
        ? 0
        : Math.round((this.compactionEvents / totalCompactionDemand) * 100);

    const compaction: CompactionMetrics = {
      frequencyReductionPercent: reductionPercent,
      totalPrunedBytes: this.compactionPrunedBytes,
      compactionEvents: this.compactionEvents,
      tokensSavedByPruning: this.compactionTokensSaved,
    };

    const repeatGuards: RepeatGuardsMetrics = {
      falsePositiveCount: this.guardFalsePositives,
      blockedLoopCount: this.guardBlockedLoops,
      circuitBreakerTrips: this.guardCircuitBreakerTrips,
    };

    const response: ResponsePolicyMetrics = {
      criticalSectionsOmitted: this.responseCriticalSectionsOmitted,
      violationsDetected: this.responseViolationsDetected,
      charactersSaved: this.responseCharactersSaved,
      formattedCount: this.responseFormattedCount,
    };

    // Performance calculations
    const totalHookExecutions = this.hookDurationsMs.length;
    const totalHookDuration = this.hookDurationsMs.reduce((acc, v) => acc + v, 0);
    const averageHookDurationMs =
      totalHookExecutions > 0 ? totalHookDuration / totalHookExecutions : 0;

    const sortedDurations = [...this.hookDurationsMs].sort((a, b) => a - b);
    const p95Index = Math.floor(sortedDurations.length * 0.95);
    const p95HookDurationMs = sortedDurations[p95Index] ?? averageHookDurationMs;

    const currentMemory = process.memoryUsage().heapUsed;
    const memoryGrowth =
      this.initialMemoryUsageBytes > 0
        ? Math.round(
            ((currentMemory - this.initialMemoryUsageBytes) / this.initialMemoryUsageBytes) * 100,
          )
        : 0;

    const performance: PerformanceMetrics = {
      hookSystemOverheadMs: totalHookDuration,
      memoryGrowthPercent: memoryGrowth,
      totalHookExecutions,
      averageHookDurationMs: Math.round(averageHookDurationMs * 100) / 100,
      p95HookDurationMs: Math.round(p95HookDurationMs * 100) / 100,
    };

    // Plugin Tracing calculations (Fase 12)
    const totalPluginExec = this.pluginExecutions;
    const totalPluginDur = this.pluginDurationsMs.reduce((acc, v) => acc + v, 0);
    const avgPluginDur = totalPluginExec > 0 ? totalPluginDur / totalPluginExec : 0;
    const sortedPluginDurations = [...this.pluginDurationsMs].sort((a, b) => a - b);
    const p95PluginIdx = Math.floor(sortedPluginDurations.length * 0.95);
    const p95PluginDur = sortedPluginDurations[p95PluginIdx] ?? avgPluginDur;

    const plugins: PluginTracingMetrics = {
      totalExecutions: totalPluginExec,
      failureCount: this.pluginFailures,
      totalDurationMs: totalPluginDur,
      avgDurationMs: Math.round(avgPluginDur * 100) / 100,
      p95DurationMs: Math.round(p95PluginDur * 100) / 100,
      activePluginCount: this.activePlugins.size,
    };

    return {
      promptSections,
      toolResults,
      compaction,
      repeatGuards,
      response,
      performance,
      plugins,
    };
  }

  /**
   * Evaluates system health and detects any threshold regressions.
   */
  getHealthStatus(): SystemHealthStatus {
    const snap = this.snapshot();
    const alerts: AlertRegression[] = [];

    // Critical: Evidence Loss / Critical sections dropped (RISCO 4)
    if (snap.response.criticalSectionsOmitted > 0) {
      alerts.push({
        metric: "response.criticalSectionsOmitted",
        severity: "critical",
        expected: 0,
        actual: snap.response.criticalSectionsOmitted,
        message: "Critical sections (errors, blockers, warnings) were omitted by response policy!",
        timestamp: Date.now(),
      });
    }

    // Warning: High hook latency (SLO < 100ms)
    if (snap.performance.p95HookDurationMs > 100) {
      alerts.push({
        metric: "performance.p95HookDurationMs",
        severity: "warning",
        expected: "< 100ms",
        actual: `${snap.performance.p95HookDurationMs}ms`,
        message: "Hook execution P95 latency exceeded the 100ms SLO threshold.",
        timestamp: Date.now(),
      });
    }

    // Warning: Memory growth > 50%
    if (snap.performance.memoryGrowthPercent > 50) {
      alerts.push({
        metric: "performance.memoryGrowthPercent",
        severity: "warning",
        expected: "< 50%",
        actual: `${snap.performance.memoryGrowthPercent}%`,
        message: "Harness heap memory growth exceeded 50% threshold.",
        timestamp: Date.now(),
      });
    }

    const hasCritical = alerts.some((a) => a.severity === "critical");
    const hasWarning = alerts.some((a) => a.severity === "warning");

    const status = hasCritical ? "critical" : hasWarning ? "degraded" : "healthy";
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    return {
      status,
      alerts,
      uptimeSeconds,
      timestamp: Date.now(),
    };
  }
}
