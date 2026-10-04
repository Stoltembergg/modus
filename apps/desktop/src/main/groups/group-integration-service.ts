import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { BrowserWindow } from "electron";
import type { AgentEvent, GroupTask, SubagentWorktreeInfo } from "../../shared/contracts";
import { evaluateGroupTaskGate } from "../../shared/group-task-policy";
import type {
  GroupIntegrationPreview,
  GroupIntegrationRecord,
  GroupIntegrationState,
} from "../../shared/group-work-state";
import { getAgentSession } from "../agent/agent-store";
import { getDatabase } from "../db/database";
import { resolveRepo } from "../git/git-repo";
import {
  abortSubagentWorktreeApply,
  applySubagentWorktree,
  type GroupIntegrationGitSnapshot,
  inspectGroupIntegrationApply,
  inspectGroupIntegrationGitState,
} from "../git/git-service";
import { IPC_CHANNELS } from "../ipc/channels";
import { requestPermission } from "../permissions/permission-broker";
import { GroupStoreError, getAgentGroup } from "./group-store";
import { getGroupTaskSourcePath, resolveGroupTaskEvidence } from "./group-task-evidence";
import {
  beginGroupTaskIntegrationApply,
  completeGroupTaskIntegrationAbort,
  getGroupIntegrationPreview,
  getGroupTask,
  getGroupTaskIntegrationRecord,
  listGroupTaskIntegrationRecords,
  persistGroupIntegrationPreview,
  reconcileGroupTaskIntegration,
  recordGroupTaskIntegrationConflict,
} from "./group-task-store";

type PermissionResult = Awaited<ReturnType<typeof requestPermission>>;
type PermissionRequest = Parameters<typeof requestPermission>[0];

export type GroupIntegrationGit = {
  inspectGroupIntegrationGitState: typeof inspectGroupIntegrationGitState;
  inspectGroupIntegrationApply: typeof inspectGroupIntegrationApply;
  applySubagentWorktree: typeof applySubagentWorktree;
  abortSubagentWorktreeApply: typeof abortSubagentWorktreeApply;
};

export type GroupIntegrationServiceDependencies = {
  requestPermission?: (input: PermissionRequest) => Promise<Pick<PermissionResult, "decision">>;
  emitPermissionEvent?: (event: AgentEvent) => void;
  git?: Partial<GroupIntegrationGit>;
};

type IntegrationContext = {
  task: GroupTask;
  ownerSessionId: string;
  sourcePath: string;
  sourceWorktree: SubagentWorktreeInfo;
  targetPath: string;
  workspaceId: string;
  targetRepoKey: string;
};

type VerifiedState = IntegrationContext & {
  task: GroupTask;
  git: GroupIntegrationGitSnapshot;
};

const locks = new Map<string, Promise<void>>();

async function withRepositoryLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = previous.then(() => turn);
  locks.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function pathWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function requireExistingPath(path: string, description: string): string {
  if (!existsSync(path)) throw new GroupStoreError("invalid-value", `${description} is missing.`);
  try {
    return realpathSync(path);
  } catch {
    throw new GroupStoreError("invalid-value", `${description} is unavailable.`);
  }
}

function emitPermissionEvent(event: AgentEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.agentEvent, event);
  }
}

function resolveWorkspaceRoot(workspaceId: string | undefined): string {
  if (!workspaceId)
    throw new GroupStoreError("workspace-not-found", "Group has no Git Project workspace.");
  const row = getDatabase()
    .prepare("select root_path from workspaces where id = ?")
    .get(workspaceId) as { root_path: string } | undefined;
  if (!row?.root_path)
    throw new GroupStoreError("workspace-not-found", "Group Project workspace was not found.");
  return requireExistingPath(row.root_path, "Group Project workspace");
}

function findFormerOwnerSession(task: GroupTask, branch: string): string | undefined {
  const group = getAgentGroup(task.groupId);
  if (!group?.workspaceId) return undefined;
  const rows = getDatabase()
    .prepare(`select id from agent_sessions where workspace_id = ?
      and subagent_worktree_branch = ? and subagent_worktree_path is not null`)
    .all(group.workspaceId, branch) as Array<{ id: string }>;
  return rows.length === 1 ? rows[0]?.id : undefined;
}

