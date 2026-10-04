import type { GroupTask } from "../../shared/contracts";
import { evaluateGroupTaskGate } from "../../shared/group-task-policy";
import type { GroupWorkState } from "../../shared/group-work-state";
import { getDatabase } from "../db/database";
import { readGroupChain } from "./group-job-store";
import {
  ESTIMATED_CONTEXT_TOKENS_PER_WAKE,
  estimateGroupTokens,
  GROUP_CHAIN_LIMITS,
} from "./group-runtime-lib";
import {
  GroupStoreError,
  getAgentGroup,
  listAgentGroupMembers,
  listGroupTasks,
} from "./group-store";
import { resolveGroupTaskEvidence } from "./group-task-evidence";

/** A bounded, read-only projection. Git freshness is resolved by the async write gateway. */
export function getGroupWorkState(groupId: string, executionId?: string): GroupWorkState {
  if (!getAgentGroup(groupId))
    throw new GroupStoreError("group-not-found", `Unknown group ${groupId}.`);
  const chain = executionId ? readGroupChain(executionId) : undefined;
  if (chain && chain.groupId !== groupId)
    throw new GroupStoreError("invalid-value", "Execution belongs to another group.");
  if (
    executionId &&
    !chain &&
    !getDatabase()
      .prepare("select 1 from group_messages where id = ? and group_id = ?")
      .get(executionId, groupId)
  )
    throw new GroupStoreError("message-not-found", `Unknown group execution ${executionId}.`);
  const tasks = listGroupTasks(groupId).filter(
    (task) => !executionId || task.executionId === executionId,
  );
  const members = listAgentGroupMembers(groupId);
  const waiting = executionId
    ? Boolean(
        getDatabase()
          .prepare(
            "select 1 from group_jobs where group_id = ? and chain_id = ? and status = 'awaiting_user' limit 1",
          )
          .get(groupId, executionId),
      )
    : false;
  const qa: NonNullable<GroupWorkState["qa"]> = {};
  const state: GroupWorkState = {
    groupId,
    tasks: [],
    gates: {},
    members: [],
    qa,
    ...(executionId
      ? {
          execution: {
            id: executionId,
            stopped: chain?.ended === "stopped",
            waitingForUser: waiting,
          },
        }
      : {}),
    omitted: { tasks: tasks.length, members: members.length, criteria: 0 },
    budgets: {
      remainingAgentMessages: Math.max(
        0,
        GROUP_CHAIN_LIMITS.maxAgentMessages - (chain?.agentMessages ?? 0),
      ),
      remainingMemberWakes: Math.max(
        0,
        members.length * GROUP_CHAIN_LIMITS.maxWakesPerMember -
          [...(chain?.wakesByMember.values() ?? [])].reduce((sum, value) => sum + value, 0),
      ),
      remainingInputTokens: Math.max(
        0,
        GROUP_CHAIN_LIMITS.maxEstimatedInputTokens - (chain?.inputTokens ?? 0),
      ),
    },
  };
  const fits = () =>
    estimateGroupTokens(JSON.stringify(state)) <= ESTIMATED_CONTEXT_TOKENS_PER_WAKE;
  for (const member of members) {
    state.members.push({ ...member, name: member.name.slice(0, 120) });
    state.omitted.members--;
    if (!fits()) {
      state.members.pop();
      state.omitted.members++;
      break;
    }
  }
  for (const task of tasks) {
    const compact: GroupTask = {
      id: task.id,
      groupId,
      title: task.title.slice(0, 200),
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      stateVersion: task.stateVersion ?? 1,
      criteriaVersion: task.criteriaVersion ?? 1,
      kind: task.kind ?? "legacy",
      priority: task.priority ?? "normal",
      dependencyIds: task.dependencyIds ?? [],
      verificationPolicy: task.verificationPolicy ?? { mode: "none", requireReview: false },
      ...(task.executionId ? { executionId: task.executionId } : {}),
      ...(task.ownerSessionId ? { ownerSessionId: task.ownerSessionId } : {}),
      ...(task.reviewerSessionId ? { reviewerSessionId: task.reviewerSessionId } : {}),
      ...(task.stage ? { stage: task.stage } : {}),
      ...(task.blockedReason ? { blockedReason: task.blockedReason.slice(0, 500) } : {}),
    };
    state.tasks.push(compact);
    state.gates[task.id] = evaluateGroupTaskGate(resolveGroupTaskEvidence(task, ""));
    qa[task.id] = {
      criterionCount: task.criteria?.length ?? 0,
      evidenceCount: task.evidenceRefs?.length ?? 0,
      pendingCriterionIds: (task.criteria ?? []).slice(0, 16).map((criterion) => criterion.id),
      freshness: "unavailable",
    };
    state.omitted.tasks--;
    if (!fits()) {
      state.tasks.pop();
      delete state.gates[task.id];
      delete qa[task.id];
      state.omitted.tasks++;
      break;
    }
    state.omitted.criteria += Math.max(0, (task.criteria?.length ?? 0) - 16);
  }
  return state;
}
