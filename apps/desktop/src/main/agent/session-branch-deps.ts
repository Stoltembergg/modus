import type { AgentEvent } from "../../shared/contracts";
import { checkoutBranch, listBranches } from "../git/git-service";
import { getActiveAgentRun } from "./agent-run-store";
import { getAgentSession, getAgentSessionBranch, setAgentSessionBranch } from "./agent-store";
import type { SessionBranchDeps } from "./session-branch";

/** Real wiring of the L2 session-branch rules: session record, run store, git. */
export function createSessionBranchDeps(options: {
  emit(event: AgentEvent): void;
  isStreaming?(sessionId: string): boolean;
}): SessionBranchDeps {
  return {
    getSession(sessionId) {
      const session = getAgentSession(sessionId);
      return session ? { id: session.id, cwd: session.cwd } : undefined;
    },
    isRunActive(sessionId) {
      return (
        getActiveAgentRun(sessionId) !== undefined ||
        getAgentSession(sessionId)?.status === "running" ||
        options.isStreaming?.(sessionId) === true
      );
    },
    getSavedBranch: getAgentSessionBranch,
    saveBranch: setAgentSessionBranch,
    listBranches,
    // The session picker is the ONLY switcher that requires a clean tree.
    checkout: (cwd, name) => checkoutBranch(cwd, name, false, { requireClean: true }),
    emit: options.emit,
  };
}
