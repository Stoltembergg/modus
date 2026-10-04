import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let userData: string;
vi.mock("electron", () => ({ app: { getPath: () => userData } }));
const { getDatabase } = await import("../db/database");
const { createAgentGroup, createGroupTask } = await import("./group-store");
const { getGroupWorkState } = await import("./group-work-state");
const { estimateGroupTokens, ESTIMATED_CONTEXT_TOKENS_PER_WAKE } = await import(
  "./group-runtime-lib"
);
beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-work-state-"));
});
afterAll(async () => {
  await rm(userData, { recursive: true, force: true });
});
it("work_state_is_bounded_and_read_only", () => {
  const group = createAgentGroup({ name: "State" });
  for (let index = 0; index < 100; index++)
    createGroupTask({
      groupId: group.id,
      title: `${index} ${"x".repeat(1000)}`,
      description: "raw output must not be exposed",
    });
  const before = getDatabase().prepare("select total_changes() as count").get();
  const state = getGroupWorkState(group.id);
  expect(state.tasks.length).toBeGreaterThan(0);
  expect(state.omitted.tasks + state.tasks.length).toBe(100);
  expect(estimateGroupTokens(JSON.stringify(state))).toBeLessThanOrEqual(
    ESTIMATED_CONTEXT_TOKENS_PER_WAKE,
  );
  expect(state.tasks[0]).toMatchObject({
    id: expect.any(String),
    status: "open",
    stateVersion: 1,
    dependencyIds: [],
  });
  expect(JSON.stringify(state)).not.toContain("raw output must not be exposed");
  expect(getDatabase().prepare("select total_changes() as count").get()).toEqual(before);
});
