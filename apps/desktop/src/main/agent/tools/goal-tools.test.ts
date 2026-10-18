import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let userData: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
  },
}));

const { databasePath, getDatabase } = await import("../../db/database");
const { getAgentSessionGoalJson } = await import("../agent-store");
const goalState = await import("../goal-state");
const { registerGoalTools } = await import("./goal-tools");
const { toolRegistry } = await import("./registry");
const { setAgentToolContext } = await import("./tool-context");

const WORKSPACE = "goal-ws";
let sessionCounter = 0;
let sessionId = "";

function insertSession(id: string): void {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, WORKSPACE, "Goal session", "/tmp", "idle", now, now);
}

type ToolResult = { content: Array<{ text: string }>; details: { goal: unknown } };

async function call(name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
  const definition = toolRegistry
    .getCustomToolDefinitions("chat")
    .find((tool) => tool.name === name);
  if (!definition) throw new Error(`${name} is not registered`);
  const execute = definition.execute as (...args: unknown[]) => Promise<ToolResult>;
  return await execute("goal-test", input, new AbortController().signal, undefined, {
    cwd: process.cwd(),
  });
}

const GOAL = {
  objective: "Make `npm test` pass on main with 0 failures",
  done_when: ["`npm test` exits 0", "CI build job green"],
  out_of_scope: ["Changing the public API"],
  stop_and_ask: ["A fix needs a dependency upgrade"],
};

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-goal-tools-test-"));
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(WORKSPACE, "/tmp/goal-ws", "repo", 0, now, now);
  registerGoalTools();
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(() => {
  sessionCounter += 1;
  sessionId = `goal-session-${sessionCounter}`;
  insertSession(sessionId);
  setAgentToolContext({
    workspaceId: WORKSPACE,
    cwd: process.cwd(),
    sessionId,
    profile: "chat",
    emit: vi.fn(),
  });
});

describe("goal tools", () => {
  it("registers get_goal, create_goal and complete_goal as safe chat/plan/review tools", () => {
    for (const name of ["get_goal", "create_goal", "complete_goal"]) {
      const entry = toolRegistry.getEntry(name);
      expect(entry?.profiles).toEqual(["chat", "review", "plan"]);
      expect(entry?.permission).toEqual({ danger: "safe" });
      expect(toolRegistry.isReadOnlySafe(name)).toBe(true);
    }
  });

  it("get_goal reports no goal, then the saved goal", async () => {
    const empty = await call("get_goal");
    expect(empty.content[0]?.text).toBe("This session has no goal.");
    expect(empty.details.goal).toBeNull();

    await call("create_goal", GOAL);
    const saved = await call("get_goal");
    expect(saved.content[0]?.text).toContain("Goal (active): Make `npm test` pass");
    expect(saved.content[0]?.text).toContain("- CI build job green");
    expect(saved.content[0]?.text).toContain("Stop and ask if:");
    expect(saved.details.goal).toMatchObject({ status: "active", doneWhen: GOAL.done_when });
  });

  it("create_goal saves the structured goal and activates the session", async () => {
    const created = await call("create_goal", GOAL);
    expect(created.content[0]?.text).toContain("Goal set.");
    const state = goalState.getSessionGoalState(sessionId);
    expect(state.active).toBe(true);
    expect(state.goal).toMatchObject({
      objective: GOAL.objective,
      doneWhen: GOAL.done_when,
      outOfScope: GOAL.out_of_scope,
      stopAndAsk: GOAL.stop_and_ask,
      status: "active",
    });
  });

  it("create_goal refuses while an active goal exists and keeps the first one", async () => {
    await call("create_goal", GOAL);
    await expect(
      call("create_goal", { objective: "Another goal", done_when: ["x"] }),
    ).rejects.toThrow(/already has an active goal/);
    expect(goalState.getSessionGoalState(sessionId).goal?.objective).toBe(GOAL.objective);
  });

  it("create_goal replaces a completed goal (one goal per session, no history)", async () => {
    await call("create_goal", GOAL);
    await call("complete_goal", { evidence: ["npm test: 0 failures"], summary: "Done" });
    await call("create_goal", { objective: "Second goal", done_when: ["check passes"] });
    const state = goalState.getSessionGoalState(sessionId);
    expect(state.goal).toMatchObject({ objective: "Second goal", status: "active" });
    expect(state.goal?.evidence).toBeUndefined();
  });

  it("create_goal rejects an empty objective or no done_when criteria", async () => {
    await expect(call("create_goal", { objective: "  ", done_when: ["x"] })).rejects.toThrow(
      /non-empty objective/,
    );
    await expect(call("create_goal", { objective: "Ship", done_when: [" "] })).rejects.toThrow(
      /done_when/,
    );
    expect(goalState.getSessionGoalState(sessionId).goal).toBeUndefined();
  });

  it("complete_goal records evidence and summary", async () => {
    await call("create_goal", GOAL);
    const done = await call("complete_goal", {
      evidence: ["`npm test` exited 0 (412 passed)", "CI run 123 green"],
      summary: "Fixed the flaky date test.",
    });
    expect(done.content[0]?.text).toContain("Goal completed.");
    expect(done.content[0]?.text).toContain("- CI run 123 green");
    const goal = goalState.getSessionGoalState(sessionId).goal;
    expect(goal).toMatchObject({
      status: "completed",
      evidence: ["`npm test` exited 0 (412 passed)", "CI run 123 green"],
      summary: "Fixed the flaky date test.",
    });
    expect(goal?.completedAt).toEqual(expect.any(String));
  });

  it("complete_goal without a goal fails and saves nothing", async () => {
    await expect(
      call("complete_goal", { evidence: ["something"], summary: "Done" }),
    ).rejects.toThrow(/no goal to complete/);
    expect(getAgentSessionGoalJson(sessionId)).toBeUndefined();
  });

  it("complete_goal refuses an already completed goal or missing evidence", async () => {
    await call("create_goal", GOAL);
    await expect(call("complete_goal", { evidence: [], summary: "Done" })).rejects.toThrow(
      /evidence/,
    );
    await call("complete_goal", { evidence: ["ok"], summary: "Done" });
    await expect(call("complete_goal", { evidence: ["ok"], summary: "Again" })).rejects.toThrow(
      /already completed/,
    );
  });

  it("the goal survives a reload of the session metadata", async () => {
    await call("create_goal", GOAL);
    // A fresh read goes back to agent_sessions.goal_json (no in-memory cache).
    const raw = getAgentSessionGoalJson(sessionId);
    expect(JSON.parse(raw ?? "{}")).toMatchObject({ active: true, goal: { status: "active" } });
    // A second connection to the on-disk database sees the same goal (survives a restart).
    const disk = new DatabaseSync(databasePath());
    try {
      const row = disk
        .prepare("select goal_json from agent_sessions where id = ?")
        .get(sessionId) as { goal_json: string };
      expect(JSON.parse(row.goal_json).goal.objective).toBe(GOAL.objective);
    } finally {
      disk.close();
    }
    expect(goalState.getSessionGoalState(sessionId).goal?.objective).toBe(GOAL.objective);
    expect(goalState.goalToolsActive(sessionId)).toBe(true);
  });
});

