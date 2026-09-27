import { describe, expect, it, vi } from "vitest";
import { toolRegistry } from "./registry";
import {
  registerSubagentTools,
  resolveTaskMode,
  resolveTaskModelId,
  resolveTaskRoute,
} from "./subagent-tools";
import { setAgentToolContext } from "./tool-context";

vi.mock("../model-service", () => ({ listModels: () => [] }));

vi.mock("../agent-run-store", () => ({
  getActiveAgentRun: vi.fn(() => ({ id: "run-current" })),
}));

describe("resolveTaskModelId", () => {
  const available = [{ id: "openai/gpt-5.5" }, { id: "minimax/m3" }];

  it("resolves catalog ids and rejects unknown ones", () => {
    expect(resolveTaskModelId(undefined, available)).toBeUndefined();
    expect(resolveTaskModelId("inherit", available)).toBeUndefined();
    expect(resolveTaskModelId("openai/gpt-5.5", available)).toBe("openai/gpt-5.5");
    expect(() => resolveTaskModelId("missing/model", available)).toThrow(/not available/);
  });
});

describe("resolveTaskRoute", () => {
  it("routes high-confidence specialist work and leaves simple or low-confidence work generic", () => {
    expect(
      resolveTaskRoute({
        text: "Review the authentication changes",
        mode: "build",
        contextPaths: [],
        changedPaths: [],
      }),
    ).toMatchObject({
      role: "reviewer",
      classification: { confidence: "high", complexity: "moderate" },
    });
    expect(
      resolveTaskRoute({ text: "Fix this typo", mode: "build", contextPaths: [], changedPaths: [] })
        .role,
    ).toBeUndefined();
    expect(
      resolveTaskRoute({ text: "Handle this", mode: "build", contextPaths: [], changedPaths: [] })
        .role,
    ).toBeUndefined();
  });

  it("uses only the owning tool profile to determine mode", () => {
    expect(resolveTaskMode("chat")).toBe("build");
    expect(resolveTaskMode("plan")).toBe("plan");
    expect(resolveTaskMode("spec")).toBe("spec");
  });

  it("does not dispatch merely by resolving a route", () => {
    const dispatch = vi.fn();
    const route = resolveTaskRoute({
      text: "Research the latest API docs",
      mode: "build",
      contextPaths: [],
      changedPaths: [],
    });
    expect(route.role).toBe("librarian");
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("task routing event and explicit roles", () => {
  it("keeps explicit role names exactly and emits only typed, redacted route metadata", async () => {
    const dispatch = vi.fn(async () => ({ session: { id: "child-session" } }));
    registerSubagentTools({ runSubagent: dispatch } as never);
    const events: unknown[] = [];
    setAgentToolContext({
      workspaceId: "workspace",
      cwd: process.cwd(),
      sessionId: "parent-session",
      profile: "chat",
      window: {} as never,
      emit: (event) => events.push(event),
    });
    const taskTool = toolRegistry
      .getCustomToolDefinitions("chat")
      .find((item) => item.name === "task");
    expect(taskTool).toBeDefined();
    const call = taskTool?.execute as (...args: unknown[]) => Promise<unknown>;

    await call(
      "task-1",
      {
        description: "Review auth",
        prompt: "PRIVATE TASK PROMPT",
        subagent: "reviewer",
      },
      new AbortController().signal,
      undefined,
      { cwd: process.cwd() },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subagentType: "reviewer",
      }),
    );
    const event = events.find((item) => (item as { type?: string }).type === "harness.route");
    expect(event).toEqual({
      type: "harness.route",
      sessionId: "parent-session",
      runId: "run-current",
      taskType: "reviewer",
      selectedRole: "reviewer",
      reasonCodes: ["explicit_subagent"],
    });
    expect(JSON.stringify(event)).not.toContain("PRIVATE TASK PROMPT");
  });

  it("falls back to generic task for unknown explicit names without claiming a built-in role", async () => {
    const dispatch = vi.fn(async () => ({ session: { id: "child-session" } }));
    registerSubagentTools({ runSubagent: dispatch } as never);
    const events: unknown[] = [];
    setAgentToolContext({
      workspaceId: "workspace",
      cwd: process.cwd(),
      sessionId: "parent-session",
      profile: "chat",
      window: {} as never,
      emit: (event) => events.push(event),
    });
    const taskTool = toolRegistry
      .getCustomToolDefinitions("chat")
      .find((item) => item.name === "task");
    const call = taskTool?.execute as (...args: unknown[]) => Promise<unknown>;

    await call(
      "task-2",
      {
        description: "Do work",
        prompt: "Task details",
        subagent: "not-a-known-profile",
      },
      new AbortController().signal,
      undefined,
      { cwd: process.cwd() },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subagentType: "task",
      }),
    );
    const event = events.find((item) => (item as { type?: string }).type === "harness.route");
    expect(event).not.toHaveProperty("selectedRole");
  });

  it("uses an inferred built-in only when task is explicitly invoked and emits no task text", async () => {
    const dispatch = vi.fn(async () => ({ session: { id: "child-session" } }));
    registerSubagentTools({ runSubagent: dispatch } as never);
    const events: unknown[] = [];
    setAgentToolContext({
      workspaceId: "workspace",
      cwd: process.cwd(),
      sessionId: "parent-session",
      profile: "chat",
      window: {} as never,
      emit: (event) => events.push(event),
    });
    expect(dispatch).not.toHaveBeenCalled();
    const taskTool = toolRegistry
      .getCustomToolDefinitions("chat")
      .find((item) => item.name === "task");
    const call = taskTool?.execute as (...args: unknown[]) => Promise<unknown>;

    await call(
      "task-3",
      {
        description: "Research API docs",
        prompt: "SECRET: research these docs",
      },
      new AbortController().signal,
      undefined,
      { cwd: process.cwd() },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subagentType: "librarian",
        subagent: expect.objectContaining({ readOnly: true }),
      }),
    );
    const event = events.find((item) => (item as { type?: string }).type === "harness.route");
    expect(event).toMatchObject({
      type: "harness.route",
      taskType: "librarian",
      selectedRole: "librarian",
    });
    expect(JSON.stringify(event)).not.toContain("SECRET");
  });
});
