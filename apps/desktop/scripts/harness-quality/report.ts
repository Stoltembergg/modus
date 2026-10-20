import type { AgentEvent, AgentRunTokenUsage } from "../../src/shared/contracts";

type TerminalEvent = Extract<
  AgentEvent,
  { type: "run.completed" | "run.failed" | "run.cancelled" }
>;
type ObservedRun = {
  sessionId: string;
  runId: string;
  startedMs?: number;
  endedMs?: number;
  terminal?: TerminalEvent;
};
const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const zeroUsage = (): AgentRunTokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});

/** Consumes public runtime events; never estimates tokens from characters or elapsed time. */
export class QualityRunReporter {
  private runs = new Map<string, ObservedRun>();
  private successfulWaitIds = new Set<string>();
  private toolErrors = new Set<string>();

  observe(event: AgentEvent, observedMs: number): void {
    if (event.type === "tool.ended") {
      if (event.isError) this.toolErrors.add(`${event.sessionId}:${event.toolCallId}`);
      if (event.toolName === "wait" && !event.isError) {
        this.successfulWaitIds.add(`${event.sessionId}:${event.toolCallId}`);
      }
    }
    if (
      event.type !== "run.started" &&
      event.type !== "run.completed" &&
      event.type !== "run.failed" &&
      event.type !== "run.cancelled"
    )
      return;
    const key = `${event.sessionId}:${event.runId}`;
    const run = this.runs.get(key) ?? { sessionId: event.sessionId, runId: event.runId };
    if (event.type === "run.started") run.startedMs ??= observedMs;
    else if (!run.terminal) {
      run.terminal = event;
      run.endedMs = observedMs;
    }
    this.runs.set(key, run);
  }

  get successfulWaits(): number {
    return this.successfulWaitIds.size;
  }

  snapshot(parentSessionId: string, childSessionIds: readonly string[]) {
    const relevant = new Set([parentSessionId, ...childSessionIds]);
    const runs = [...this.runs.values()].filter((run) => relevant.has(run.sessionId));
    const summarize = (selected: ObservedRun[]) => {
      const reportedUsage = zeroUsage();
      const missingUsageRunIds: string[] = [];
      for (const run of selected) {
        const usage = run.terminal?.tokenUsage;
        if (
          !usage ||
          !FIELDS.every((field) => Number.isFinite(usage[field]) && usage[field] >= 0)
        ) {
          missingUsageRunIds.push(run.runId);
          continue;
        }
        for (const field of FIELDS) reportedUsage[field] += usage[field];
      }
      const usageComplete = selected.length > 0 && missingUsageRunIds.length === 0;
      return {
        runCount: selected.length,
        usageComplete,
        reportedUsage,
        totalUsage: usageComplete ? reportedUsage : null,
        missingUsageRunIds,
      };
    };
    return {
      parent: summarize(runs.filter((run) => run.sessionId === parentSessionId)),
      children: summarize(runs.filter((run) => run.sessionId !== parentSessionId)),
      combined: summarize(runs),
      successfulWaits: this.successfulWaits,
      toolErrorCount: this.toolErrors.size,
      runs: runs.map((run) => ({
        sessionId: run.sessionId,
        runId: run.runId,
        status: run.terminal?.type ?? "unsettled",
        elapsedMs:
          run.startedMs !== undefined && run.endedMs !== undefined
            ? Math.max(0, run.endedMs - run.startedMs)
            : null,
        responseModel: run.terminal?.responseModel ?? null,
        tokenUsage: run.terminal?.tokenUsage ?? null,
      })),
    };
  }
}
