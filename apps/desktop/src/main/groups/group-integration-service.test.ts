import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let userData: string;
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase } = await import("../db/database");
const { createAgentSessionRecord, updateAgentSessionWorktree } = await import(
  "../agent/agent-store"
);
const { createAgentGroup, addAgentGroupMember, updateGroupTask } = await import("./group-store");
const { createGroupTask, getGroupTask } = await import("./group-task-store");
const {
  beginGroupTaskIntegrationApply,
  getGroupTaskIntegrationRecord,
  listGroupTaskIntegrationRecords,
  reconcileGroupTaskIntegration,
  recordGroupTaskIntegrationConflict,
} = await import("./group-task-store");
const { createGroupIntegrationService } = await import("./group-integration-service");
const git = promisify(execFile);

type IntegrationGit = {
  applySubagentWorktree: (
    ...args: Parameters<typeof import("../git/git-service").applySubagentWorktree>
  ) => ReturnType<typeof import("../git/git-service").applySubagentWorktree>;
};

type Fixture = {
  root: string;
  source: string;
  groupId: string;
  taskId: string;
  ownerSessionId: string;
  sourceBranch: string;
  sourceSha: string;
  targetSha: string;
};

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-group-integration-"));
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true });
});

async function gitAt(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await git("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

async function fixture(options: { conflict?: boolean; gated?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(userData, "repo-"));
  const source = join(root, ".modus", "worktrees", "group-owner");
  await gitAt(root, ["init", "-b", "main"]);
  await gitAt(root, ["config", "user.email", "test@example.com"]);
  await gitAt(root, ["config", "user.name", "Modus Test"]);
  await writeFile(join(root, "shared.txt"), "base\n");
  await gitAt(root, ["add", "shared.txt"]);
  await gitAt(root, ["commit", "-m", "base"]);
  await writeFile(join(root, ".git", "info", "exclude"), ".modus/worktrees/\n");

  const db = getDatabase();
  const workspaceId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "insert into workspaces (id, root_path, display_name, last_opened_at, created_at) values (?, ?, ?, ?, ?)",
  ).run(workspaceId, root, workspaceId, now, now);
  const group = createAgentGroup({ name: workspaceId, workspaceId });
  const ownerSessionId = `${workspaceId}-owner`;
  createAgentSessionRecord({
    id: ownerSessionId,
    workspaceId,
    title: "Owner",
    cwd: root,
  });
  addAgentGroupMember({ groupId: group.id, sessionId: ownerSessionId });

  const sourceBranch = `group/${group.id}/owner`;
  await gitAt(root, ["worktree", "add", "-b", sourceBranch, source, "HEAD"]);
  if (options.conflict) {
    await writeFile(join(root, "shared.txt"), "target change\n");
    await gitAt(root, ["add", "shared.txt"]);
    await gitAt(root, ["commit", "-m", "target change"]);
    await writeFile(join(source, "shared.txt"), "source change\n");
  } else {
    await writeFile(join(source, "shared.txt"), "source change\n");
  }
  await gitAt(source, ["add", "shared.txt"]);
  await gitAt(source, ["commit", "-m", "source change"]);
  const sourceSha = await gitAt(source, ["rev-parse", "HEAD"]);
  const baseSha = await gitAt(source, ["rev-parse", "HEAD^"]);
  updateAgentSessionWorktree(
    ownerSessionId,
    { path: source, branch: sourceBranch, baseSha, integrationStatus: "running" },
    { cwd: source },
  );

  const task = createGroupTask({
    groupId: group.id,
    title: "Integrate change",
    status: "done",
    ownerSessionId,
    branch: sourceBranch,
    kind: "code",
    priority: "normal",
    dependencyIds: [],
    criteria: options.gated
      ? [{ id: "tests", description: "Tests pass", requiredCheckKinds: ["tests"] }]
      : [],
    verificationPolicy: options.gated
      ? { mode: "required", requireReview: false }
      : { mode: "none", requireReview: false },
  });

  return {
    root,
    source,
    groupId: group.id,
    taskId: task.id,
    ownerSessionId,
    sourceBranch,
    sourceSha,
    targetSha: await gitAt(root, ["rev-parse", "HEAD"]),
  };
}

async function cleanup(f: Fixture): Promise<void> {
  await gitAt(f.root, ["merge", "--abort"]).catch(() => undefined);
  await gitAt(f.root, ["worktree", "remove", "--force", f.source]).catch(() => undefined);
  await rm(f.root, { recursive: true, force: true });
}

function service(
  overrides: {
    decision?: "allow-once" | "allow-workspace" | "deny";
    git?: Partial<IntegrationGit>;
    onPermission?: (input: {
      sessionId: string;
      action: string;
      target: string;
    }) => void | Promise<void>;
  } = {},
) {
  const requestPermission = vi.fn(
    async (input: { sessionId: string; action: string; target: string }) => {
      await overrides.onPermission?.(input);
      return { decision: overrides.decision ?? "allow-once" };
    },
  );
  return {
    integration: createGroupIntegrationService({
      requestPermission,
      ...(overrides.git ? { git: overrides.git } : {}),
    }),
    requestPermission,
  };
}

describe("group task branch integration", () => {
  it("publishes each durable integration record version", async () => {
    const f = await fixture();
    try {
      const s = service();
      const changes: Array<{ status: string; version: number }> = [];
      s.integration.onIntegrationChanged((record) =>
        changes.push({ status: record.status, version: record.version }),
      );

      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      await s.integration.applyGroupTaskIntegration({
        taskId: f.taskId,
        previewId: preview.id,
        confirmedByUser: true,
      });
      await s.integration.abortGroupTaskIntegration(f.taskId);

      expect(changes.map(({ status }) => status)).toEqual([
        "ready",
        "applying",
        "applied",
        "aborted",
      ]);
      expect(changes.map(({ version }) => version)).toEqual([1, 2, 3, 4]);
    } finally {
      await cleanup(f);
    }
  });

  it("recovers an applying merge without creating a newer preview record", async () => {
    const f = await fixture();
    try {
      const s = service();
      const changes: Array<{ status: string; version: number }> = [];
      s.integration.onIntegrationChanged((record) =>
        changes.push({ status: record.status, version: record.version }),
      );
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      const ready = getGroupTaskIntegrationRecord(f.taskId, preview.id);
      expect(ready).toBeDefined();
      const applying = beginGroupTaskIntegrationApply(
        f.taskId,
        preview.id,
        preview.taskVersion,
        ready?.version ?? 0,
      );
      await gitAt(f.root, ["merge", "--no-commit", "--no-ff", f.sourceBranch]);

      const state = await s.integration.refreshGroupTaskIntegrationState(f.taskId);

      expect(state.record).toMatchObject({
        id: applying.id,
        previewId: preview.id,
        status: "applied",
        version: applying.version + 1,
      });
      expect(state.preview).toEqual(preview);
      expect(listGroupTaskIntegrationRecords(f.taskId)).toHaveLength(1);
      expect(changes.at(-1)).toEqual({ status: "applied", version: applying.version + 1 });
      const aborted = await s.integration.abortGroupTaskIntegration(f.taskId);
      expect(aborted.status).toBe("aborted");
    } finally {
      await cleanup(f);
    }
  });

  it.each([
    "applied",
    "conflict",
  ] as const)("reads an existing %s integration without another Git inspection", async (status) => {
    const f = await fixture({ conflict: status === "conflict" });
    try {
      const preview = await service().integration.previewGroupTaskIntegration(f.taskId);
      const ready = getGroupTaskIntegrationRecord(f.taskId, preview.id);
      expect(ready).toBeDefined();
      const applying = beginGroupTaskIntegrationApply(
        f.taskId,
        preview.id,
        preview.taskVersion,
        ready?.version ?? 0,
      );
      const expected =
        status === "applied"
          ? reconcileGroupTaskIntegration(f.taskId, preview.id, applying.version, {
              status: "applied",
              mergeHeadSha: preview.sourceSha,
              details: { kind: "test_recovered_merge" },
            })
          : recordGroupTaskIntegrationConflict({
              taskId: f.taskId,
              previewId: preview.id,
              expectedTaskVersion: preview.taskVersion,
              expectedRecordVersion: applying.version,
              mergeHeadSha: preview.sourceSha,
              conflictFiles: ["shared.txt"],
            }).record;
      const inspectApply = vi.fn();
      const inspectGitState = vi.fn();
      const reader = createGroupIntegrationService({
        git: {
          inspectGroupIntegrationApply: inspectApply,
          inspectGroupIntegrationGitState: inspectGitState,
        },
      });

      const state = await reader.refreshGroupTaskIntegrationState(f.taskId);

      expect(state.record).toEqual(expected);
      expect(inspectApply).not.toHaveBeenCalled();
      expect(inspectGitState).not.toHaveBeenCalled();
    } finally {
      await cleanup(f);
    }
  });

  it("permission_denied_never_applies", async () => {
    const f = await fixture();
    try {
      const apply = vi.fn();
      const s = service({ decision: "deny", git: { applySubagentWorktree: apply } });
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      await expect(
        s.integration.applyGroupTaskIntegration({
          taskId: f.taskId,
          previewId: preview.id,
          confirmedByUser: true,
        }),
      ).rejects.toThrow(/denied|permission/i);
      expect(s.requestPermission).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: f.ownerSessionId, action: "git.write" }),
      );
      expect(apply).not.toHaveBeenCalled();
    } finally {
      await cleanup(f);
    }
  });

  it("permission_timeout_never_applies", async () => {
    const f = await fixture();
    try {
      const apply = vi.fn();
      const requestPermission = vi.fn(async () => {
        throw new Error("permission timed out");
      });
      const integration = createGroupIntegrationService({
        requestPermission,
        git: { applySubagentWorktree: apply },
      });
      const preview = await integration.previewGroupTaskIntegration(f.taskId);
      await expect(
        integration.applyGroupTaskIntegration({
          taskId: f.taskId,
          previewId: preview.id,
          confirmedByUser: true,
        }),
      ).rejects.toThrow(/timed out/i);
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(apply).not.toHaveBeenCalled();
      expect(await gitAt(f.root, ["status", "--porcelain"])).toBe("");
    } finally {
      await cleanup(f);
    }
  });

  it("revalidates_git_after_permission_wait_before_apply", async () => {
    const f = await fixture();
    try {
      const apply = vi.fn();
      const s = service({
        git: { applySubagentWorktree: apply },
        onPermission: async () => {
          await writeFile(join(f.root, "changed-during-permission.txt"), "changed\n");
        },
      });
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      await expect(
        s.integration.applyGroupTaskIntegration({
          taskId: f.taskId,
          previewId: preview.id,
          confirmedByUser: true,
        }),
      ).rejects.toThrow(/target|dirty|clean/i);
      expect(apply).not.toHaveBeenCalled();
      expect(await gitAt(f.root, ["status", "--porcelain"])).toContain(
        "changed-during-permission.txt",
      );
    } finally {
      await cleanup(f);
    }
  });

  it("changed_source_or_target_rejects_preview", async () => {
    const f = await fixture();
    try {
      const s = service();
      const sourcePreview = await s.integration.previewGroupTaskIntegration(f.taskId);
      await writeFile(join(f.source, "later.txt"), "later source edit\n");
      await gitAt(f.source, ["add", "later.txt"]);
      await gitAt(f.source, ["commit", "-m", "move source"]);
      await expect(
        s.integration.applyGroupTaskIntegration({
          taskId: f.taskId,
          previewId: sourcePreview.id,
          confirmedByUser: true,
        }),
      ).rejects.toThrow(/stale|changed|preview/i);

      const targetPreview = await s.integration.previewGroupTaskIntegration(f.taskId);
      await writeFile(join(f.root, "target.txt"), "target movement\n");
      await gitAt(f.root, ["add", "target.txt"]);
      await gitAt(f.root, ["commit", "-m", "move target"]);
      await expect(
        s.integration.applyGroupTaskIntegration({
          taskId: f.taskId,
          previewId: targetPreview.id,
          confirmedByUser: true,
        }),
      ).rejects.toThrow(/stale|changed|preview/i);
    } finally {
      await cleanup(f);
    }
  });

  it("dirty_target_or_pending_merge_rejects_apply", async () => {
    const f = await fixture();
    try {
      const s = service();
      const dirtyPreview = await s.integration.previewGroupTaskIntegration(f.taskId);
      await writeFile(join(f.root, "dirty.txt"), "uncommitted\n");
      await expect(
        s.integration.applyGroupTaskIntegration({
          taskId: f.taskId,
          previewId: dirtyPreview.id,
          confirmedByUser: true,
        }),
      ).rejects.toThrow(/dirty|clean|target/i);
      await rm(join(f.root, "dirty.txt"));

      await gitAt(f.root, ["branch", "foreign-work"]);
      await gitAt(f.root, ["switch", "foreign-work"]);
      await writeFile(join(f.root, "foreign.txt"), "foreign\n");
      await gitAt(f.root, ["add", "foreign.txt"]);
      await gitAt(f.root, ["commit", "-m", "foreign commit"]);
      await gitAt(f.root, ["switch", "main"]);
      await writeFile(join(f.root, "target-only.txt"), "target commit\n");
      await gitAt(f.root, ["add", "target-only.txt"]);
      await gitAt(f.root, ["commit", "-m", "target commit"]);
      await gitAt(f.root, ["merge", "--no-commit", "foreign-work"]);
      await expect(
        s.integration.applyGroupTaskIntegration({
          taskId: f.taskId,
          previewId: dirtyPreview.id,
          confirmedByUser: true,
        }),
      ).rejects.toThrow(/merge|pending|target/i);
    } finally {
      await cleanup(f);
    }
  });

  it("conflict_blocks_task_and_can_abort", async () => {
    const f = await fixture({ conflict: true });
    try {
      const s = service();
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      const record = await s.integration.applyGroupTaskIntegration({
        taskId: f.taskId,
        previewId: preview.id,
        confirmedByUser: true,
      });
      expect(record.status).toBe("conflict");
      expect(record.conflictFiles).toContain("shared.txt");
      expect(getGroupTask(f.taskId).status).toBe("blocked");

      const aborted = await s.integration.abortGroupTaskIntegration(f.taskId);
      expect(aborted.status).toBe("aborted");
      expect(aborted.conflictFiles).toEqual(record.conflictFiles);
      expect(aborted.mergeHeadSha).toBe(record.mergeHeadSha);
      expect(getGroupTask(f.taskId).status).toBe("done");
      expect(await gitAt(f.root, ["rev-parse", "HEAD"])).toBe(f.targetSha);
      expect(await gitAt(f.root, ["status", "--porcelain"])).toBe("");
    } finally {
      await cleanup(f);
    }
  });

  it("abort_conflict_after_source_changes_keeps_task_blocked_for_verification", async () => {
    const f = await fixture({ conflict: true });
    try {
      const s = service();
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      const conflict = await s.integration.applyGroupTaskIntegration({
        taskId: f.taskId,
        previewId: preview.id,
        confirmedByUser: true,
      });
      expect(conflict.status).toBe("conflict");

      await writeFile(join(f.source, "later.txt"), "source changed after conflict\n");
      await gitAt(f.source, ["add", "later.txt"]);
      await gitAt(f.source, ["commit", "-m", "source changed after conflict"]);

      const aborted = await s.integration.abortGroupTaskIntegration(f.taskId);
      expect(aborted.status).toBe("aborted");
      expect(aborted.conflictFiles).toEqual(conflict.conflictFiles);
      expect(getGroupTask(f.taskId).status).toBe("blocked");
      expect(getGroupTask(f.taskId).blockedReason).toMatch(/needs verification/i);
      expect(await gitAt(f.root, ["status", "--porcelain"])).toBe("");
    } finally {
      await cleanup(f);
    }
  });

  it("records_and_aborts_conflict_if_task_state_changes_during_git_apply", async () => {
    const f = await fixture({ conflict: true });
    try {
      const realGit = await import("../git/git-service");
      const apply = vi.fn(async (...args: Parameters<typeof realGit.applySubagentWorktree>) => {
        const result = await realGit.applySubagentWorktree(...args);
        updateGroupTask(f.taskId, { status: "in_progress" });
        return result;
      });
      const s = service({ git: { applySubagentWorktree: apply } });
      const changes: Array<{ status: string; version: number }> = [];
      s.integration.onIntegrationChanged((record) =>
        changes.push({ status: record.status, version: record.version }),
      );
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      const conflict = await s.integration.applyGroupTaskIntegration({
        taskId: f.taskId,
        previewId: preview.id,
        confirmedByUser: true,
      });
      expect(conflict.status).toBe("conflict");
      expect(getGroupTask(f.taskId).status).toBe("in_progress");

      const aborted = await s.integration.abortGroupTaskIntegration(f.taskId);
      expect(aborted.status).toBe("aborted");
      expect(getGroupTask(f.taskId).status).toBe("in_progress");
      expect(await gitAt(f.root, ["status", "--porcelain"])).toBe("");
    } finally {
      await cleanup(f);
    }
  });

  it("apply_retry_does_not_repeat_merge", async () => {
    const f = await fixture();
    try {
      const realGit = await import("../git/git-service");
      const apply = vi.fn(realGit.applySubagentWorktree);
      const s = service({ git: { applySubagentWorktree: apply } });
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      const first = await s.integration.applyGroupTaskIntegration({
        taskId: f.taskId,
        previewId: preview.id,
        confirmedByUser: true,
      });
      const retried = await s.integration.applyGroupTaskIntegration({
        taskId: f.taskId,
        previewId: preview.id,
        confirmedByUser: true,
      });
      expect(first.status).toBe("applied");
      expect(retried).toEqual(first);
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup(f);
    }
  });

  it("applied_is_not_committed_or_pushed", async () => {
    const f = await fixture();
    try {
      const s = service();
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      const record = await s.integration.applyGroupTaskIntegration({
        taskId: f.taskId,
        previewId: preview.id,
        confirmedByUser: true,
      });
      expect(record.status).toBe("applied");
      expect(await gitAt(f.root, ["rev-parse", "HEAD"])).toBe(f.targetSha);
      expect(await gitAt(f.root, ["rev-parse", "MERGE_HEAD"])).toBe(f.sourceSha);
      expect(await gitAt(f.root, ["status", "--porcelain"])).not.toBe("");
    } finally {
      await cleanup(f);
    }
  });

  it("dirty_source_preview_is_read_only_and_never_finalizes_it", async () => {
    const f = await fixture();
    try {
      const s = service();
      const head = await gitAt(f.source, ["rev-parse", "HEAD"]);
      const commitCount = await gitAt(f.source, ["rev-list", "--count", "HEAD"]);
      await writeFile(join(f.source, "uncommitted.txt"), "must stay uncommitted\n");
      await expect(s.integration.previewGroupTaskIntegration(f.taskId)).rejects.toThrow(
        /dirty|finaliz/i,
      );
      expect(await gitAt(f.source, ["rev-parse", "HEAD"])).toBe(head);
      expect(await gitAt(f.source, ["rev-list", "--count", "HEAD"])).toBe(commitCount);
      expect(await gitAt(f.source, ["status", "--porcelain"])).toContain("uncommitted.txt");
    } finally {
      await cleanup(f);
    }
  });

  it("preview_is_read_only_and_bounded", async () => {
    const f = await fixture();
    try {
      const s = service();
      const beforeSourceHead = await gitAt(f.source, ["rev-parse", "HEAD"]);
      const beforeTargetHead = await gitAt(f.root, ["rev-parse", "HEAD"]);
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      expect(preview.sourceBranch).toBe(f.sourceBranch);
      expect(preview.sourceSha).toBe(f.sourceSha);
      expect(preview.targetBranch).toBe("main");
      expect(preview.targetSha).toBe(f.targetSha);
      expect(preview.commits).toContainEqual(expect.objectContaining({ sha: f.sourceSha }));
      expect(preview.changedFiles.map((file: { path: string }) => file.path)).toContain(
        "shared.txt",
      );
      expect(preview.diffSummary.length).toBeLessThanOrEqual(32_768);
      expect(await gitAt(f.source, ["rev-parse", "HEAD"])).toBe(beforeSourceHead);
      expect(await gitAt(f.root, ["rev-parse", "HEAD"])).toBe(beforeTargetHead);
      expect(await gitAt(f.root, ["status", "--porcelain"])).toBe("");
    } finally {
      await cleanup(f);
    }
  });

  it("previews_source_behind_target_as_no_changes", async () => {
    const f = await fixture();
    try {
      await gitAt(f.root, ["merge", "--ff-only", f.sourceBranch]);
      await writeFile(join(f.root, "target-only.txt"), "already on target\n");
      await gitAt(f.root, ["add", "target-only.txt"]);
      await gitAt(f.root, ["commit", "-m", "target ahead"]);
      const preview = await service().integration.previewGroupTaskIntegration(f.taskId);
      expect(preview.status).toBe("no_changes");
      expect(preview.commits).toEqual([]);
      expect(preview.changedFiles).toEqual([]);
      expect(preview.diffSummary).toBe("No changes to integrate.");
    } finally {
      await cleanup(f);
    }
  });

  it("rejects_unsatisfied_evidence_gate", async () => {
    const f = await fixture({ gated: true });
    try {
      const s = service();
      await expect(s.integration.previewGroupTaskIntegration(f.taskId)).rejects.toThrow(
        /gate|evidence|verification|criterion/i,
      );
    } finally {
      await cleanup(f);
    }
  });

  it("rejects_a_preview_when_the_task_version_changes", async () => {
    const f = await fixture();
    try {
      const s = service();
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      updateGroupTask(f.taskId, { branch: `${f.sourceBranch}-changed` });
      await expect(
        s.integration.applyGroupTaskIntegration({
          taskId: f.taskId,
          previewId: preview.id,
          confirmedByUser: true,
        }),
      ).rejects.toThrow(/task|version|stale/i);
    } finally {
      await cleanup(f);
    }
  });

  it("rejects_forged_or_foreign_preview_ids", async () => {
    const f = await fixture();
    try {
      const other = await fixture();
      try {
        const s = service();
        const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
        await expect(
          s.integration.applyGroupTaskIntegration({
            taskId: other.taskId,
            previewId: preview.id,
            confirmedByUser: true,
          }),
        ).rejects.toThrow(/preview|task|not found/i);
        await expect(
          s.integration.applyGroupTaskIntegration({
            taskId: f.taskId,
            previewId: "forged-preview-id",
            confirmedByUser: true,
          }),
        ).rejects.toThrow(/preview|not found/i);
      } finally {
        await cleanup(other);
      }
    } finally {
      await cleanup(f);
    }
  });

  it("serializes_concurrent_apply_and_recovers_an_interrupted_merge", async () => {
    const f = await fixture();
    try {
      const realGit = await import("../git/git-service");
      const apply = vi.fn(async (...args: Parameters<typeof realGit.applySubagentWorktree>) => {
        await realGit.applySubagentWorktree(...args);
        throw new Error("simulated process interruption after merge");
      });
      const s = service({ git: { applySubagentWorktree: apply } });
      const changes: Array<{ status: string; version: number }> = [];
      s.integration.onIntegrationChanged((record) =>
        changes.push({ status: record.status, version: record.version }),
      );
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      const input = { taskId: f.taskId, previewId: preview.id, confirmedByUser: true as const };
      const [first, second] = await Promise.all([
        s.integration.applyGroupTaskIntegration(input),
        s.integration.applyGroupTaskIntegration(input),
      ]);
      expect(first.status).toBe("applied");
      expect(second.status).toBe("applied");
      expect(apply).toHaveBeenCalledTimes(1);
      expect(await gitAt(f.root, ["rev-parse", "MERGE_HEAD"])).toBe(f.sourceSha);
      expect(changes.map(({ status }) => status)).toEqual(["ready", "applying", "applied"]);
      expect(changes.map(({ version }) => version)).toEqual([1, 2, 3]);
    } finally {
      await cleanup(f);
    }
  });

  it("abort_does_not_touch_an_unrelated_pending_merge", async () => {
    const f = await fixture({ conflict: true });
    try {
      const s = service();
      const preview = await s.integration.previewGroupTaskIntegration(f.taskId);
      const conflict = await s.integration.applyGroupTaskIntegration({
        taskId: f.taskId,
        previewId: preview.id,
        confirmedByUser: true,
      });
      expect(conflict.status).toBe("conflict");
      await gitAt(f.root, ["merge", "--abort"]);

      await gitAt(f.root, ["branch", "unrelated-branch"]);
      await gitAt(f.root, ["switch", "unrelated-branch"]);
      await writeFile(join(f.root, "foreign.txt"), "unrelated\n");
      await gitAt(f.root, ["add", "foreign.txt"]);
      await gitAt(f.root, ["commit", "-m", "unrelated branch"]);
      await gitAt(f.root, ["switch", "main"]);
      await gitAt(f.root, ["merge", "--no-commit", "--no-ff", "unrelated-branch"]);
      const foreignHead = await gitAt(f.root, ["rev-parse", "MERGE_HEAD"]);

      await expect(s.integration.abortGroupTaskIntegration(f.taskId)).rejects.toThrow(
        /belong|unrelated|merge/i,
      );
      expect(await gitAt(f.root, ["rev-parse", "MERGE_HEAD"])).toBe(foreignHead);
    } finally {
      await cleanup(f);
    }
  });
});
