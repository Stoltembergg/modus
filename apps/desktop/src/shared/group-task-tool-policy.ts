import type { HarnessTaskCheckKind } from "./contracts";
import type { GroupTaskKind, GroupTaskStage } from "./group-work-state";
import type { ToolCapability } from "./tools";

const IMPLEMENT_CAPABILITIES: Partial<Record<GroupTaskKind, readonly ToolCapability[]>> = {
  code: ["read", "write"],
  docs: ["read", "write"],
  research: ["network"],
  review: ["read"],
};

/** Requirements describe task work; permissions are checked only when a tool executes. */
export function groupTaskToolRequirements(input: {
  kind: GroupTaskKind;
  stage: GroupTaskStage;
  requiredCheckKinds: readonly HarnessTaskCheckKind[];
  role: "owner" | "reviewer";
  coordinator: boolean;
}): { requiredCapabilities: readonly ToolCapability[]; groupToolNames: readonly string[] } {
  if (input.kind === "legacy") return { requiredCapabilities: [], groupToolNames: [] };
  const review = input.role === "reviewer" || input.stage === "review" || input.kind === "review";
  const requiredCapabilities: readonly ToolCapability[] = review
    ? ["read"]
    : input.stage === "verify"
      ? input.requiredCheckKinds.length > 0
        ? ["shell"]
        : []
      : input.stage === "implement"
        ? (IMPLEMENT_CAPABILITIES[input.kind] ?? [])
        : [];
  const groupToolNames = ["group_get_work_state", "group_list_tasks", "group_report_progress"];
  if (input.role === "owner") groupToolNames.push("group_report_result");
  if (review) groupToolNames.push("group_review_task");
  else groupToolNames.push("group_claim_task", "group_release_task", "group_request_review");
  if (input.coordinator) groupToolNames.push("group_assign_task", "group_handoff");
  return { requiredCapabilities, groupToolNames };
}
