import type { AdaptiveFailureAttempt } from "../../../../shared/contracts";
import { getRepeatGuardConfig, type RepeatGuardConfig } from "./repeat-guard-config";
import { detectRepeatHypothesis, type HypothesisRepeatAnalysis } from "./repeat-hypothesis-guard";
import type { RepeatPattern } from "./repeat-tool-guard";

export type FailureLoopAction =
  | {
      action: "change_strategy";
      suggestion: string;
      reasonCodes: string[];
    }
  | {
      action: "delegate";
      role: "debugger" | "explore" | "oracle";
      task: string;
      reasonCodes: string[];
    }
  | {
      action: "consult_oracle";
      reason: string;
      reasonCodes: string[];
    }
  | {
      action: "circuit_break";
      reason: string;
      reasonCodes: string[];
    };

export type CircuitBreakerState = "closed" | "open" | "half_open";

export type CircuitBreakerRecord = {
  sessionId: string;
  state: CircuitBreakerState;
  trippedReason?: string;
  trippedAt?: number;
  failureCount: number;
  consecutiveIdenticalTools: number;
};

/**
 * Analyzes failure attempts, tool invocations, and hypothesis diversity to detect loops
 * and recommend mitigation actions or trip the circuit breaker.
 */
export function detectFailureLoop(input: {
  attempts: readonly AdaptiveFailureAttempt[];
  repeatTools: readonly RepeatPattern[];
  hypothesisAnalysis?: HypothesisRepeatAnalysis;
  configOverrides?: Partial<RepeatGuardConfig>;
}): FailureLoopAction | undefined {
  const config = { ...getRepeatGuardConfig(), ...input.configOverrides };
  const failedAttempts = input.attempts.filter(
    (a) => a.status === "failed" || a.status === "discarded",
  );

  const hypothesis = input.hypothesisAnalysis ?? detectRepeatHypothesis(failedAttempts, config);

  // 1. Hard Circuit Breaker: Maximum consecutive failure attempts reached
  if (failedAttempts.length >= config.maxFailureAttempts) {
    return {
      action: "circuit_break",
      reason: `Circuit breaker tripped: exceeded maximum failed attempts (${failedAttempts.length}/${config.maxFailureAttempts})`,
      reasonCodes: [
        "circuit_breaker_max_failures",
        `failures_${failedAttempts.length}`,
        ...hypothesis.reasons,
      ],
    };
  }

  // 2. Severe Identical Tool Repeat: Same tool with identical args executed >= threshold
  const identicalTool = input.repeatTools.find(
    (p) => p.identical && p.count >= config.toolRepeatThreshold,
  );
  if (identicalTool) {
    const isBash =
      identicalTool.toolName.startsWith("bash") || identicalTool.toolName.includes("terminal");
    const isSearch =
      identicalTool.toolName.includes("grep") ||
      identicalTool.toolName.includes("search") ||
      identicalTool.toolName.includes("find");

    if (isBash) {
      return {
        action: "delegate",
        role: "debugger",
        task: `Investigate repetitive bash execution failure with tool ${identicalTool.toolName}`,
        reasonCodes: [
          "tool_loop_detected",
          `identical_tool:${identicalTool.toolName}`,
          ...identicalTool.reasons,
        ],
      };
    }

    if (isSearch) {
      return {
        action: "delegate",
        role: "explore",
        task: `Conduct structured exploration to unblock redundant searches with tool ${identicalTool.toolName}`,
        reasonCodes: [
          "tool_loop_detected",
          `redundant_search:${identicalTool.toolName}`,
          ...identicalTool.reasons,
        ],
      };
    }

    if (failedAttempts.length >= 2) {
      return {
        action: "consult_oracle",
        reason: `Repeated tool execution loop with ${identicalTool.toolName} and multiple failures`,
        reasonCodes: [
          "tool_loop_consult_oracle",
          `identical_tool:${identicalTool.toolName}`,
          ...identicalTool.reasons,
        ],
      };
    }

    return {
      action: "change_strategy",
      suggestion: `Avoid repeating identical invocation of ${identicalTool.toolName}; alter inputs or approach`,
      reasonCodes: [
        "tool_loop_change_strategy",
        `identical_tool:${identicalTool.toolName}`,
        ...identicalTool.reasons,
      ],
    };
  }

  // 3. Hypothesis cycling: agent repeating failed theories
  if (hypothesis.isRepeating && failedAttempts.length >= 2) {
    return {
      action: "change_strategy",
      suggestion:
        "Low hypothesis diversity: agent is repeating previously failed strategies. Switch to an alternative hypothesis or architecture review.",
      reasonCodes: ["hypothesis_loop_detected", ...hypothesis.reasons],
    };
  }

  // 4. High-frequency non-identical tool churn with multiple failures
  const churnTool = input.repeatTools.find(
    (p) => !p.identical && p.count >= config.toolRepeatThreshold + 2,
  );
  if (churnTool && failedAttempts.length >= 2) {
    return {
      action: "change_strategy",
      suggestion: `High-frequency churn on ${churnTool.toolName} without progressing verification. Refine step scope or inspect environment.`,
      reasonCodes: [
        "high_frequency_churn_loop",
        `tool_churn:${churnTool.toolName}`,
        ...churnTool.reasons,
      ],
    };
  }

  return undefined;
}

/**
 * Registry to monitor and enforce circuit breaker state per session.
 */
export class CircuitBreakerRegistry {
  private static instance: CircuitBreakerRegistry;
  private records: Map<string, CircuitBreakerRecord> = new Map();

  static getInstance(): CircuitBreakerRegistry {
    if (!CircuitBreakerRegistry.instance) {
      CircuitBreakerRegistry.instance = new CircuitBreakerRegistry();
    }
    return CircuitBreakerRegistry.instance;
  }

  getRecord(sessionId: string): CircuitBreakerRecord {
    const existing = this.records.get(sessionId);
    if (existing) return existing;

    const record: CircuitBreakerRecord = {
      sessionId,
      state: "closed",
      failureCount: 0,
      consecutiveIdenticalTools: 0,
    };
    this.records.set(sessionId, record);
    return record;
  }

  trip(sessionId: string, reason: string): CircuitBreakerRecord {
    const record = this.getRecord(sessionId);
    record.state = "open";
    record.trippedReason = reason;
    record.trippedAt = Date.now();
    return record;
  }

  recordFailure(sessionId: string): CircuitBreakerRecord {
    const record = this.getRecord(sessionId);
    record.failureCount += 1;
    const max = getRepeatGuardConfig().maxFailureAttempts;
    if (record.failureCount >= max && record.state === "closed") {
      this.trip(sessionId, `Exceeded max failure count: ${record.failureCount}/${max}`);
    }
    return record;
  }

  reset(sessionId: string): void {
    this.records.delete(sessionId);
  }

  isOpen(sessionId: string): boolean {
    return this.getRecord(sessionId).state === "open";
  }

  clearAll(): void {
    this.records.clear();
  }
}
