import { deleteAgentSessionTree } from "../agent/session-lifecycle";
import { deleteAgent } from "./agents-store";

/*
 * Agent removal with its sessions (A3 review). The store transaction only
 * DETACHES the 1:1 chats (the agent row goes; the session rows stay,
 * unlinked). Once it has committed, each tree gets the ONE authoritative teardown,
 * deleteAgentSessionTree, while its records still exist: subagents are found
 * and disposed, runtimes stop, checkpoints and memory runs are cleaned up,
 * then the rows go. If the transaction fails nothing has been torn down.
 *
 * The wrapper calls the store synchronously, so a store error throws before
 * any teardown and keeps the IPC error format.
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
