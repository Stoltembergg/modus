/**
 * Group-scoped waiting: a new user message in the room supersedes any member
 * still "Waiting for you" (intent gate / HyperPlan) so amber waiting cannot
 * stick forever while the conversation continues with someone else — and so a
 * previously gated member can be re-woken if this message targets them.
 *
 * Applied as a prototype patch so the large group-runtime.ts module does not
 * need a full MCP rewrite.
 */
import { GroupRuntime } from "./group-runtime";
import { getAgentGroupForSession } from "./group-store";

type GatedWake = { groupId: string; sessionId: string };

type RuntimeInternals = {
  gated: Map<string, GatedWake>;
  awaitingUser: Map<string, string>;
  runtime: { abort(sessionId: string): Promise<void> };
  emitActivity(groupId: string): void;
};

const originalPostUserMessage = GroupRuntime.prototype.postUserMessage;

GroupRuntime.prototype.postUserMessage = function postUserMessageGrouped(
  this: GroupRuntime,
  input: Parameters<GroupRuntime["postUserMessage"]>[0],
) {
  const self = this as unknown as RuntimeInternals;
  let changed = false;
  for (const [sessionId, wake] of [...self.gated]) {
    if (wake.groupId !== input.groupId) continue;
    self.gated.delete(sessionId);
    changed = true;
    self.runtime
      .abort(sessionId)
      .catch((error: unknown) => console.warn("[modus] group supersede abort failed:", error));
  }
  for (const sessionId of [...self.awaitingUser.keys()]) {
    if (getAgentGroupForSession(sessionId)?.id !== input.groupId) continue;
    self.awaitingUser.delete(sessionId);
    changed = true;
  }
  if (changed) self.emitActivity(input.groupId);
  return originalPostUserMessage.call(this, input);
};

/** Import this module for its side effect (prototype patch). */
export const groupRuntimeSupersedeApplied = true;