function resolveContext(
  taskId: string,
  options: { preview?: GroupIntegrationPreview; allowFormerOwner?: boolean } = {},
): IntegrationContext {
  const task = getGroupTask(taskId);
  const group = getAgentGroup(task.groupId);
  if (!group)
    throw new GroupStoreError("group-not-found", `Agent group not found: ${task.groupId}`);
  const targetPath = resolveWorkspaceRoot(group.workspaceId);
  const sourceBranch = options.preview?.sourceBranch ?? task.branch;
  if (!sourceBranch?.startsWith(`group/${task.groupId}/`))
    throw new GroupStoreError("invalid-value", "Task does not own a Group member branch.");
  let ownerSessionId = task.ownerSessionId;
  if (
    (!ownerSessionId || options.preview?.sourceBranch !== undefined) &&
    options.allowFormerOwner
  ) {
    ownerSessionId = findFormerOwnerSession(task, sourceBranch);
  }
  if (!ownerSessionId)
    throw new GroupStoreError("not-owner", "Task owner and source worktree are unavailable.");
  if (!options.allowFormerOwner) {
    const member = getDatabase()
      .prepare("select 1 from agent_group_members where group_id = ? and session_id = ?")
      .get(task.groupId, ownerSessionId);
    if (!member || task.ownerSessionId !== ownerSessionId)
      throw new GroupStoreError(
        "not-owner",
        "Only the current task owner may integrate its branch.",
      );
  }
  const session = getAgentSession(ownerSessionId);
  const worktree = session?.subagentWorktree;
  if (!session || !worktree || worktree.branch !== sourceBranch)
    throw new GroupStoreError(
      "invalid-value",
      "The task owner's registered Group worktree is unavailable.",
    );
  if (!task.branch || task.branch !== sourceBranch)
    throw new GroupStoreError("stale-task", "Task branch no longer matches its owner worktree.");
  if (worktree.integrationStatus === "cleaned")
    throw new GroupStoreError("invalid-value", "Task source worktree has already been cleaned up.");
  const sourcePath = options.allowFormerOwner ? session.cwd : getGroupTaskSourcePath(task);
  if (!sourcePath)
    throw new GroupStoreError("invalid-value", "Task source worktree is unavailable.");
  const sourceRoot = requireExistingPath(worktree.path, "Task source worktree");
  const sourceCwd = requireExistingPath(sourcePath, "Task source directory");
  if (!pathWithin(sourceRoot, sourceCwd) && sourceRoot !== sourceCwd)
    throw new GroupStoreError(
      "invalid-value",
      "Task owner cwd is outside its registered worktree.",
    );
  const sourceRepo = resolveRepo(sourceRoot);
  const targetRepo = resolveRepo(targetPath);
  if (!sourceRepo || !targetRepo || sourceRepo.root !== sourceRoot)
    throw new GroupStoreError(
      "invalid-value",
      "Task source or Group target is not a Git worktree root.",
    );
  if (sourceRepo.commonGitDir !== targetRepo.commonGitDir)
    throw new GroupStoreError(
      "invalid-value",
      "Task branch is outside the Group Project repository.",
    );
  const managedRoot = requireExistingPath(
    resolve(targetRepo.root, ".modus", "worktrees"),
    "Managed Group worktrees",
  );
  if (!pathWithin(managedRoot, sourceRoot))
    throw new GroupStoreError(
      "invalid-value",
      "Task source is outside the Group's managed worktree directory.",
    );
  return {
    task,
    ownerSessionId,
    sourcePath: sourceRoot,
    sourceWorktree: worktree,
    targetPath,
    workspaceId: group.workspaceId ?? "",
    targetRepoKey: sourceRepo.commonGitDir,
  };
}

