import { join } from "node:path";
import { app } from "electron";
import { listAgentGroupMemberSessionIds } from "../groups/group-store";
import { denyPendingQuestionRequestsForSession } from "../interaction/question-broker";
import { finalizeProjectMemoryRun } from "../memory/project-memory-service";
import { denyPendingPermissionRequestsForSession } from "../permissions/permission-broker";
import { deleteSessionPlan } from "../plan/plan-store";
import { listAgentRuns } from "./agent-run-store";
import {
  deleteAgentSession,
  getAgentSession,
  listAgentSessions,
  listArchivedAgentSessions,
  listSubagentSessions,
  setAgentSessionArchived,
} from "./agent-store";
import { deleteSessionCheckpoints } from "./checkpoint-service";
import { clearHyperPlanDraftsForSession } from "./harness/hyperplan-draft-store";
import { getAgentRuntime } from "./runtime-registry";

/** Best-effort explicit-close/archive sweep; running and blocked runs are not completion signals. */
function finalizeTerminalProjectMemoryRuns(sessionId: string): void {
  try {
    for (const run of listAgentRuns(sessionId)) {
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        try {
          finalizeProjectMemoryRun({ sessionId, runId: run.id, outcome: run.status });
        } catch {
          console.warn("[modus] Project Memory lifecycle finalization failed.");
        }
      }
    }
  } catch {
    console.warn("[modus] Project Memory lifecycle sweep failed.");
  }
}

/**
 * Fully delete one agent session: stop+drop its live runtime, release the
 * checkpoint keep-alive, cancel any blocked interactive requests, then delete
 * the record (events/runs/checkpoints cascade via FK). This is the single
 * authoritative teardown — reused by single-session delete and by
 * workspace-level "Delete chats" / "Remove project" so they can never leave
 * orphaned runtimes or checkpoints behind.
 */
export async function deleteAgentSessionTree(sessionId: string): Promise<void> {
  for (const child of listSubagentSessions(sessionId)) {
    await deleteAgentSessionTree(child.id);
  }
  await getAgentRuntime().dispose(sessionId);
  finalizeTerminalProjectMemoryRuns(sessionId);
  const session = getAgentSession(sessionId);
  if (session) {
    await deleteSessionCheckpoints(sessionId, session.cwd).catch(() => {});
  }
  denyPendingPermissionRequestsForSession(sessionId, "Session deleted");
  denyPendingQuestionRequestsForSession(sessionId);
  deleteSessionPlan(join(app.getPath("userData"), "plans"), sessionId);
  try {
    clearHyperPlanDraftsForSession(sessionId);
  } catch {
    console.warn("[modus] HyperPlan session draft cleanup failed.");
  }
  deleteAgentSession(sessionId);
}

export async function setAgentSessionArchivedTree(
  sessionId: string,
  archived: boolean,
): Promise<void> {
  for (const child of listSubagentSessions(sessionId)) {
    await setAgentSessionArchivedTree(child.id, archived);
  }
  if (archived) finalizeTerminalProjectMemoryRuns(sessionId);
  setAgentSessionArchived(sessionId, archived);
}

/**
 * Soft-archive visible root sessions in a workspace, except group members
 * (they live under their group, not in the Project list). Returns the count
 * changed, which matches what the Projects section shows.
 */
export async function archiveWorkspaceSessions(workspaceId: string): Promise<number> {
  const members = new Set(listAgentGroupMemberSessionIds());
  const sessions = listAgentSessions().filter(
    (session) =>
      session.workspaceId === workspaceId && !session.parentSessionId && !members.has(session.id),
  );
  for (const session of sessions) {
    await setAgentSessionArchivedTree(session.id, true);
  }
  return sessions.length;
}

/**
 * Permanently delete a workspace's root sessions (live and archived). Group
 * members are skipped unless `includeGroupMembers` is set, which only
 * "Remove project" does (it takes everything). Returns the count removed.
 */
export async function deleteWorkspaceSessions(
  workspaceId: string,
  options: { includeGroupMembers?: boolean } = {},
): Promise<number> {
  const members = options.includeGroupMembers
    ? new Set<string>()
    : new Set(listAgentGroupMemberSessionIds());
  const sessions = [...listAgentSessions(), ...listArchivedAgentSessions(workspaceId)].filter(
    (session) =>
      session.workspaceId === workspaceId && !session.parentSessionId && !members.has(session.id),
  );
  for (const session of sessions) {
    await deleteAgentSessionTree(session.id);
  }
  return sessions.length;
}
