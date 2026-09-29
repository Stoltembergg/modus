/**
 * Gap 5 -- Adaptive Oracle findings bridge.
 *
 * Installs into PiSdkRuntime via prototype hooks + Meta Controller augmenters so
 * we never rewrite the ~150KB pi-sdk-runtime monolith through MCP. Oracle stays
 * builtin read-only; findings digests are untrusted turn data only.
 */
import { hypothesisCodeForQaFailure, strategyCodeForQaFailure } from "./change-strategy";
import { setAdaptiveHintAugmenter, setAdaptiveSnapshotAugmenter } from "./meta-controller";
import { capOracleDigest, formatOracleFindingsEnvelope } from "./oracle-findings";

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

type RuntimeLike = {
  waitBackground: WaitBackgroundFn;
  runOutputTrackers?: Map<string, AdaptiveOracleTrackerFields>;
  runSubagent?: (
    window: unknown,
    input: {
      parentSessionId: string;
      task: string;
      [key: string]: unknown;
    },
  ) => Promise<{ session: { id: string } }>;
  flushPendingAdaptiveSpawn?: (
    window: unknown,
    runtimeSession: { info: { id: string } },
    tracker: AdaptiveOracleTrackerFields,
    taskLabel: string,
  ) => Promise<void>;
  recordAdaptiveFailure?: (
    runtimeSession: unknown,
    tracker: AdaptiveOracleTrackerFields,
    input: {
      strategyCode: string;
      reasonCode: string;
      hypothesisCode?: string;
      [key: string]: unknown;
    },
  ) => void;
  consultAdaptiveController?: (
    runtimeSession: unknown,
    tracker: AdaptiveOracleTrackerFields,
    input: unknown,
  ) => Promise<unknown>;
};

let pendingOracleEnvelope: string | undefined;
let installed = false;

export function peekPendingOracleEnvelope(): string | undefined {
  return pendingOracleEnvelope;
}

export function clearPendingOracleEnvelope(): void {
  pendingOracleEnvelope = undefined;
}

/**
 * Bounded wait for an adaptive Oracle/debugger/reviewer child.
 * Sets tracker.adaptiveOracleConsulted; stores a capped digest on success.
 */
export async function joinAdaptiveOracleFindings(
  runtime: Pick<RuntimeLike, "waitBackground">,
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
    if (child.status === "error" || child.status === "missing" || !child.output) {
      tracker.adaptiveOracleWaitReason = "oracle_wait_failed";
      return;
    }
    const digest = capOracleDigest(child.output);
    if (!digest) {
      tracker.adaptiveOracleWaitReason = "oracle_wait_failed";
      return;
    }
    tracker.adaptiveOracleDigest = digest;
    pendingOracleEnvelope = formatOracleFindingsEnvelope(digest);
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

function installMetaControllerAugmenters(): void {
  setAdaptiveHintAugmenter((hint) => {
    const envelope = pendingOracleEnvelope;
    if (!envelope) return hint;
    return hint ? `${hint}\n\n${envelope}` : envelope;
  });
}

/**
 * Patch PiSdkRuntime so adaptive Oracle spawn joins with a bounded wait and
 * Failure Intelligence records mapped strategy codes -- without editing the monolith.
 */
export function installAdaptiveOracleBridge(RuntimeClass: { prototype: object }): void {
  if (installed) return;
  installed = true;
  installMetaControllerAugmenters();

  const proto = RuntimeClass.prototype as RuntimeLike & Record<string, unknown>;

  const originalRunSubagent = proto.runSubagent;
  if (typeof originalRunSubagent === "function") {
    proto.runSubagent = async function (
      this: RuntimeLike,
      window: unknown,
      input: { parentSessionId: string; task: string; [key: string]: unknown },
    ) {
      const result = await originalRunSubagent.call(this, window, input);
      if (typeof input.task === "string" && input.task.startsWith("adaptive:")) {
        const role = input.task.slice("adaptive:".length);
        if (role === "oracle" || role === "debugger" || role === "reviewer") {
          const tracker = this.runOutputTrackers?.get(input.parentSessionId);
          if (tracker) {
            tracker.adaptiveOracleChildSessionId = result.session.id;
          }
        }
      }
      return result;
    };
  }

  const originalFlush = proto.flushPendingAdaptiveSpawn;
  if (typeof originalFlush === "function") {
    proto.flushPendingAdaptiveSpawn = async function (
      this: RuntimeLike,
      window: unknown,
      runtimeSession: { info: { id: string } },
      tracker: AdaptiveOracleTrackerFields,
      taskLabel: string,
    ) {
      await originalFlush.call(this, window, runtimeSession, tracker, taskLabel);
      // Only join on post_failure / post_qa paths (QA status already known).
      // Never block pre_prompt Intent Gate (lastQaStatus unset).
      if (
        tracker.lastQaStatus === "failed" &&
        tracker.adaptiveOracleChildSessionId &&
        !tracker.adaptiveOracleDigest
      ) {
        await joinAdaptiveOracleFindings(this, runtimeSession.info.id, tracker);
      }
    };
  }

  const originalRecord = proto.recordAdaptiveFailure;
  if (typeof originalRecord === "function") {
    proto.recordAdaptiveFailure = function (
      this: RuntimeLike,
      runtimeSession: unknown,
      tracker: AdaptiveOracleTrackerFields,
      input: {
        strategyCode: string;
        reasonCode: string;
        hypothesisCode?: string;
        [key: string]: unknown;
      },
    ) {
      let next = input;
      if (input.reasonCode === "qa_failed" && input.strategyCode === "same_edit_retry") {
        const editedAfterOracleWithoutReplan =
          Boolean(tracker.adaptiveOracleDigest) &&
          tracker.lastAdaptiveDecision?.action !== "replan";
        const strategyCode = strategyCodeForQaFailure({
          continuationWithoutNewEvidence: false,
          oracleDigestPresent: Boolean(tracker.adaptiveOracleDigest),
          editedAfterOracleWithoutReplan,
        });
        const hypothesisCode = hypothesisCodeForQaFailure({
          oracleDigestPresent: Boolean(tracker.adaptiveOracleDigest),
          editedAfterOracleWithoutReplan,
        });
        next = {
          ...input,
          strategyCode,
          ...(hypothesisCode ? { hypothesisCode } : {}),
        };
      }
      return originalRecord.call(this, runtimeSession, tracker, next);
    };
  }

  const originalConsult = proto.consultAdaptiveController;
  if (typeof originalConsult === "function") {
    proto.consultAdaptiveController = async function (
      this: RuntimeLike,
      runtimeSession: unknown,
      tracker: AdaptiveOracleTrackerFields,
      input: unknown,
    ) {
      setAdaptiveSnapshotAugmenter((snapshot) => ({
        ...snapshot,
        ...(tracker.adaptiveOracleConsulted ? { oracleConsulted: true } : {}),
        ...(tracker.adaptiveOracleDigest ? { oracleDigestPresent: true } : {}),
      }));
      try {
        return await originalConsult.call(this, runtimeSession, tracker, input);
      } finally {
        setAdaptiveSnapshotAugmenter(undefined);
      }
    };
  }
}

/** Test helper -- allows reinstall in unit tests. */
export function resetAdaptiveOracleBridgeForTests(): void {
  installed = false;
  pendingOracleEnvelope = undefined;
  setAdaptiveSnapshotAugmenter(undefined);
  setAdaptiveHintAugmenter(undefined);
}