function requireCleanIntegrationState(state: GroupIntegrationGitSnapshot): void {
  if (state.sourceMergeHead)
    throw new GroupStoreError("invalid-transition", "Task source has a pending Git merge.");
  if (state.targetMergeHead)
    throw new GroupStoreError(
      "invalid-transition",
      "Group Project has an unrelated pending Git merge.",
    );
  if (state.sourceStatus.length > 0)
    throw new GroupStoreError(
      "invalid-transition",
      "Task source has uncommitted changes. Finalize the branch through an explicit authorized Git action before previewing integration.",
    );
  if (state.targetStatus.length > 0)
    throw new GroupStoreError(
      "invalid-transition",
      "Group Project target must be clean before integration.",
    );
}

function requireTaskGate(task: GroupTask, sourceFingerprint: string): void {
  if (task.status !== "done")
    throw new GroupStoreError("invalid-transition", "Only a completed task can be integrated.");
  const gate = evaluateGroupTaskGate(resolveGroupTaskEvidence(task, sourceFingerprint));
  if (!gate.satisfied)
    throw new GroupStoreError(
      "verification-required",
      `Task ${task.id} is not ready for integration: ${gate.reasonCodes.join(", ")}.`,
    );
}

function samePreviewState(
  preview: GroupIntegrationPreview,
  state: GroupIntegrationGitSnapshot,
): boolean {
  return (
    preview.sourceBranch === state.sourceBranch &&
    preview.sourceSha === state.sourceSha &&
    preview.sourceFingerprint === state.sourceFingerprint &&
    preview.targetBranch === state.targetBranch &&
    preview.targetSha === state.targetSha &&
    preview.targetFingerprint === state.targetFingerprint
  );
}

function integrationGitInput(context: IntegrationContext, preview?: GroupIntegrationPreview) {
  return {
    sourcePath: context.sourcePath,
    targetPath: context.targetPath,
    expectedSourceBranch: preview?.sourceBranch ?? context.sourceWorktree.branch,
    ...(preview?.targetBranch ? { expectedTargetBranch: preview.targetBranch } : {}),
  };
}

export class GroupIntegrationService {
  private readonly permission: NonNullable<
    GroupIntegrationServiceDependencies["requestPermission"]
  >;
  private readonly emit: (event: AgentEvent) => void;
  private readonly git: GroupIntegrationGit;
  private readonly integrationChangedListeners = new Set<
    (record: GroupIntegrationRecord) => void
  >();

  constructor(dependencies: GroupIntegrationServiceDependencies = {}) {
    this.permission = dependencies.requestPermission ?? requestPermission;
    this.emit = dependencies.emitPermissionEvent ?? emitPermissionEvent;
    this.git = {
      inspectGroupIntegrationGitState,
      inspectGroupIntegrationApply,
      applySubagentWorktree,
      abortSubagentWorktreeApply,
      ...dependencies.git,
    };
  }

  onIntegrationChanged(listener: (record: GroupIntegrationRecord) => void): () => void {
    this.integrationChangedListeners.add(listener);
    return () => this.integrationChangedListeners.delete(listener);
  }

  getIntegrationState(taskId: string): GroupIntegrationState {
    return getGroupTaskIntegrationState(taskId);
  }

  async refreshGroupTaskIntegrationState(taskId: string): Promise<GroupIntegrationState> {
    const latest = getGroupTaskIntegrationRecord(taskId);
    if (latest?.status !== "applying") return getGroupTaskIntegrationState(taskId);
    const preview = getGroupIntegrationPreview(taskId, latest.previewId);
    if (!preview)
      throw new GroupStoreError("invalid-value", "Applying integration lost its preview.");
    const context = resolveContext(taskId, { preview, allowFormerOwner: true });

    return await withRepositoryLock(context.targetRepoKey, async () => {
      const current = getGroupTaskIntegrationRecord(taskId);
      if (!current || current.id !== latest.id || current.status !== "applying")
        return getGroupTaskIntegrationState(taskId);
      const currentPreview = getGroupIntegrationPreview(taskId, current.previewId);
      if (!currentPreview)
        throw new GroupStoreError("invalid-value", "Applying integration lost its preview.");
      const currentContext = resolveContext(taskId, {
        preview: currentPreview,
        allowFormerOwner: true,
      });
      if (currentContext.targetRepoKey !== context.targetRepoKey)
        return getGroupTaskIntegrationState(taskId);

      await this.recoverApplying(currentContext, currentPreview, current);
      return getGroupTaskIntegrationState(taskId);
    });
  }

