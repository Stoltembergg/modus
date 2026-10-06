import type { AgentGroupMember, GroupTask } from "../../shared/contracts";
import { groupTaskToolRequirements } from "../../shared/group-task-tool-policy";
import type { GroupTaskStage, GroupWorkState } from "../../shared/group-work-state";
import type { ToolProfileName } from "../../shared/tools";
import { type ToolOverrides, type ToolRegistry, toolRegistry } from "../agent/tools/registry";

export type GroupRoutingReason =
  | "explicit-mention"
  | "capability-match"
  | "no-capability-match"
  | "no-eligible-lead"
  | "member-absent"
  | "member-archived"
  | "member-unavailable"
  | "capabilities-unconfigured"
  | "capability-incompatible"
  | "tools-inactive"
  | "dependency-incomplete"
  | "task-unavailable"
  | "execution-unavailable"
  | "budget-exhausted";

export type GroupMemberDispatchSnapshot = {
  availability: "available" | "busy-but-queueable" | "hard-unavailable";
  pendingTaskJobCount: number;
  capacity: number;
};

export type GroupRoutingInput = {
  task?: GroupTask;
  workState: GroupWorkState;
  leadSessionId?: string;
  explicitMentionSessionId?: string;
  memberAvailability: Record<string, "available" | "unavailable">;
  currentLoad: Record<string, number>;
  /** When provided, this snapshot is authoritative, including omitted members. */
  memberDispatch?: Record<string, GroupMemberDispatchSnapshot>;
  toolConfigurations: Record<
    string,
    { profile: ToolProfileName; overrides?: ToolOverrides; activeToolNames?: readonly string[] }
  >;
  toolRegistry?: Pick<ToolRegistry, "resolveActiveTools" | "capabilitiesFor">;
};

export type GroupRoutingResult = {
  kind: "selected" | "suggest_lead" | "needs_user";
  targetSessionId?: string;
  reasonCode: GroupRoutingReason;
  candidateSessionIds: string[];
  eligibleSessionIds: string[];
};

export function groupTaskRoutingStage(task: GroupTask): GroupTaskStage {
  if (task.status === "in_review" || task.kind === "review") return "review";
  return task.stage ?? (task.kind === "design" || task.kind === "question" ? "plan" : "implement");
}

