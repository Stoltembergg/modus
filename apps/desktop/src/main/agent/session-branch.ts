import type { AgentEvent, GitBranchSummary, SessionBranchState } from "../../shared/contracts";

/**
 * L2: the branch is SESSION state (Debbie / l2-design.md).
 *
 * - The renderer only ever sends a branch NAME. The main process validates it against
 *   `git branch` / `git worktree list` (listBranches) and the working dir is always the
 *   session's own cwd from the session record: never a path from the renderer.
 * - A switch is refused while a run is active ("Disponível quando o agente terminar") and
 *   while the worktree has uncommitted changes (checkoutBranch refuses; no `-f`, no stash).
 * - A successful switch records the branch on the session and logs the timeline event
 *   "Branch alterada para X"; the next run picks it up.
 * - Each run snapshots its branch at start (frozen) and the agent gets the fixed context line
 *   "Branch atual: X".
 * - A saved branch that no longer exists blocks the next send until another is chosen.
 */

export const BRANCH_BUSY_MESSAGE = "Disponível quando o agente terminar";

export type SessionBranchRecord = { id: string; cwd: string };

export type SessionBranchDeps = {
  getSession(sessionId: string): SessionBranchRecord | undefined;
  /** A run (or a streaming / compacting turn) is in progress for the session. */
  isRunActive(sessionId: string): boolean;
  getSavedBranch(sessionId: string): string | undefined;
  saveBranch(sessionId: string, branch: string): void;
  listBranches(cwd: string): Promise<GitBranchSummary>;
  /** `git switch` without force; throws on uncommitted changes. */
  checkout(
    cwd: string,
    name: string,
  ): Promise<{ kind?: "ok" | "worktree"; worktreePath?: string; branch?: string }>;
  /** Persisted + broadcast timeline event. */
  emit(event: AgentEvent): void;
};

export type RunBranchSnapshot = Readonly<{ branch: string }>;

export class SessionBranchError extends Error {
  constructor(
    readonly code: "busy" | "unknown_branch" | "missing_branch" | "no_session" | "worktree",
    message: string,
    readonly worktreePath?: string,
  ) {
    super(message);
    this.name = "SessionBranchError";
  }
}

/** Fixed context line injected into each run's model prompt (not into the visible message). */
export function branchContextLine(snapshot: RunBranchSnapshot): string {
  return `Branch atual: ${snapshot.branch}`;
}

export function missingBranchMessage(branch: string): string {
  return `A branch "${branch}" não existe mais. Escolha outra branch antes de enviar.`;
}

function requireSession(deps: SessionBranchDeps, sessionId: string): SessionBranchRecord {
  const session = deps.getSession(sessionId);
  if (!session) throw new SessionBranchError("no_session", "Sessão não encontrada.");
  return session;
}

/** What the composer shows: the saved branch (or the repo's current one) and whether it exists. */
export async function readSessionBranchState(
  deps: SessionBranchDeps,
  sessionId: string,
): Promise<SessionBranchState> {
  const session = requireSession(deps, sessionId);
  const summary = await deps.listBranches(session.cwd);
  const saved = deps.getSavedBranch(sessionId);
  const branch = saved ?? summary.current;
  const exists = branch === undefined || summary.local.some((b) => b.name === branch);
  return {
    ...(branch !== undefined ? { branch } : {}),
    ...(summary.current !== undefined ? { current: summary.current } : {}),
    exists,
    running: deps.isRunActive(sessionId),
  };
}

/** Switch the session to an existing LOCAL branch (validated by name, cwd from the record). */
export async function switchSessionBranch(
  deps: SessionBranchDeps,
  sessionId: string,
  requested: string,
): Promise<SessionBranchState> {
  const session = requireSession(deps, sessionId);
  if (deps.isRunActive(sessionId)) throw new SessionBranchError("busy", BRANCH_BUSY_MESSAGE);
  const name = requested.trim();
  const summary = await deps.listBranches(session.cwd);
  const target = summary.local.find((b) => b.name === name);
  if (!target) {
    throw new SessionBranchError(
      "unknown_branch",
      `Branch "${name}" não encontrada neste repositório.`,
    );
  }
  if (target.worktreePath) {
    // Checked out in another linked worktree: the session's cwd cannot move there.
    throw new SessionBranchError(
      "worktree",
      `A branch "${name}" está aberta em outro worktree: ${target.worktreePath}`,
      target.worktreePath,
    );
  }
  if (summary.current !== name) {
    const result = await deps.checkout(session.cwd, name);
    if (result.kind === "worktree") {
      throw new SessionBranchError(
        "worktree",
        `A branch "${name}" está aberta em outro worktree.`,
        result.worktreePath,
      );
    }
  }
  // Re-check: a run may have started while git was switching.
  if (deps.isRunActive(sessionId)) throw new SessionBranchError("busy", BRANCH_BUSY_MESSAGE);
  const previous = deps.getSavedBranch(sessionId) ?? summary.current;
  deps.saveBranch(sessionId, name);
  if (previous !== name) {
    deps.emit({ type: "session.branch_changed", sessionId, branch: name });
  }
  return { branch: name, current: name, exists: true, running: false };
}

/**
 * Called once at the start of a run, before it is created. Returns the frozen snapshot (or
 * undefined for a detached HEAD / non-git cwd). A saved branch that no longer exists throws
 * (missing_branch) so the send is refused until the user chooses another branch. When the
 * repo moved to another branch outside the session (e.g. the Changes panel), the session
 * adopts the real HEAD and logs it, so the agent is never told a branch it is not on.
 */
export async function snapshotRunBranch(
  deps: SessionBranchDeps,
  sessionId: string,
): Promise<RunBranchSnapshot | undefined> {
  const session = requireSession(deps, sessionId);
  let summary: GitBranchSummary;
  try {
    summary = await deps.listBranches(session.cwd);
  } catch {
    return undefined;
  }
  const saved = deps.getSavedBranch(sessionId);
  if (saved !== undefined && !summary.local.some((b) => b.name === saved)) {
    throw new SessionBranchError("missing_branch", missingBranchMessage(saved));
  }
  const current = summary.current;
  if (current === undefined) return undefined;
  if (saved !== current) {
    deps.saveBranch(sessionId, current);
    if (saved !== undefined)
      deps.emit({ type: "session.branch_changed", sessionId, branch: current });
  }
  return Object.freeze({ branch: current });
}