  private publishIntegrationChange(record: GroupIntegrationRecord): GroupIntegrationRecord {
    for (const listener of this.integrationChangedListeners) {
      try {
        listener(record);
      } catch {
        // A renderer event listener cannot change the durable Git operation result.
      }
    }
    return record;
  }

  async previewGroupTaskIntegration(taskId: string): Promise<GroupIntegrationPreview> {
    const initial = resolveContext(taskId);
    return await withRepositoryLock(initial.targetRepoKey, async () => {
      const context = resolveContext(taskId);
      await this.recoverLatestApplying(context);
      const verified = await this.readVerifiedState(context);
      const confirm = await this.git.inspectGroupIntegrationGitState(integrationGitInput(verified));
      requireCleanIntegrationState(confirm);
      if (!samePreviewStateFromSnapshot(verified.git, confirm))
        throw new GroupStoreError(
          "stale-evidence",
          "Git state changed while preparing the preview; request a new preview.",
        );
      const task = getGroupTask(taskId);
      if ((task.stateVersion ?? 1) !== (verified.task.stateVersion ?? 1))
        throw new GroupStoreError(
          "stale-task",
          "Task changed while preparing the integration preview.",
        );
      requireTaskGate(task, confirm.sourceFingerprint);
      const preview: GroupIntegrationPreview = {
        id: crypto.randomUUID(),
        groupId: task.groupId,
        taskId: task.id,
        taskVersion: task.stateVersion ?? 1,
        sourceBranch: confirm.sourceBranch,
        sourceSha: confirm.sourceSha,
        sourceFingerprint: confirm.sourceFingerprint,
        targetBranch: confirm.targetBranch,
        targetSha: confirm.targetSha,
        targetFingerprint: confirm.targetFingerprint,
        commits: confirm.commits,
        omittedCommitCount: confirm.omittedCommitCount,
        changedFiles: confirm.changedFiles,
        omittedChangedFileCount: confirm.omittedChangedFileCount,
        diffSummary: confirm.diffSummary.slice(0, 32_768),
        createdAt: new Date().toISOString(),
        status:
          confirm.commits.length === 0 && confirm.changedFiles.length === 0
            ? "no_changes"
            : "ready",
      };
      this.publishIntegrationChange(persistGroupIntegrationPreview(preview));
      return preview;
    });
  }

