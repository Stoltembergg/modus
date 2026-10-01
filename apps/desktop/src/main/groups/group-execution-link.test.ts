import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let userData: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
  },
}));

const { migrateDatabase, getDatabase } = await import("../db/database");
const {
  appendGroupMessage,
  createAgentGroup,
  createGroupTask,
  latestGroupExecutionId,
  listGroupDecisions,
  listGroupMessages,
  listGroupTasks,
  recordGroupDecision,
} = await import("./group-store");

describe("group execution linking", () => {
  beforeAll(async () => {
    userData = await mkdtemp(join(tmpdir(), "modus-exec-link-"));
    migrateDatabase(getDatabase());
  });

  afterAll(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  it("Nova tarefa opens a fresh execution; Complementar joins chainId", () => {
    const group = createAgentGroup({ name: "Link" });
    const first = appendGroupMessage({
      groupId: group.id,
      authorKind: "user",
      body: "Ship login",
      startsChain: true,
    });
    expect(first.chainId).toBe(first.id);
    expect(latestGroupExecutionId(group.id)).toBe(first.id);

    const follow = appendGroupMessage({
      groupId: group.id,
      authorKind: "user",
      body: "Also cover OAuth",
      chainId: first.id,
    });
    expect(follow.chainId).toBe(first.id);

    const other = appendGroupMessage({
      groupId: group.id,
      authorKind: "user",
      body: "Separate docs task",
      startsChain: true,
    });
    expect(other.chainId).toBe(other.id);
    expect(other.chainId).not.toBe(first.id);
    expect(latestGroupExecutionId(group.id)).toBe(other.id);

    const messages = listGroupMessages(group.id);
    expect(messages.map((m) => m.chainId)).toEqual([first.id, first.id, other.id]);
  });

  it("tasks and decisions persist the same executionId as the chain", () => {
    const group = createAgentGroup({ name: "Stamp" });
    const root = appendGroupMessage({
      groupId: group.id,
      authorKind: "user",
      body: "Build API",
      startsChain: true,
    });
    const task = createGroupTask({
      groupId: group.id,
      title: "Write handlers",
      executionId: root.id,
    });
    const decision = recordGroupDecision({
      groupId: group.id,
      text: "Use REST",
      executionId: root.id,
    });
    expect(task.executionId).toBe(root.id);
    expect(decision.executionId).toBe(root.id);
    expect(listGroupTasks(group.id)[0]?.executionId).toBe(root.id);
    expect(listGroupDecisions(group.id)[0]?.executionId).toBe(root.id);
  });
});
