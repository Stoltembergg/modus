import { createHash } from "node:crypto";
import { getRepeatGuardConfig, type RepeatGuardConfig } from "./repeat-guard-config";

export type ToolInvocation = {
  toolName: string;
  argsFingerprint: string;
  timestamp: number;
  toolCallId?: string | undefined;
  error?: boolean | undefined;
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
    const serialized = typeof args === "string" ? args : JSON.stringify(args, Object.keys(args as object).sort());
    return createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 16);
  } catch {
    return createHash("sha256").update(String(args), "utf8").digest("hex").slice(0, 16);
  }
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
 * In-memory manager for session-scoped tool invocations with bounded capacity.
 */
export class ToolInvocationTracker {
  private static instance: ToolInvocationTracker;
  private sessionInvocations: Map<string, ToolInvocation[]> = new Map();

  static getInstance(): ToolInvocationTracker {
    if (!ToolInvocationTracker.instance) {
      ToolInvocationTracker.instance = new ToolInvocationTracker();
    }
    return ToolInvocationTracker.instance;
  }

  record(sessionId: string, toolName: string, args: unknown, error?: boolean, timestamp: number = Date.now()): void {
    const list = this.sessionInvocations.get(sessionId) ?? [];
    const maxTracked = getRepeatGuardConfig().maxTrackedInvocations;

    const invocation: ToolInvocation = {
      toolName,
      argsFingerprint: fingerprintToolArgs(args),
      timestamp,
      ...(error !== undefined ? { error } : {}),
    };

    list.push(invocation);
    if (list.length > maxTracked) {
      list.splice(0, list.length - maxTracked);
    }
    this.sessionInvocations.set(sessionId, list);
  }

  getInvocations(sessionId: string): readonly ToolInvocation[] {
    return this.sessionInvocations.get(sessionId) ?? [];
  }

  clearSession(sessionId: string): void {
    this.sessionInvocations.delete(sessionId);
  }

  clearAll(): void {
    this.sessionInvocations.clear();
  }
}