  async applyGroupTaskIntegration(input: {
    taskId: string;
    previewId: string;
    confirmedByUser: true;
  }): Promise<GroupIntegrationRecord> {
    if (input.confirmedByUser !== true)
      throw new GroupStoreError("invalid-value", "Explicit user confirmation is required.");
    const preview = getGroupIntegrationPreview(input.taskId, input.previewId);
    if (!preview)
      throw new GroupStoreError("stale-task", "Integration preview is missing or expired.");
    const initial = resolveContext(input.taskId, { preview });
    return await withRepositoryLock(initial.targetRepoKey, async () => {
      let record = getGroupTaskIntegrationRecord(input.taskId, input.previewId);
      if (!record) throw new GroupStoreError("stale-task", "Integration record is missing.");
      if (record.status === "applying") {
        const context = resolveContext(input.taskId, { preview, allowFormerOwner: true });
        record = await this.recoverApplying(context, preview, record);
      }
      if (
        record.status === "applied" ||
        record.status === "conflict" ||
        record.status === "no_changes"
      )
        return record;
      if (record.status === "aborted")
        throw new GroupStoreError(
          "stale-task",
          "This preview was already aborted; request a new preview.",
        );
      if (record.status !== "ready")
        throw new GroupStoreError("invalid-transition", `Integration is ${record.status}.`);

      const beforePermission = await this.readVerifiedPreview(input.taskId, preview);
      const permission = await this.requestGitWrite(
        beforePermission.ownerSessionId,
        input.taskId,
        preview.sourceBranch,
        preview.targetBranch,
        "Apply the confirmed Group task branch to the Group Project as a no-commit merge.",
      );
      if (permission.decision === "deny")
        throw new GroupStoreError("permission-denied", "Git integration was denied by the user.");

      // Permission is a wait boundary. Reload every mutable input before persisting intent.
      const fresh = await this.readVerifiedPreview(input.taskId, preview);
      record = beginGroupTaskIntegrationApply(
        input.taskId,
        input.previewId,
        preview.taskVersion,
        record.version,
      );
      if (record.status !== "applying")
        throw new GroupStoreError("invalid-transition", "Could not persist Git apply intent.");
      this.publishIntegrationChange(record);

      try {
        const result = await this.git.applySubagentWorktree(
          fresh.targetPath,
          fresh.sourceWorktree,
          {
            sourceSha: preview.sourceSha,
            targetSha: preview.targetSha,
            targetBranch: preview.targetBranch,
          },
        );
        const actual = await this.git.inspectGroupIntegrationApply({
          targetPath: fresh.targetPath,
          sourceBranch: preview.sourceBranch,
          sourceSha: preview.sourceSha,
          targetBranch: preview.targetBranch,
          targetSha: preview.targetSha,
        });
        if (!actual.ownedPendingMerge || actual.mergeHeadSha !== preview.sourceSha)
          throw new GroupStoreError(
            "invalid-transition",
            "Git apply result is not owned by this task integration.",
          );
        if (result.integrationStatus === "conflict") {
          if (actual.conflictFiles.length === 0)
            throw new GroupStoreError(
              "invalid-transition",
              "Git reported a conflict without unmerged files.",
            );
          const currentTask = getGroupTask(input.taskId);
          return this.publishIntegrationChange(
            recordGroupTaskIntegrationConflict({
              taskId: input.taskId,
              previewId: input.previewId,
              expectedTaskVersion: currentTask.stateVersion ?? 1,
              expectedRecordVersion: record.version,
              mergeHeadSha: actual.mergeHeadSha,
              conflictFiles: actual.conflictFiles,
            }).record,
          );
        }
        if (actual.conflictFiles.length > 0)
          throw new GroupStoreError(
            "invalid-transition",
            "Git apply left conflicts but did not report them.",
          );
        return this.publishIntegrationChange(
          reconcileGroupTaskIntegration(input.taskId, input.previewId, record.version, {
            status: "applied",
            mergeHeadSha: actual.mergeHeadSha,
            details: { kind: "no_commit_merge_applied" },
          }),
        );
      } catch (error) {
        try {
          const recovered = await this.recoverApplying(
            resolveContext(input.taskId, { preview, allowFormerOwner: true }),
            preview,
            getGroupTaskIntegrationRecord(input.taskId, input.previewId) ?? record,
          );
          if (recovered.status === "applied" || recovered.status === "conflict") return recovered;
          if (recovered.status === "ready") throw error;
        } catch (recoveryError) {
          if (recoveryError === error) throw error;
          throw new GroupStoreError(
            "invalid-transition",
            `Integration remains applying because Git ownership could not be established: ${String(recoveryError)}`,
          );
        }
        throw error;
      }
    });
  }

