import type { AgentGroupInfo } from "./contracts";

/**
 * Coordinator mode (PR 7) is in effect only while the group has a Lead: the
 * stored mode is kept but ignored without one (routing falls back to the
 * default), and a new Lead becomes the coordinator.
 */
export function isCoordinatorModeActive(
  group: Pick<AgentGroupInfo, "mode" | "leadSessionId">,
): boolean {
  return group.mode === "coordinator" && Boolean(group.leadSessionId);
}
