import type { ResumeGroupExecutionInput } from "../../shared/contracts";
import {
  getGroupJob,
  persistGroupChain,
  readGroupChain,
  updateGroupJob,
} from "./group-job-store";
import type { ChainState, Wake } from "./group-runtime-lib";
import { membersOf } from "./group-runtime-lib";
import { getGroupRuntime } from "./group-runtime-service";
import { GroupStoreError } from "./group-store";
import type { GroupTurnTranscript } from "./group-turn-transcript";

/** Internal GroupRuntime fields needed to requeue a durable job. */
type ResumeRuntime = {
  disposed: boolean;
  seq: number;
  chains: Map<string, ChainState>;
  retiredChains: Map<string, ChainState>;
  queues: Map<string, Wake[]>;
  running: Map<string, Wake>;
  gated: Map<string, Wake>;
  transcript: GroupTurnTranscript;
  durableDispatch: <T>(action: () => T) => T;
  pump: () => void;
  emitActivity: (groupId: string) => void;
};

/**
 * Resume an interrupted/failed/cancelled turn by durable execution id.
 * Requeues the existing job in its original chain — no new user message.
 */
export function resumeGroupExecution(input: ResumeGroupExecutionInput): void {
  resumeGroupExecutionOn(getGroupRuntime(), input);
}

/** Test/helper entry that resumes against a concrete runtime instance. */
export function resumeGroupExecutionOn(
  runtimeLike: object,
  input: ResumeGroupExecutionInput,
): void {
  const runtime = runtimeLike as unknown as ResumeRuntime;
  if (runtime.disposed) throw new Error("Group runtime is disposed.");
  runtime.durableDispatch(() => requeueExecution(runtime, input));
  runtime.pump();
}

function requeueExecution(runtime: ResumeRuntime, input: ResumeGroupExecutionInput): void {
  const job = getGroupJob(input.executionId);
  if (!job || job.wake.groupId !== input.groupId) {
    throw new GroupStoreError(
      "message-not-found",
      `Group execution not found: ${input.executionId}`,
    );
  }
  if (job.status !== "interrupted" && job.status !== "failed" && job.status !== "cancelled") {
    throw new GroupStoreError(
      "invalid-transition",
      `Cannot resume execution ${input.executionId}: it is ${job.status}.`,
    );
  }
  const member = membersOf(input.groupId).find((row) => row.sessionId === job.wake.sessionId);
  if (!member) {
    throw new GroupStoreError(
      "not-a-member",
      `Session ${job.wake.sessionId} is not a member of group ${input.groupId}.`,
    );
  }
  if (member.archived) {
    throw new GroupStoreError(
      "member-archived",
      `Session ${job.wake.sessionId} is archived and cannot be resumed.`,
    );
  }
  if (
    runtime.running.has(job.wake.sessionId) ||
    runtime.gated.has(job.wake.sessionId) ||
    (runtime.queues.get(job.wake.sessionId) ?? []).some((wake) => wake.id === job.wake.id)
  ) {
    throw new GroupStoreError(
      "invalid-transition",
      `Cannot resume execution ${input.executionId}: the member already has active work.`,
    );
  }
  const chain =
    runtime.chains.get(job.wake.chainId) ??
    runtime.retiredChains.get(job.wake.chainId) ??
    readGroupChain(job.wake.chainId);
  if (!chain) {
    throw new GroupStoreError(
      "message-not-found",
      `Execution chain not found for ${input.executionId}.`,
    );
  }
  if (chain.ended) {
    chain.ended = undefined;
    persistGroupChain(chain);
  }
  runtime.retiredChains.delete(chain.chainId);
  runtime.chains.set(chain.chainId, chain);
  const wake: Wake = {
    ...job.wake,
    seq: ++runtime.seq,
    cancelled: false,
    gated: false,
    error: undefined,
    runId: undefined,
    lastEventCursor: undefined,
    startedAt: undefined,
    lastProgressAt: undefined,
    pausedAt: undefined,
    worktreeBranch: undefined,
    publicMessageIds: undefined,
    assistantMessageIds: undefined,
    questionRequestIds: undefined,
  };
  updateGroupJob(wake, "pending");
  runtime.transcript.setState(wake, "queued");
  const queue = runtime.queues.get(wake.sessionId) ?? [];
  queue.push(wake);
  runtime.queues.set(wake.sessionId, queue);
  runtime.emitActivity(wake.groupId);
}