  async abortGroupTaskIntegration(taskId: string): Promise<GroupIntegrationRecord> {
    const latest = getGroupTaskIntegrationRecord(taskId);
    if (!latest)
      throw new GroupStoreError("task-not-found", "No integration record exists for this task.");
    const preview = getGroupIntegrationPreview(taskId, latest.previewId);
    if (!preview)
      throw new GroupStoreError("invalid-value", "Integration preview history is unavailable.");
    const initial = resolveContext(taskId, { preview, allowFormerOwner: true });
    return await withRepositoryLock(initial.targetRepoKey, async () => {
      let record = getGroupTaskIntegrationRecord(taskId, preview.id);
      if (!record) throw new GroupStoreError("task-not-found", "Integration record not found.");
      if (record.status === "applying")
        record = await this.recoverApplying(initial, preview, record);
      if (record.status === "aborted") return record;
      if (record.status !== "applied" && record.status !== "conflict")
        throw new GroupStoreError(
          "invalid-transition",
          "There is no applied or conflicted integration to abort.",
        );

      const before = await this.inspectAbortState(initial, preview);
      if (!before.ownedPendingMerge && !before.alreadyAborted)
        throw new GroupStoreError(
          "invalid-transition",
          "The pending Git merge is unrelated or cannot be safely aborted.",
        );
      const permission = await this.requestGitWrite(
        initial.ownerSessionId,
        taskId,
        preview.sourceBranch,
        preview.targetBranch,
        "Abort the no-commit Group task integration merge.",
      );
      if (permission.decision === "deny")
        throw new GroupStoreError(
          "permission-denied",
          "Git integration abort was denied by the user.",
        );

      const currentContext = resolveContext(taskId, { preview, allowFormerOwner: true });
      record = getGroupTaskIntegrationRecord(taskId, preview.id) ?? record;
      if (record.status !== "applied" && record.status !== "conflict")
        throw new GroupStoreError(
          "stale-task",
          "Integration changed while permission was pending.",
        );
      const afterPermission = await this.inspectAbortState(currentContext, preview);
      if (afterPermission.ownedPendingMerge) {
        await this.git.abortSubagentWorktreeApply(
          currentContext.targetPath,
          {
            ...currentContext.sourceWorktree,
            integrationStatus: record.status,
            ...(record.conflictFiles ? { conflictFiles: record.conflictFiles } : {}),
          },
          {
            sourceSha: preview.sourceSha,
            targetSha: preview.targetSha,
            targetBranch: preview.targetBranch,
          },
        );
      } else if (!afterPermission.alreadyAborted) {
        throw new GroupStoreError(
          "stale-task",
          "Git state changed while abort permission was pending.",
        );
      }

      const task = getGroupTask(taskId);
      let restoreTask = false;
      if (record.status === "conflict" && task.status === "blocked") {
        try {
          const current = await this.git.inspectGroupIntegrationGitState(
            integrationGitInput(currentContext, preview),
          );
          restoreTask =
            current.sourceSha === preview.sourceSha &&
            current.sourceFingerprint === preview.sourceFingerprint &&
            current.targetBranch === preview.targetBranch &&
            current.targetSha === preview.targetSha &&
            current.targetStatus.length === 0 &&
            !current.targetMergeHead &&
            evaluateGroupTaskGate(resolveGroupTaskEvidence(task, current.sourceFingerprint))
              .satisfied;
        } catch {
          restoreTask = false;
        }
      }
      return this.publishIntegrationChange(
        completeGroupTaskIntegrationAbort({
          taskId,
          previewId: preview.id,
          expectedTaskVersion: task.stateVersion ?? 1,
          expectedRecordVersion: record.version,
          restoreTask,
        }).record,
      );
    });
  }

  private async readVerifiedState(context: IntegrationContext): Promise<VerifiedState> {
    const task = getGroupTask(context.task.id);
    if (task.status !== "done")
      throw new GroupStoreError("invalid-transition", "Only a completed task can be integrated.");
    if (
      task.stateVersion !== context.task.stateVersion ||
      task.ownerSessionId !== context.ownerSessionId ||
      task.branch !== context.sourceWorktree.branch
    )
      throw new GroupStoreError("stale-task", "Task owner, branch or version changed.");
    const git = await this.git.inspectGroupIntegrationGitState(integrationGitInput(context));
    if (git.sourceRoot !== context.sourcePath)
      throw new GroupStoreError(
        "invalid-value",
        "Git resolved the task source outside its registered worktree.",
      );
    const targetRepo = resolveRepo(context.targetPath);
    if (!targetRepo || realpathSync(targetRepo.root) !== git.targetRoot)
      throw new GroupStoreError(
        "invalid-value",
        "Git resolved the Group target outside its trusted workspace.",
      );
    requireCleanIntegrationState(git);
    requireTaskGate(task, git.sourceFingerprint);
    const latestTask = getGroupTask(task.id);
    if (
      latestTask.stateVersion !== task.stateVersion ||
      latestTask.status !== task.status ||
      latestTask.ownerSessionId !== task.ownerSessionId ||
      latestTask.branch !== task.branch
    )
      throw new GroupStoreError(
        "stale-task",
        "Task changed while validating its integration gate.",
      );
    return { ...context, task, git };
  }

