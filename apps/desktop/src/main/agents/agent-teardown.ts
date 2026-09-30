import type { AgentGroupWithMembers, UpdateAgentGroupMembersInput } from "../../shared/contracts";
import { deleteAgentSessionTree } from "../agent/session-lifecycle";
import { deleteAgentGroup, removeAgentFromGroup } from "../groups/group-store";
import { deleteAgent, updateGroupMembers } from "./agents-store";

/*
 * Agent / member / group removal with its sessions (A3 review). The store
 * transaction only DETACHES the room sessions and 1:1 chats (membership and
 * agent rows go; the session rows stay, hidden or unlinked). Once it has
 * committed, each tree gets the ONE authoritative teardown,
 * deleteAgentSessionTree, while its records still exist: subagents are found
 * and disposed, runtimes stop, checkpoints and memory runs are cleaned up,
 * then the rows go. If the transaction fails nothing has been torn down.
 *
 * Each wrapper calls the store synchronously, so a store error (e.g.
 * group-min-members) throws before any teardown and keeps the IPC error format.
 */

/** Tears the detached session trees down in order. Never rejects (logs instead). */
export async function teardownDetachedSessions(sessionIds: readonly string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      await deleteAgentSessionTree(sessionId);
    } catch (error) {
      console.warn("[modus] agent session teardown failed:", error);
    }
  }
}

export function deleteAgentWithSessions(agentId: string): Promise<void> {
  return teardownDetachedSessions(deleteAgent(agentId));
}

export function deleteGroupWithSessions(groupId: string): Promise<void> {
  return teardownDetachedSessions(deleteAgentGroup(groupId));
}

export function removeMemberWithSessions(groupId: string, sessionId: string): Promise<void> {
  return teardownDetachedSessions(removeAgentFromGroup(groupId, sessionId));
}

export function updateMembersWithSessions(
  input: UpdateAgentGroupMembersInput,
): Promise<AgentGroupWithMembers> {
  const { group, removedSessionIds } = updateGroupMembers(input);
  return teardownDetachedSessions(removedSessionIds).then(() => group);
}