describe("goal state activation", () => {
  it("activateGoalTools persists the flag once and is idempotent", () => {
    expect(goalState.goalToolsActive(sessionId)).toBe(false);
    expect(goalState.activateGoalTools(sessionId)).toBe(true);
    expect(goalState.activateGoalTools(sessionId)).toBe(false);
    expect(goalState.getSessionGoalState(sessionId)).toEqual({ active: true });
  });

  it("a malformed goal_json reads as inactive", () => {
    getDatabase()
      .prepare("update agent_sessions set goal_json = ? where id = ?")
      .run("{not json", sessionId);
    expect(goalState.getSessionGoalState(sessionId)).toEqual({ active: false });
  });

  it("matches reads of the built-in define-goal SKILL.md only", () => {
    const skill = "/opt/modus/resources/skills/define-goal/SKILL.md";
    const read = (path: unknown, cwd = "/home/u/repo") =>
      goalState.isBuiltinDefineGoalSkillRead(path, cwd, skill);
    expect(read(skill)).toBe(true);
    expect(read("../../../opt/modus/resources/skills/define-goal/SKILL.md")).toBe(true);
    expect(read("SKILL.md", "/opt/modus/resources/skills/define-goal")).toBe(true);
    expect(read("/opt/modus/resources/skills/brainstorming/SKILL.md")).toBe(false);
    expect(read("/home/u/repo/.agents/skills/define-goal/SKILL.md")).toBe(false);
    expect(read(undefined)).toBe(false);
    expect(read(42)).toBe(false);
  });

  it("detects define-goal in an <invoked_skills> block only", () => {
    const invoked = [
      "<invoked_skills>",
      '<skill name="define-goal" path="/x/define-goal/SKILL.md">',
      "</skill>",
      "</invoked_skills>",
    ].join("\n");
    expect(goalState.invokedDefineGoalSkill(invoked)).toBe(true);
    expect(goalState.invokedDefineGoalSkill("## Skills\n- define-goal: Help (file: /x)")).toBe(
      false,
    );
    expect(
      goalState.invokedDefineGoalSkill(
        '<invoked_skills>\n<skill name="brainstorming" path="/b">\n</skill>\n</invoked_skills>',
      ),
    ).toBe(false);
  });
});