  private async readVerifiedPreview(
    taskId: string,
    preview: GroupIntegrationPreview,
  ): Promise<VerifiedState> {
    const persisted = getGroupIntegrationPreview(taskId, preview.id);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(preview))
      throw new GroupStoreError(
        "stale-task",
        "Integration preview identity changed; request a new preview.",
      );
    const context = resolveContext(taskId, { preview });
    const state = await this.readVerifiedState(context);
    if (
      (state.task.stateVersion ?? 1) !== preview.taskVersion ||
      !samePreviewState(preview, state.git)
    )
      throw new GroupStoreError(
        "stale-evidence",
        "Task, source or target changed since preview; request a new preview.",
      );
    return state;
  }

  private async requestGitWrite(
    sessionId: string,
    taskId: string,
    sourceBranch: string,
    targetBranch: string,
    reason: string,
  ): Promise<Pick<PermissionResult, "decision">> {
    return await this.permission({
      sessionId,
      action: "git.write",
      target: `Group task ${taskId}: ${sourceBranch} -> ${targetBranch}`,
      reason,
      emit: this.emit,
    });
  }

  private async recoverLatestApplying(context: IntegrationContext): Promise<void> {
    const records = listGroupTaskIntegrationRecords(context.task.id);
    const latest = records.at(-1);
    if (latest?.status !== "applying") return;
    const preview = getGroupIntegrationPreview(context.task.id, latest.previewId);
    if (!preview)
      throw new GroupStoreError("invalid-value", "Applying integration lost its preview.");
    await this.recoverApplying(
      resolveContext(context.task.id, { preview, allowFormerOwner: true }),
      preview,
      latest,
    );
  }

  private async recoverApplying(
    context: IntegrationContext,
    preview: GroupIntegrationPreview,
    record: GroupIntegrationRecord,
  ): Promise<GroupIntegrationRecord> {
    if (record.status !== "applying") return record;
    const actual = await this.git.inspectGroupIntegrationApply({
      targetPath: context.targetPath,
      sourceBranch: preview.sourceBranch,
      sourceSha: preview.sourceSha,
      targetBranch: preview.targetBranch,
      targetSha: preview.targetSha,
    });
    if (actual.mergeHeadSha) {
      if (!actual.ownedPendingMerge)
        throw new GroupStoreError(
          "invalid-transition",
          "Applying record has an unowned pending Git merge; state is preserved.",
        );
      if (actual.conflictFiles.length > 0) {
        const task = getGroupTask(context.task.id);
        return this.publishIntegrationChange(
          recordGroupTaskIntegrationConflict({
            taskId: context.task.id,
            previewId: preview.id,
            expectedTaskVersion: task.stateVersion ?? 1,
            expectedRecordVersion: record.version,
            mergeHeadSha: actual.mergeHeadSha,
            conflictFiles: actual.conflictFiles,
          }).record,
        );
      }
      return this.publishIntegrationChange(
        reconcileGroupTaskIntegration(context.task.id, preview.id, record.version, {
          status: "applied",
          mergeHeadSha: actual.mergeHeadSha,
          details: { kind: "recovered_owned_pending_merge" },
        }),
      );
    }
    if (actual.committedMergeSha && actual.targetBranch === preview.targetBranch)
      return this.publishIntegrationChange(
        reconcileGroupTaskIntegration(context.task.id, preview.id, record.version, {
          status: "applied",
          mergeHeadSha: preview.sourceSha,
          details: {
            kind: "recovered_committed_source_target_merge",
            mergeCommitSha: actual.committedMergeSha,
          },
        }),
      );
    const current = await this.git.inspectGroupIntegrationGitState(
      integrationGitInput(context, preview),
    );
    if (
      current.sourceSha === preview.sourceSha &&
      current.sourceFingerprint === preview.sourceFingerprint &&
      current.targetBranch === preview.targetBranch &&
      current.targetSha === preview.targetSha &&
      current.targetFingerprint === preview.targetFingerprint &&
      current.sourceStatus.length === 0 &&
      current.targetStatus.length === 0 &&
      !current.sourceMergeHead &&
      !current.targetMergeHead
    )
      return this.publishIntegrationChange(
        reconcileGroupTaskIntegration(context.task.id, preview.id, record.version, {
          status: "ready",
          details: { kind: "recovered_no_git_effect" },
        }),
      );
    throw new GroupStoreError(
      "invalid-transition",
      "Cannot prove whether this integration applied; state is preserved for resolution.",
    );
  }

  private async inspectAbortState(
    context: IntegrationContext,
    preview: GroupIntegrationPreview,
  ): Promise<{ ownedPendingMerge: boolean; alreadyAborted: boolean }> {
    const state = await this.git.inspectGroupIntegrationApply({
      targetPath: context.targetPath,
      sourceBranch: preview.sourceBranch,
      sourceSha: preview.sourceSha,
      targetBranch: preview.targetBranch,
      targetSha: preview.targetSha,
    });
    if (state.ownedPendingMerge && state.mergeHeadSha === preview.sourceSha)
      return { ownedPendingMerge: true, alreadyAborted: false };
    if (
      !state.mergeHeadSha &&
      !state.committedMergeSha &&
      state.targetBranch === preview.targetBranch &&
      state.targetSha === preview.targetSha &&
      state.targetStatus.length === 0
    )
      return { ownedPendingMerge: false, alreadyAborted: true };
    return { ownedPendingMerge: false, alreadyAborted: false };
  }
}