/** Read-only routing. Tool activation is checked; permissions remain enforced at tool execution. */
export function routeGroupTask(input: GroupRoutingInput): GroupRoutingResult {
  const { task, workState } = input;
  const registry = input.toolRegistry ?? toolRegistry;
  const stage = task ? groupTaskRoutingStage(task) : undefined;
  const unavailable = (member: AgentGroupMember): GroupRoutingReason | undefined => {
    if (member.archived) return "member-archived";
    if (input.memberDispatch) {
      const dispatch = input.memberDispatch[member.sessionId];
      return !dispatch ||
        dispatch.availability === "hard-unavailable" ||
        !(dispatch.pendingTaskJobCount < dispatch.capacity)
        ? "member-unavailable"
        : undefined;
    }
    return input.memberAvailability[member.sessionId] !== "available"
      ? "member-unavailable"
      : undefined;
  };
  const compatible = (member: AgentGroupMember): GroupRoutingReason | undefined => {
    if (!task || task.kind === "legacy" || !task.kind) return undefined;
    if (!member.capabilityIds?.length || !member.supportedTaskKinds?.length)
      return "capabilities-unconfigured";
    const capability =
      task.kind === "research" && stage === "implement"
        ? "research"
        : task.kind === "docs" && stage === "implement"
          ? "docs"
          : stage === "deliver"
            ? "plan"
            : stage;
    if (
      !member.supportedTaskKinds?.includes(task.kind) ||
      !member.capabilityIds?.includes(capability ?? "plan")
    )
      return "capability-incompatible";
    const configuration = input.toolConfigurations[member.sessionId];
    if (!configuration) return "tools-inactive";
    const tools =
      configuration.activeToolNames ??
      registry.resolveActiveTools(configuration.profile, configuration.overrides);
    const requirements = groupTaskToolRequirements({
      kind: task.kind,
      stage: stage ?? groupTaskRoutingStage(task),
      requiredCheckKinds: (task.criteria ?? []).flatMap(
        (criterion) => criterion.requiredCheckKinds,
      ),
      role: stage === "review" ? "reviewer" : "owner",
      coordinator: member.sessionId === input.leadSessionId,
    });
    const activeCapabilities = new Set(tools.flatMap((name) => registry.capabilitiesFor(name)));
    if (requirements.requiredCapabilities.some((capability) => !activeCapabilities.has(capability)))
      return "tools-inactive";
    if (
      stage === "review" &&
      member.sessionId === task.ownerSessionId &&
      !(task.kind === "review" && task.status !== "in_review")
    )
      return "capability-incompatible";
    return undefined;
  };
  const eligible = workState.members.filter((m) => !unavailable(m));
  const candidates = eligible.filter((m) => !compatible(m));
  if (task?.kind && task.kind !== "legacy") {
    const priority = { low: 0, normal: 1, high: 2 };
    const assignedPriority = (id: string) =>
      Math.max(
        -1,
        ...workState.tasks
          .filter((t) => t.ownerSessionId === id && t.status !== "done" && t.status !== "cancelled")
          .map((t) => priority[t.priority ?? "normal"]),
      );
    candidates.sort(
      (a, b) =>
        Number(b.sessionId === task.ownerSessionId) - Number(a.sessionId === task.ownerSessionId) ||
        assignedPriority(b.sessionId) - assignedPriority(a.sessionId) ||
        (input.memberDispatch?.[a.sessionId]?.pendingTaskJobCount ?? 0) -
          (input.memberDispatch?.[b.sessionId]?.pendingTaskJobCount ?? 0) ||
        (input.currentLoad[a.sessionId] ?? 0) - (input.currentLoad[b.sessionId] ?? 0) ||
        a.sessionId.localeCompare(b.sessionId),
    );
  }
  const result = (
    kind: GroupRoutingResult["kind"],
    reasonCode: GroupRoutingReason,
    targetSessionId?: string,
  ): GroupRoutingResult => ({
    kind,
    reasonCode,
    ...(targetSessionId ? { targetSessionId } : {}),
    candidateSessionIds: candidates.map((m) => m.sessionId),
    eligibleSessionIds: eligible.map((m) => m.sessionId).sort(),
  });
  const explicit = input.explicitMentionSessionId;
  const selectedMember = explicit
    ? workState.members.find((m) => m.sessionId === explicit)
    : undefined;
  if (explicit) {
    const reason = !selectedMember
      ? "member-absent"
      : (unavailable(selectedMember) ?? compatible(selectedMember));
    if (reason) return result("needs_user", reason, explicit);
  }
  const blocked =
    workState.execution?.stopped || workState.execution?.waitingForUser
      ? "execution-unavailable"
      : Object.values(workState.budgets).some((value) => value <= 0)
        ? "budget-exhausted"
        : task &&
            (task.status === "blocked" ||
              task.status === "done" ||
              task.status === "cancelled" ||
              task.blockedReason)
          ? "task-unavailable"
          : task?.dependencyIds?.some(
                (id) => workState.tasks.find((t) => t.id === id)?.status !== "done",
              )
            ? "dependency-incomplete"
            : undefined;
  if (blocked) return result("needs_user", blocked, explicit);
  if (explicit) return result("selected", "explicit-mention", explicit);
  if (task?.kind && task.kind !== "legacy" && candidates.length) {
    return result("selected", "capability-match", candidates[0]?.sessionId);
  }
  const lead = eligible.find((m) => m.sessionId === input.leadSessionId);
  return lead
    ? result("suggest_lead", "no-capability-match", lead.sessionId)
    : result("needs_user", "no-eligible-lead");
}
