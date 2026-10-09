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
  TurnMetrics,
  TurnOutcome,
  ToolResultsMetrics,
} from "./harness-metrics";

function emptyOutcomeCounts(): Record<TurnOutcome, number> {
  return { completed: 0, failed: 0, blocked: 0, cancelled: 0, interrupted: 0 };
}

function emptyTurnMetrics(): TurnMetrics {
  return {
    total: 0,
    totalDurationMs: 0,
    durationReports: 0,
    durationMsByOutcome: emptyOutcomeCounts(),
    durationReportsByOutcome: emptyOutcomeCounts(),
    noResponseDurationMs: 0,
    noResponseDurationReports: 0,
    ...emptyOutcomeCounts(),
    noResponse: 0,
    providerUsageReports: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    providerCacheReadTokens: 0,
    providerCacheWriteTokens: 0,
    providerTotalTokens: 0,
  };
}

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
  private promptEstimatedTokensSaved = 0;
  private hasPromptTokenEstimate = false;
  private promptSkippedSections = 0;
  private promptTotalSectionsSent = 0;

  private spilledResults = 0;
  private totalRetrievalLatencyMs = 0;
  private retrievalCount = 0;
  private spilledBytes = 0;
  private modelContextBytesReduced = 0;
  private spillEstimatedTokensSaved = 0;

  private compactionPrunedBytes = 0;
  private compactionTokensSaved = 0;
  private compactionPruningEvents = 0;
  private nativeCompactionsObserved = 0;

  private guardBlockedLoops = 0;
  private guardEvaluatedToolCalls = 0;

  private responseEvaluatedCount = 0;
  private responseViolationsDetected = 0;
  private turns: TurnMetrics = emptyTurnMetrics();

  private hookDurationsMs: number[] = [];
  private initialMemoryUsageBytes = process.memoryUsage().heapUsed;

  // Plugin Tracing & Metrics (Fase 12)
  private pluginDurationsMs: number[] = [];
  private pluginExecutions = 0;
  private pluginFailures = 0;
  private activePlugins = new Set<string>();

  // Session-level tracking
  private sessionMetrics = new Map<string, SessionHarnessMetrics>();
  private sessionLifetimes = new Map<string, symbol>();

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

  /** Starts a fresh temporary metrics lifetime for a runtime session. */
  beginSession(sessionId: string): symbol {
    this.releaseSession(sessionId);
    const token = Symbol(`harness-session:${sessionId}`);
    this.sessionLifetimes.set(sessionId, token);
    return token;
  }

  /**
   * Releases only the matching session lifetime. Supplying its token prevents
   * a late disposer from clearing metrics belonging to a recreated session.
   */
  releaseSession(sessionId: string, token?: symbol): void {
    if (token !== undefined && this.sessionLifetimes.get(sessionId) !== token) return;
    this.sessionLifetimes.delete(sessionId);
    this.sessionMetrics.delete(sessionId);
    this.recentEvents = this.recentEvents.filter((event) => event.sessionId !== sessionId);
  }

  isSessionCurrent(sessionId: string, token: symbol): boolean {
    return this.sessionLifetimes.get(sessionId) === token;
  }

  getSessionToken(sessionId: string): symbol | undefined {
    return this.sessionLifetimes.get(sessionId);
  }

  clear(): void {
    this.promptEstimatedTokensSaved = 0;
    this.hasPromptTokenEstimate = false;
    this.promptSkippedSections = 0;
    this.promptTotalSectionsSent = 0;
    this.spilledResults = 0;
    this.totalRetrievalLatencyMs = 0;
    this.retrievalCount = 0;
    this.spilledBytes = 0;
    this.modelContextBytesReduced = 0;
    this.spillEstimatedTokensSaved = 0;
    this.compactionPrunedBytes = 0;
    this.compactionTokensSaved = 0;
    this.compactionPruningEvents = 0;
    this.nativeCompactionsObserved = 0;
    this.guardBlockedLoops = 0;
    this.guardEvaluatedToolCalls = 0;
    this.responseEvaluatedCount = 0;
    this.responseViolationsDetected = 0;
    this.turns = emptyTurnMetrics();
    this.hookDurationsMs = [];
    this.pluginDurationsMs = [];
    this.pluginExecutions = 0;
    this.pluginFailures = 0;
    this.activePlugins.clear();
    this.sessionMetrics.clear();
    this.sessionLifetimes.clear();
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
        durationReports: 0,
        durationMsByOutcome: emptyOutcomeCounts(),
        durationReportsByOutcome: emptyOutcomeCounts(),
        noResponseDurationMs: 0,
        noResponseDurationReports: 0,
        estimatedTokensSaved: 0,
        spilledResults: 0,
        hookExecutions: 0,
        guardBlocks: 0,
        policyEvaluations: 0,
        policyViolations: 0,
        outcomes: emptyOutcomeCounts(),
        noResponseCount: 0,
        providerReportedTotalTokens: 0,
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
    sessionToken?: symbol,
    runId?: string,
  ): void {
    if (sessionId && (!sessionToken || !this.isSessionCurrent(sessionId, sessionToken))) return;
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const measuredDurationMs = durationMs;
    this.hookDurationsMs.push(measuredDurationMs);
    if (this.hookDurationsMs.length > 5000) {
      this.hookDurationsMs.shift();
    }

    if (sessionId && sessionToken) {
      const session = this.ensureSession(sessionId);
      session.hookExecutions++;
    }

    this.emitEvent(
      "harness.hook.executed",
      { phase, hookName, durationMs: measuredDurationMs, success, error },
      sessionId,
      runId,
    );
  }

  // --- Tool Result Spill Tracking ---
  recordToolResultSpill(
    toolName: string,
    modelContextBytesReduced: number,
    storedBytes: number,
    spillId?: string,
    sessionId?: string,
    sessionToken?: symbol,
    runId?: string,
  ): void {
    if (sessionId && (!sessionToken || !this.isSessionCurrent(sessionId, sessionToken))) return;
    if (
      !Number.isFinite(modelContextBytesReduced) ||
      modelContextBytesReduced < 0 ||
      !Number.isFinite(storedBytes) ||
      storedBytes < 0
    ) {
      return;
    }
    this.spilledResults++;
    this.spilledBytes += storedBytes;
    this.modelContextBytesReduced += modelContextBytesReduced;
    const estimatedTokensSaved = Math.floor(modelContextBytesReduced / 4);
    this.spillEstimatedTokensSaved += estimatedTokensSaved;

    if (sessionId) {
      const session = this.ensureSession(sessionId);
      session.spilledResults++;
      session.estimatedTokensSaved += estimatedTokensSaved;
    }

    this.emitEvent(
      "harness.tool.spilled",
      { toolName, modelContextBytesReduced, storedBytes, estimatedTokensSaved, spillId },
      sessionId,
      runId,
    );
  }

  recordToolResultRetrieval(
    durationMs: number,
    sessionId?: string,
    sessionToken?: symbol,
    runId?: string,
  ): void {
    if (sessionId && (!sessionToken || !this.isSessionCurrent(sessionId, sessionToken))) return;
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.totalRetrievalLatencyMs += durationMs;
    this.retrievalCount++;
    this.emitEvent("harness.tool.retrieved", { durationMs }, sessionId, runId);
  }

  // --- Compaction Pruning Tracking ---
  recordCompactionPruning(
    measuredContextBytesRemoved: number,
    estimatedTokensSaved: number,
    sessionId?: string,
    sessionToken?: symbol,
    runId?: string,
  ): void {
    if (sessionId && (!sessionToken || !this.isSessionCurrent(sessionId, sessionToken))) return;
    if (
      !Number.isFinite(measuredContextBytesRemoved) ||
      measuredContextBytesRemoved < 0 ||
      !Number.isFinite(estimatedTokensSaved) ||
      estimatedTokensSaved < 0
    ) {
      return;
    }
    this.compactionPruningEvents++;
    this.compactionPrunedBytes += measuredContextBytesRemoved;
    this.compactionTokensSaved += estimatedTokensSaved;

    if (sessionId) {
      const session = this.ensureSession(sessionId);
      session.estimatedTokensSaved += estimatedTokensSaved;
    }

    this.emitEvent(
      "harness.compaction.pruned",
      { measuredContextBytesRemoved, estimatedTokensSaved },
      sessionId,
      runId,
    );
  }

  recordNativeCompaction(sessionId: string, sessionToken: symbol, runId: string): void {
    if (!this.isSessionCurrent(sessionId, sessionToken)) return;
    this.nativeCompactionsObserved++;
    this.emitEvent("harness.compaction.native", {}, sessionId, runId);
  }

  // --- Prompt Sections Tracking ---
  recordPromptSections(
    sent: string[],
    skipped: string[],
    estimatedTokensSaved: number | undefined,
    sessionId?: string,
    sessionToken?: symbol,
    runId?: string,
  ): void {
    if (sessionId && (!sessionToken || !this.isSessionCurrent(sessionId, sessionToken))) return;
    this.promptTotalSectionsSent += sent.length;
    this.promptSkippedSections += skipped.length;
    if (estimatedTokensSaved !== undefined && Number.isFinite(estimatedTokensSaved)) {
      this.promptEstimatedTokensSaved += estimatedTokensSaved;
      this.hasPromptTokenEstimate = true;
    }

    if (sessionId) {
      const session = this.ensureSession(sessionId);
      if (estimatedTokensSaved !== undefined && Number.isFinite(estimatedTokensSaved)) {
        session.estimatedTokensSaved += estimatedTokensSaved;
      }
    }

    this.emitEvent(
      "harness.prompt.compiled",
      {
        sentSectionIds: sent,
        skippedSectionIds: skipped,
        estimatedTokensSaved: estimatedTokensSaved ?? null,
      },
      sessionId,
      runId,
    );
  }

  // --- Repeat Guards Tracking ---
  recordRepeatGuardEvaluation(
    toolName: string,
    blocked: boolean,
    sessionId: string,
    sessionToken: symbol,
    runId: string,
  ): void {
    if (!this.isSessionCurrent(sessionId, sessionToken)) return;
    this.guardEvaluatedToolCalls++;
    if (blocked) this.guardBlockedLoops++;

    const session = this.ensureSession(sessionId);
    if (blocked) session.guardBlocks++;

    this.emitEvent("harness.guard.evaluated", { toolName, blocked }, sessionId, runId);
  }

  // --- Response Policy Tracking ---
  recordResponsePolicyEvaluation(
    violation: boolean,
    sessionId: string,
    sessionToken: symbol,
    runId: string,
  ): void {
    if (!this.isSessionCurrent(sessionId, sessionToken)) return;
    this.responseEvaluatedCount++;
    if (violation) this.responseViolationsDetected++;

    const session = this.ensureSession(sessionId);
    session.policyEvaluations++;
    if (violation) session.policyViolations++;

    this.emitEvent(
      "harness.response.evaluated",
      { outcome: "completed", violation },
      sessionId,
      runId,
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
  recordSessionTurn(input: {
    sessionId: string;
    durationMs: number;
    sessionToken: symbol;
    runId: string;
    outcome: TurnOutcome;
    hasAssistantResponse: boolean;
    providerTokenUsage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    };
  }): void {
    if (!this.isSessionCurrent(input.sessionId, input.sessionToken)) return;
    const hasDuration = Number.isFinite(input.durationMs) && input.durationMs >= 0;
    const durationMs = hasDuration ? input.durationMs : null;
    const session = this.ensureSession(input.sessionId);
    session.turnCount++;
    session.outcomes[input.outcome]++;
    this.turns.total++;
    this.turns[input.outcome]++;
    if (hasDuration) {
      session.totalDurationMs += input.durationMs;
      session.durationReports++;
      session.durationMsByOutcome[input.outcome] += input.durationMs;
      session.durationReportsByOutcome[input.outcome]++;
      this.turns.totalDurationMs += input.durationMs;
      this.turns.durationReports++;
      this.turns.durationMsByOutcome[input.outcome] += input.durationMs;
      this.turns.durationReportsByOutcome[input.outcome]++;
    }
    if (!input.hasAssistantResponse) {
      session.noResponseCount++;
      this.turns.noResponse++;
      if (hasDuration) {
        session.noResponseDurationMs += input.durationMs;
        session.noResponseDurationReports++;
        this.turns.noResponseDurationMs += input.durationMs;
        this.turns.noResponseDurationReports++;
      }
    }

    if (input.providerTokenUsage) {
      const usage = input.providerTokenUsage;
      this.turns.providerUsageReports++;
      this.turns.providerInputTokens += usage.input;
      this.turns.providerOutputTokens += usage.output;
      this.turns.providerCacheReadTokens += usage.cacheRead;
      this.turns.providerCacheWriteTokens += usage.cacheWrite;
      this.turns.providerTotalTokens += usage.totalTokens;
      session.providerReportedTotalTokens += usage.totalTokens;
    }

    this.emitEvent(
      "harness.turn.settled",
      {
        durationMs,
        outcome: input.outcome,
        hasAssistantResponse: input.hasAssistantResponse,
        ...(input.providerTokenUsage
          ? { providerReportedTokenUsage: input.providerTokenUsage }
          : {}),
      },
      input.sessionId,
      input.runId,
    );
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
      estimatedTokensSaved: this.hasPromptTokenEstimate ? this.promptEstimatedTokensSaved : null,
      skippedSections: this.promptSkippedSections,
      totalSectionsSent: this.promptTotalSectionsSent,
    };

    const toolResults: ToolResultsMetrics = {
      spilledResults: this.spilledResults,
      successfulRetrievals: this.retrievalCount,
      retrievalLatency:
        this.retrievalCount > 0 ? this.totalRetrievalLatencyMs / this.retrievalCount : null,
      spilledBytes: this.spilledBytes,
      modelContextBytesReduced: this.modelContextBytesReduced,
      estimatedTokensSaved: this.spillEstimatedTokensSaved,
    };

    const compaction: CompactionMetrics = {
      // Pi's native compaction demand is not exposed at the context hook where
      // pruning runs. Pruning and compaction counts alone cannot prove avoidance.
      frequencyReductionPercent: null,
      totalPrunedBytes: this.compactionPrunedBytes,
      pruningEvents: this.compactionPruningEvents,
      nativeCompactionsObserved: this.nativeCompactionsObserved,
      estimatedTokensSavedByPruning: this.compactionTokensSaved,
    };

    const repeatGuards: RepeatGuardsMetrics = {
      falsePositiveCount: null,
      blockedLoopCount: this.guardBlockedLoops,
      evaluatedToolCalls: this.guardEvaluatedToolCalls,
      circuitBreakerTrips: null,
    };

    const response: ResponsePolicyMetrics = {
      evaluatedCount: this.responseEvaluatedCount,
      violationsDetected: this.responseViolationsDetected,
    };

    // Performance calculations
    const sampledHookExecutionCount = this.hookDurationsMs.length;
    const sampledHookDurationTotalMs = this.hookDurationsMs.reduce((acc, v) => acc + v, 0);
    const averageHookDurationMs =
      sampledHookExecutionCount > 0 ? sampledHookDurationTotalMs / sampledHookExecutionCount : 0;

    const sortedDurations = [...this.hookDurationsMs].sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1);
    const p95HookDurationMs = sortedDurations[p95Index] ?? averageHookDurationMs;

    const currentMemory = process.memoryUsage().heapUsed;
    const memoryGrowth =
      this.initialMemoryUsageBytes > 0
        ? Math.round(
            ((currentMemory - this.initialMemoryUsageBytes) / this.initialMemoryUsageBytes) * 100,
          )
        : 0;

    const performance: PerformanceMetrics = {
      sampledHookDurationTotalMs:
        sampledHookExecutionCount > 0 ? sampledHookDurationTotalMs : null,
      memoryGrowthPercent: memoryGrowth,
      sampledHookExecutionCount,
      averageHookDurationMs:
        sampledHookExecutionCount > 0 ? Math.round(averageHookDurationMs * 100) / 100 : null,
      p95HookDurationMs:
        sampledHookExecutionCount > 0 ? Math.round(p95HookDurationMs * 100) / 100 : null,
    };

    // Plugin Tracing calculations (Fase 12)
    const totalPluginExec = this.pluginExecutions;
    const totalPluginDur = this.pluginDurationsMs.reduce((acc, v) => acc + v, 0);
    const avgPluginDur = totalPluginExec > 0 ? totalPluginDur / totalPluginExec : 0;
    const sortedPluginDurations = [...this.pluginDurationsMs].sort((a, b) => a - b);
    const p95PluginIdx = Math.max(0, Math.ceil(sortedPluginDurations.length * 0.95) - 1);
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
      turns: { ...this.turns },
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

    // Warning: High hook latency (SLO < 100ms)
    if (snap.performance.p95HookDurationMs !== null && snap.performance.p95HookDurationMs > 100) {
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
