import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { PromptAgentInput, PromptTurnResult } from "../agent/runtime";

let userData: string;
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

const { getDatabase } = await import("../db/database");
const { createAgentGroupWithMembers, listGroupMessages } = await import("./group-store");
const { GroupRuntime } = await import("./group-runtime");
const { resumeGroupExecutionOn } = await import("./group-resume-execution");

userData = mkdtempSync(join(tmpdir(), "modus-resume-exec-"));
const instances: InstanceType<typeof GroupRuntime>[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
  getDatabase().prepare("delete from group_jobs").run();
});
afterAll(() => {
  getDatabase().close();
  rmSync(userData, { recursive: true, force: true });
});

const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};

function squad() {
  const workspaceId = crypto.randomUUID();
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      "insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at) values (?, ?, ?, ?, ?, ?)",
    )
    .run(workspaceId, "/resume/" + workspaceId, "resume", 1, now, now);
  const members = ["Alpha", "Beta"].map((title) => {
    const id = crypto.randomUUID();
    getDatabase()
      .prepare(
        "insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, workspaceId, title, "/resume/" + workspaceId, "idle", now, now);
    return { sessionId: id };
  });
  const group = createAgentGroupWithMembers({
    name: "ResumeSquad",
    workspaceId,
    members,
    leadSessionId: members[0]!.sessionId,
    mode: "free",
  });
  return { group, a: members[0]!.sessionId };
}

describe("resumeGroupExecution", () => {
  it("requeues an interrupted job by execution id without posting a user message", async () => {
    const { group, a } = squad();
    const calls: Array<{ input: PromptAgentInput; resolve: (value: PromptTurnResult) => void }> =
      [];
    const runtime = {
      prompt: (_window: unknown, input: PromptAgentInput): Promise<PromptTurnResult> =>
        new Promise((resolve) => calls.push({ input, resolve })),
      abort: async (id: string) => {
        calls.find((call) => call.input.sessionId === id)?.resolve({ outcome: "aborted" });
      },
      isSessionStreaming: () => false,
      onTurnSettled: () => () => {},
      onQuestionPending: () => () => {},
    };
    const host = {
      getWindow: () => ({ isDestroyed: () => false }) as never,
      isUpdatePending: () => false,
      emit: () => {},
    };
    const groups = new GroupRuntime({ runtime, host, recoverPending: false });
    instances.push(groups);

    groups.postUserMessage({
      groupId: group.id,
      body: "@Alpha ship the feature",
      attachments: [{ type: "image", mimeType: "image/png", data: "abc", name: "shot.png" }],
    });
    expect(calls).toHaveLength(1);
    groups.dispose();
    instances.length = 0;

    const recovered = new GroupRuntime({ runtime, host, recoverPending: true });
    instances.push(recovered);
    const card = listGroupMessages(group.id).find((m) => m.turnId && m.status === "interrupted");
    expect(card?.turnId).toBeTruthy();
    const userCount = listGroupMessages(group.id).filter((m) => m.authorKind === "user").length;

    resumeGroupExecutionOn(recovered, { groupId: group.id, executionId: card!.turnId! });

    expect(listGroupMessages(group.id).filter((m) => m.authorKind === "user")).toHaveLength(
      userCount,
    );
    expect(listGroupMessages(group.id).some((m) => m.body === "Resume this task.")).toBe(false);
    expect(calls.filter((call) => call.input.sessionId === a)).toHaveLength(2);
    const resumed = calls[1]!;
    expect(resumed.input.message).toContain("ship the feature");
    expect(resumed.input.attachments).toEqual([
      expect.objectContaining({ type: "image", mimeType: "image/png", data: "abc" }),
    ]);
    resumed.resolve({ outcome: "ok", finalText: "Continued from checkpoint." });
    await flush();
    expect(listGroupMessages(group.id).find((m) => m.turnId === card!.turnId)).toMatchObject({
      body: "Continued from checkpoint.",
      status: "completed",
      chainId: card!.chainId,
      turnId: card!.turnId,
    });
  });
});
