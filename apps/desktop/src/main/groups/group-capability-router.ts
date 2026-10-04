import type { AgentGroupMember, GroupTask } from "../../shared/contracts";
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
  | "capability-incompatible"
  | "tools-inactive"
  | "dependency-incomplete"
  | "task-unavailable"
  | "execution-unavailable"
  | "budget-exhausted";

export type GroupRoutingInput = {
  task?: GroupTask;
  workState: GroupWorkState;
  leadSessionId?: string;
  explicitMentionSessionId?: string;
  memberAvailability: Record<string, "available" | "unavailable">;
  currentLoad: Record<string, number>;
  toolConfigurations: Record<
    string,
    { profile: ToolProfileName; overrides?: ToolOverrides; activeToolNames?: readonly string[] }
  >;
  toolRegistry?: Pick<ToolRegistry, "resolveActiveTools">;
};

export type GroupRoutingResult = {
  kind: "selected" | "suggest_lead" | "needs_user";
  targetSessionId?: string;
  reasonCode: GroupRoutingReason;
  candidateSessionIds: string[];
  eligibleSessionIds: string[];
};

function stageOf(task: GroupTask): GroupTaskStage {
  if (task.status === "in_review" || task.kind === "review") return "review";
  return task.stage ?? (task.kind === "design" || task.kind === "question" ? "plan" : "implement");
}

/** Read-only routing. Tool activation is checked; permissions remain enforced at tool execution. */
export function routeGroupTask(input: GroupRoutingInput): GroupRoutingResult {
  const { task, workState } = input;
  const registry = input.toolRegistry ?? toolRegistry;
  const stage = task ? stageOf(task) : undefined;
  const unavailable = (member: AgentGroupMember): GroupRoutingReason | undefined =>
    member.archived
      ? "member-archived"
      : input.memberAvailability[member.sessionId] !== "available"
        ? "member-unavailable"
        : undefined;
  const compatible = (member: AgentGroupMember): GroupRoutingReason | undefined => {
    if (!task || task.kind === "legacy" || !task.kind) return undefined;
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
    if (
      stage === "implement" &&
      (task.kind === "code" || task.kind === "docs") &&
      (!tools.includes("read") || (!tools.includes("edit") && !tools.includes("write")))
    )
      return "tools-inactive";
    if (stage === "review" && !tools.includes("read")) return "tools-inactive";
    if (
      stage === "verify" &&
      (task.criteria ?? []).some((c) => c.requiredCheckKinds.length > 0) &&
      !tools.includes("bash")
    )
      return "tools-inactive";
    if (stage === "review" && member.sessionId === task.ownerSessionId)
      return "capability-incompatible";
    return undefined;
  };
  const eligible = workState.members.filter((m) => !unavailable(m));
  const candidates = eligible.filter((m) => !compatible(m));
  const result = (
    kind: GroupRoutingResult["kind"],
    reasonCode: GroupRoutingReason,
    targetSessionId?: string,
  ): GroupRoutingResult => ({
    kind,
    reasonCode,
    ...(targetSessionId ? { targetSessionId } : {}),
    candidateSessionIds: candidates.map((m) => m.sessionId).sort(),
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
        (input.currentLoad[a.sessionId] ?? 0) - (input.currentLoad[b.sessionId] ?? 0) ||
        a.sessionId.localeCompare(b.sessionId),
    );
    return result("selected", "capability-match", candidates[0]?.sessionId);
  }
  const lead = eligible.find((m) => m.sessionId === input.leadSessionId);
  return lead
    ? result("suggest_lead", "no-capability-match", lead.sessionId)
    : result("needs_user", "no-eligible-lead");
}
