import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  response: {
    requestId: "question-1",
    skipped: false,
    answers: [{ questionId: "automation-confirm", selected: ["Create this automation"] }],
  } as {
    requestId: string;
    skipped: boolean;
    answers: Array<{ questionId: string; selected: string[]; custom?: string }>;
  },
  createDefinition: vi.fn(async (input: unknown) => ({ id: "automation-1", ...(input as object) })),
  requestQuestions: vi.fn(async () => state.response),
}));

vi.mock("../../interaction/question-broker", () => ({ requestQuestions: state.requestQuestions }));
vi.mock("../../automations/automation-service-instance", () => ({
  getAutomationService: () => ({ createDefinition: state.createDefinition }),
}));
vi.mock("../agent-store", () => ({
  getAgentSession: () => ({
    id: "session-1",
    kind: "chat",
    workspaceId: "project-1",
    cwd: "/project/one",
    model: "openai/gpt-6.1-sol",
  }),
}));
vi.mock("../../workspace/workspace-store", () => ({
  getWorkspace: () => ({ id: "project-1", rootPath: "/project/one", inbox: false }),
}));
vi.mock("../../agents/agents-store", () => ({ getAgent: vi.fn() }));

const { registerAutomationProposalTool } = await import("./automation-proposal-tool");
const { toolRegistry } = await import("./registry");
const { runWithAgentToolContext, setAgentToolContext } = await import("./tool-context");

const proposal = {
  name: "Daily summary",
  instruction: "Summarize recent project changes.",
  schedule: { kind: "daily", local_time: "09:00" },
};

async function callTool(input: unknown = proposal, contextOverrides: Record<string, unknown> = {}) {
  const definition = toolRegistry
    .getCustomToolDefinitions("chat")
    .find((tool) => tool.name === "propose_automation");
  if (!definition) throw new Error("Automation proposal tool is not registered");
  const execute = definition.execute as (
    ...args: unknown[]
  ) => Promise<{ content: Array<{ text: string }> }>;
  return runWithAgentToolContext(
    {
      workspaceId: "project-1",
      cwd: "/project/one",
      sessionId: "session-1",
      modelId: "openai/gpt-6.1-sol",
      thinkingLevel: "high",
      ...contextOverrides,
      profile: "chat",
      emit: vi.fn(),
    },
    () =>
      execute("call-1", input, new AbortController().signal, undefined, { cwd: "/project/one" }),
  );
}

describe("automation proposal tool", () => {
  beforeEach(() => {
    state.response = {
      requestId: "question-1",
      skipped: false,
      answers: [{ questionId: "automation-confirm", selected: ["Create this automation"] }],
    };
    state.createDefinition.mockClear();
    state.requestQuestions.mockClear();
    setAgentToolContext({
      workspaceId: "project-1",
      cwd: "/project/one",
      sessionId: "session-1",
      modelId: "openai/gpt-6.1-sol",
      thinkingLevel: "high",
      emit: vi.fn(),
    });
    registerAutomationProposalTool();
  });

  it("persists the current Project and selected model only after explicit confirmation", async () => {
    await callTool();
    expect(state.requestQuestions).toHaveBeenCalledOnce();
    expect(state.createDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        name: proposal.name,
        instruction: proposal.instruction,
        workspaceId: "project-1",
        cwd: "/project/one",
        providerId: "openai",
        modelId: "openai/gpt-6.1-sol",
        thinkingLevel: "high",
        enabled: true,
      }),
    );
  });

  it.each([
    [
      "cancelled",
      { skipped: false, answers: [{ questionId: "automation-confirm", selected: ["Cancel"] }] },
    ],
    ["skipped", { skipped: true, answers: [] }],
    [
      "custom text",
      {
        skipped: false,
        answers: [{ questionId: "automation-confirm", selected: [], custom: "Create it" }],
      },
    ],
  ])("does not persist a %s confirmation", async (_label, response) => {
    state.response = { requestId: "question-1", ...response };
    await callTool();
    expect(state.createDefinition).not.toHaveBeenCalled();
  });

  it("rejects when there is no host-owned selected model", async () => {
    await expect(callTool(proposal, { modelId: undefined })).rejects.toThrow(/selected model/i);
    expect(state.requestQuestions).not.toHaveBeenCalled();
    expect(state.createDefinition).not.toHaveBeenCalled();
  });

  it("rejects malformed and renderer-like fields before asking the user", async () => {
    await expect(callTool({ ...proposal, cwd: "/tmp/arbitrary" })).rejects.toThrow(
      /invalid automation proposal/i,
    );
    expect(state.requestQuestions).not.toHaveBeenCalled();
    expect(state.createDefinition).not.toHaveBeenCalled();
  });
});
