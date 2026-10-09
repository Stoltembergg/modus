import { createHash } from "node:crypto";
import type { FailureLoopAction } from "./failure-loop-guard";
import { getRepeatGuardConfig, type RepeatGuardConfig } from "./repeat-guard-config";

export type ToolInvocation = {
  sessionId?: string | undefined;
  runId?: string | undefined;
  toolName: string;
  argsFingerprint: string;
  timestamp: number;
  toolCallId?: string | undefined;
  outcome?: "success" | "failed" | "cancelled" | undefined;
  resultFingerprint?: string | undefined;
  progressFingerprint?: string | undefined;
};

export type RepeatGuardDecision = {
  action: "allow" | "block";
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  reasonCode?: string | undefined;
  reason?: string | undefined;
  pattern?: RepeatPattern | undefined;
  failureLoopAction?: FailureLoopAction | undefined;
};

export type RepeatPattern = {
  toolName: string;
  count: number;
  windowMs: number;
  identical: boolean;
  argsFingerprint?: string | undefined;
  reasons: string[];
};

/**
 * Creates a stable deterministic hash fingerprint for tool arguments.
 */
export function fingerprintToolArgs(args: unknown): string {
  if (args === undefined || args === null) {
    return "empty";
  }
  try {
    const serialized = stableSerialize(args, new WeakSet());
    return createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 16);
  } catch {
    return createHash("sha256").update(String(args), "utf8").digest("hex").slice(0, 16);
  }
}

function stableSerialize(value: unknown, seen: WeakSet<object>): string {
  if (value === undefined) return '"$undefined"';
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify({ $bigint: value.toString() });
    if (typeof value === "number" && !Number.isFinite(value)) {
      return JSON.stringify({ $number: String(value) });
    }
    return JSON.stringify(value) ?? String(value);
  }
  if (seen.has(value)) return '"$circular"';
  seen.add(value);
  if (Array.isArray(value)) {
    const serialized = `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }
  const serialized = `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key], seen)}`,
    )
    .join(",")}}`;
  seen.delete(value);
  return serialized;
}

/**
 * Detects repeating tool invocation patterns within a sliding time window.
 * Filters out whitelisted tools to maintain < 5% false positive rate (RISCO 3).
 */
export function detectRepeatTools(
  invocations: readonly ToolInvocation[],
  configOverrides?: Partial<RepeatGuardConfig>,
  now: number = Date.now(),
): RepeatPattern[] {
  const config = { ...getRepeatGuardConfig(), ...configOverrides };
  const windowMs = config.toolRepeatWindowMs;
  const threshold = config.toolRepeatThreshold;
  const whitelist = new Set(config.whitelistedTools);

  const recent = invocations.filter((inv) => now - inv.timestamp <= windowMs);
  if (recent.length < threshold) {
    return [];
  }

  const byTool = new Map<string, ToolInvocation[]>();
  for (const inv of recent) {
    const list = byTool.get(inv.toolName) ?? [];
    list.push(inv);
    byTool.set(inv.toolName, list);
  }

  const patterns: RepeatPattern[] = [];

  for (const [toolName, invs] of byTool) {
    if (invs.length < threshold) {
      continue;
    }

    const fingerprints = new Map<string, number>();
    for (const inv of invs) {
      const count = fingerprints.get(inv.argsFingerprint) ?? 0;
      fingerprints.set(inv.argsFingerprint, count + 1);
    }

    // Check if there is an identical fingerprint repeating >= threshold times
    let maxIdenticalCount = 0;
    let repeatingFingerprint: string | undefined;

    for (const [fp, count] of fingerprints) {
      if (count > maxIdenticalCount) {
        maxIdenticalCount = count;
        repeatingFingerprint = fp;
      }
    }

    const isIdentical = maxIdenticalCount >= threshold;

    // Check whitelist exemptions:
    // Whitelisted tools (e.g. view_file) are allowed unless identical repetition exceeds 2x threshold
    if (whitelist.has(toolName)) {
      if (!isIdentical || maxIdenticalCount < threshold * 2) {
        continue;
      }
    }

    if (isIdentical) {
      patterns.push({
        toolName,
        count: maxIdenticalCount,
        windowMs,
        identical: true,
        ...(repeatingFingerprint ? { argsFingerprint: repeatingFingerprint } : {}),
        reasons: [
          `identical_tool_call_loop:${toolName}`,
          `called_${maxIdenticalCount}_times_in_${Math.round(windowMs / 1000)}s`,
        ],
      });
    } else if (invs.length >= threshold + 2 && !whitelist.has(toolName)) {
      // High volume of different calls to the same state-mutating tool (e.g. repeated terminal or edit trials)
      patterns.push({
        toolName,
        count: invs.length,
        windowMs,
        identical: false,
        reasons: [
          `high_frequency_tool_churn:${toolName}`,
          `called_${invs.length}_times_in_${Math.round(windowMs / 1000)}s`,
        ],
      });
    }
  }

  return patterns;
}

