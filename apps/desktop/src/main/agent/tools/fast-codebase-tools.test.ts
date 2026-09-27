import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFastCodebaseTools } from "./fast-codebase-tools";
import { toolRegistry } from "./registry";
import { runWithAgentToolContext, setAgentToolContext } from "./tool-context";

const testMocks = vi.hoisted(() => ({
  runFastCodebase: vi.fn(),
  activeRun: { id: "run-current" } as { id: string } | undefined,
  recordEvent: vi.fn(),
}));
const { runFastCodebase, recordEvent } = testMocks;

vi.mock("../../fast-codebase/fast-codebase-service", () => ({
  runFastCodebase: testMocks.runFastCodebase,
}));

vi.mock("../agent-run-store", () => ({
  getActiveAgentRun: vi.fn(() => testMocks.activeRun),
}));

vi.mock("../agent-event-store", () => ({
  recordAgentEvent: testMocks.recordEvent,
}));

describe("fast_codebase tool", () => {
  beforeEach(() => {
    setAgentToolContext({ workspaceId: "workspace", sessionId: "session", cwd: "F:\\repo" });
    runFastCodebase.mockReset();
    testMocks.activeRun = { id: "run-current" };
    recordEvent.mockReset();
  });

  it("streams the final result to the tool card and returns it to the agent", async () => {
    registerFastCodebaseTools();
    const tool = toolRegistry
      .getCustomToolDefinitions("chat", { enable: ["fast_codebase"] })
      .find((definition) => definition.name === "fast_codebase");
    const details = {
      indexDir: "F:\\repo\\.codegraph",
      indexed: true,
      kernel: "CodeGraph local index",
      project: "demo",
      query: "overview",
      workspace: "F:\\repo",
    };
    const hits = [{ path: "src/run.ts", symbol: "Agent.run", line: 7, kind: "function" }];
    runFastCodebase.mockResolvedValue({ details, hits, text: "# Fast Codebase\nok" });

    const execute = tool?.execute as NonNullable<typeof tool>["execute"];
    const updates: unknown[] = [];
    const result = await runWithAgentToolContext(
      { workspaceId: "workspace", sessionId: "session", cwd: "F:\\repo" },
      () =>
        execute(
          "call-1",
          { query: "overview", workspace_path: "F:\\repo\\child" },
          new AbortController().signal,
          (update: unknown) => updates.push(update),
          { cwd: "F:\\repo" } as Parameters<typeof execute>[4],
        ),
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "# Fast Codebase\nok" }],
      details,
    });
    expect(updates.at(-1)).toEqual(result);
    expect(runFastCodebase).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "F:\\repo\\child" }),
    );
    expect(recordEvent).toHaveBeenCalledWith({
      type: "codegraph.discoveries",
      sessionId: "session",
      runId: "run-current",
      hits,
    });
    const event = recordEvent.mock.calls[0]?.[0];
    expect(JSON.stringify(event)).not.toContain("overview");
    expect(JSON.stringify(event)).not.toContain("# Fast Codebase");
  });

  it("lets failed tool calls use the agent error path", async () => {
    registerFastCodebaseTools();
    const tool = toolRegistry
      .getCustomToolDefinitions("chat", { enable: ["fast_codebase"] })
      .find((definition) => definition.name === "fast_codebase");
    runFastCodebase.mockRejectedValue(new Error("index failed"));

    const execute = tool?.execute as NonNullable<typeof tool>["execute"];
    await expect(
      runWithAgentToolContext(
        { workspaceId: "workspace", sessionId: "session", cwd: "F:\\repo" },
        () =>
          execute("call-1", { query: "overview" }, new AbortController().signal, undefined, {
            cwd: "F:\\repo",
          } as Parameters<typeof execute>[4]),
      ),
    ).rejects.toThrow(/index failed/);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("emits no discoveries event when the call has no active run", async () => {
    registerFastCodebaseTools();
    const tool = toolRegistry
      .getCustomToolDefinitions("chat", { enable: ["fast_codebase"] })
      .find((definition) => definition.name === "fast_codebase");
    runFastCodebase.mockResolvedValue({
      details: {
        indexDir: "",
        indexed: true,
        kernel: "",
        project: "",
        query: "secret query",
        workspace: "F:\\repo",
      },
      hits: [{ path: "src/run.ts" }],
      text: "private CodeGraph text",
    });
    testMocks.activeRun = undefined;
    const execute = tool?.execute as NonNullable<typeof tool>["execute"];

    await runWithAgentToolContext(
      { workspaceId: "workspace", sessionId: "session", cwd: "F:\\repo" },
      () =>
        execute("call-1", { query: "secret query" }, new AbortController().signal, undefined, {
          cwd: "F:\\repo",
        } as Parameters<typeof execute>[4]),
    );

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("emits only workspace-relative discovery references", async () => {
    registerFastCodebaseTools();
    const tool = toolRegistry
      .getCustomToolDefinitions("chat", { enable: ["fast_codebase"] })
      .find((definition) => definition.name === "fast_codebase");
    runFastCodebase.mockResolvedValue({
      details: {
        indexDir: "",
        indexed: true,
        kernel: "",
        project: "",
        query: "private query",
        workspace: "F:\\repo",
      },
      hits: [
        { path: "src/valid.ts", symbol: "valid" },
        { path: "..\\outside.ts", symbol: "outside" },
        { path: "F:\\outside.ts", symbol: "absolute" },
      ],
      text: "private result prose",
    });
    const execute = tool?.execute as NonNullable<typeof tool>["execute"];

    await runWithAgentToolContext(
      { workspaceId: "workspace", sessionId: "session", cwd: "F:\\repo" },
      () =>
        execute("call-1", { query: "private query" }, new AbortController().signal, undefined, {
          cwd: "F:\\repo",
        } as Parameters<typeof execute>[4]),
    );

    expect(recordEvent).toHaveBeenCalledWith({
      type: "codegraph.discoveries",
      sessionId: "session",
      runId: "run-current",
      hits: [{ path: "src/valid.ts", symbol: "valid" }],
    });
  });
});
