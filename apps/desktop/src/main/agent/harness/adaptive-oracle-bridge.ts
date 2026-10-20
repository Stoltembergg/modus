/**
 * Joins read-only specialist findings into the owning run tracker.
 * Oracle output remains untrusted advisory data, never verification evidence.
 */
import { capOracleDigest } from "./oracle-findings";

/** Bounded join for adaptive Oracle findings; never blocks Intent Gate / pre_prompt. */
export const ADAPTIVE_ORACLE_WAIT_MS = 20_000;

export type AdaptiveOracleTrackerFields = {
  adaptiveOracleChildSessionId?: string;
  adaptiveOracleConsulted?: boolean;
  adaptiveOracleDigest?: string;
  adaptiveOracleWaitReason?: "oracle_wait_timeout" | "oracle_wait_failed";
  lastQaStatus?: string;
  lastAdaptiveDecision?: { action?: string };
  taskState?: {
    hypothesisRefs: string[];
    [key: string]: unknown;
  };
};

type WaitBackgroundFn = (input: {
  sessionId: string;
  timeoutMs: number;
  subagentIds?: string[];
}) => Promise<{
  timedOut: boolean;
  subagents: Array<{ id: string; status: string; output?: string }>;
}>;

/**
 * Bounded wait for an adaptive Oracle/debugger/reviewer child.
 * Sets tracker.adaptiveOracleConsulted; stores a capped digest on success.
 */
export async function joinAdaptiveOracleFindings(
  runtime: { waitBackground: WaitBackgroundFn },
  parentSessionId: string,
  tracker: AdaptiveOracleTrackerFields,
): Promise<void> {
  const childId = tracker.adaptiveOracleChildSessionId;
  if (!childId || tracker.adaptiveOracleDigest) return;
  tracker.adaptiveOracleConsulted = true;
  try {
    const result = await runtime.waitBackground({
      sessionId: parentSessionId,
      timeoutMs: ADAPTIVE_ORACLE_WAIT_MS,
      subagentIds: [childId],
    });
    const child = result.subagents.find((entry) => entry.id === childId);
    if (!child || child.status === "running" || result.timedOut) {
      tracker.adaptiveOracleWaitReason = "oracle_wait_timeout";
      return;
    }
    if (child.status !== "completed" || !child.output) {
      tracker.adaptiveOracleWaitReason = "oracle_wait_failed";
      return;
    }
    const digest = capOracleDigest(child.output);
    if (!digest) {
      tracker.adaptiveOracleWaitReason = "oracle_wait_failed";
      return;
    }
    tracker.adaptiveOracleDigest = digest;
    delete tracker.adaptiveOracleWaitReason;
    if (tracker.taskState) {
      const ref = `oracle:${childId.slice(0, 8)}`;
      if (!tracker.taskState.hypothesisRefs.includes(ref)) {
        tracker.taskState = {
          ...tracker.taskState,
          hypothesisRefs: [...tracker.taskState.hypothesisRefs, ref].slice(0, 24),
        };
      }
    }
  } catch {
    tracker.adaptiveOracleWaitReason = "oracle_wait_failed";
  }
}