/**
 * Returns a repeat pattern only when the immediately preceding calls show no
 * result or task-state progress. Incomplete/cancelled records fail open.
 */
export function detectUnproductiveToolRepeat(
  invocations: readonly ToolInvocation[],
  toolName: string,
  args: unknown,
  configOverrides?: Partial<RepeatGuardConfig>,
  now: number = Date.now(),
): RepeatPattern | undefined {
  const config = { ...getRepeatGuardConfig(), ...configOverrides };
  const argsFingerprint = fingerprintToolArgs(args);
  const recent = invocations.filter(
    (invocation) =>
      invocation.outcome !== "cancelled" && now - invocation.timestamp <= config.toolRepeatWindowMs,
  );
  const streak: ToolInvocation[] = [];
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const invocation = recent[index];
    if (invocation?.toolName !== toolName || invocation.argsFingerprint !== argsFingerprint) {
      break;
    }
    streak.push(invocation);
  }
  if (streak.length < config.toolRepeatThreshold) return undefined;

  const whitelist = new Set(config.whitelistedTools);
  const threshold = config.toolRepeatThreshold * (whitelist.has(toolName) ? 2 : 1);
  if (streak.length < threshold) return undefined;

  const evidence = streak.slice(0, config.toolRepeatThreshold);
  const repeatedFailures = evidence.every((invocation) => invocation.outcome === "failed");
  const resultFingerprints = new Set(evidence.map((invocation) => invocation.resultFingerprint));
  const progressFingerprints = new Set(
    evidence.map((invocation) => invocation.progressFingerprint),
  );
  const sameObservableResult =
    evidence.every((invocation) => invocation.resultFingerprint !== undefined) &&
    resultFingerprints.size === 1;
  const sameTaskProgress =
    evidence.every((invocation) => invocation.progressFingerprint !== undefined) &&
    progressFingerprints.size === 1;
  if (!sameTaskProgress || (!repeatedFailures && !sameObservableResult)) return undefined;

  return {
    toolName,
    count: streak.length,
    windowMs: config.toolRepeatWindowMs,
    identical: true,
    argsFingerprint,
    reasons: [
      `identical_tool_call_loop:${toolName}`,
      repeatedFailures ? "repeated_tool_failures" : "no_result_or_task_progress",
      `called_${streak.length}_times_in_${Math.round(config.toolRepeatWindowMs / 1000)}s`,
    ],
  };
}

/**
 * In-memory manager for session-scoped tool invocations with bounded capacity.
 */
export class ToolInvocationTracker {
  private static instance: ToolInvocationTracker;
  private sessionInvocations: Map<string, Map<string, ToolInvocation[]>> = new Map();

  static getInstance(): ToolInvocationTracker {
    if (!ToolInvocationTracker.instance) {
      ToolInvocationTracker.instance = new ToolInvocationTracker();
    }
    return ToolInvocationTracker.instance;
  }

  record(
    sessionId: string,
    runId: string,
    toolName: string,
    args: unknown,
    result: {
      toolCallId: string;
      outcome: "success" | "failed" | "cancelled";
      resultFingerprint: string;
      progressFingerprint: string;
      timestamp?: number;
    },
  ): void {
    const runs = this.sessionInvocations.get(sessionId) ?? new Map<string, ToolInvocation[]>();
    const list = runs.get(runId) ?? [];
    const maxTracked = getRepeatGuardConfig().maxTrackedInvocations;

    const invocation: ToolInvocation = {
      sessionId,
      runId,
      toolName,
      argsFingerprint: fingerprintToolArgs(args),
      timestamp: result.timestamp ?? Date.now(),
      toolCallId: result.toolCallId,
      outcome: result.outcome,
      resultFingerprint: result.resultFingerprint,
      progressFingerprint: result.progressFingerprint,
    };

    list.push(invocation);
    if (list.length > maxTracked) {
      list.splice(0, list.length - maxTracked);
    }
    runs.set(runId, list);
    this.sessionInvocations.set(sessionId, runs);
  }

  getInvocations(sessionId: string, runId?: string): readonly ToolInvocation[] {
    const runs = this.sessionInvocations.get(sessionId);
    if (runId !== undefined) return runs?.get(runId) ?? [];
    return [...(runs?.values() ?? [])].flat();
  }

  clearRun(sessionId: string, runId: string): void {
    const runs = this.sessionInvocations.get(sessionId);
    runs?.delete(runId);
    if (runs?.size === 0) this.sessionInvocations.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    this.sessionInvocations.delete(sessionId);
  }

  clearAll(): void {
    this.sessionInvocations.clear();
  }
}