function samePreviewStateFromSnapshot(
  left: GroupIntegrationGitSnapshot,
  right: GroupIntegrationGitSnapshot,
): boolean {
  return (
    left.sourceBranch === right.sourceBranch &&
    left.sourceSha === right.sourceSha &&
    left.sourceFingerprint === right.sourceFingerprint &&
    left.targetBranch === right.targetBranch &&
    left.targetSha === right.targetSha &&
    left.targetFingerprint === right.targetFingerprint &&
    left.sourceStatus.length === right.sourceStatus.length &&
    left.targetStatus.length === right.targetStatus.length &&
    left.sourceMergeHead === right.sourceMergeHead &&
    left.targetMergeHead === right.targetMergeHead
  );
}

let defaultService: GroupIntegrationService | undefined;

function getDefaultService(): GroupIntegrationService {
  defaultService ??= new GroupIntegrationService();
  return defaultService;
}

export function createGroupIntegrationService(
  dependencies: GroupIntegrationServiceDependencies = {},
): GroupIntegrationService {
  return new GroupIntegrationService(dependencies);
}

/** Read only the latest persisted record and its matching immutable preview. */
export function getGroupTaskIntegrationState(taskId: string): GroupIntegrationState {
  const record = getGroupTaskIntegrationRecord(taskId);
  if (!record) return {};
  const preview = getGroupIntegrationPreview(taskId, record.previewId);
  return { record, ...(preview ? { preview } : {}) };
}

export async function previewGroupTaskIntegration(
  taskId: string,
): Promise<GroupIntegrationPreview> {
  return await getDefaultService().previewGroupTaskIntegration(taskId);
}

export async function applyGroupTaskIntegration(input: {
  taskId: string;
  previewId: string;
  confirmedByUser: true;
}): Promise<GroupIntegrationRecord> {
  return await getDefaultService().applyGroupTaskIntegration(input);
}

export async function abortGroupTaskIntegration(taskId: string): Promise<GroupIntegrationRecord> {
  return await getDefaultService().abortGroupTaskIntegration(taskId);
}
