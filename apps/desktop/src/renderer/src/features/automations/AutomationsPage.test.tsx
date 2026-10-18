// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationDefinition, AutomationExecution } from "../../../../shared/automations";
import type { AgentInfo, ModelInfo, WorkspaceInfo } from "../../../../shared/contracts";
import { AutomationsPage } from "./AutomationsPage";

afterEach(cleanup);

const project = {
  id: "project-1",
  rootPath: "/project/one",
  displayName: "Dayz",
  isGitRepository: true,
  lastOpenedAt: "2026-10-18T12:00:00.000Z",
  pinned: false,
} satisfies WorkspaceInfo;

const model = {
  id: "openai/gpt-6.1-sol",
  provider: "openai",
  providerName: "OpenAI",
  name: "GPT-6.1 Sol",
  available: true,
  enabled: true,
  configured: true,
  source: "builtin",
  supportsThinking: true,
  thinkingLevel: "minimal",
  thinkingLevels: ["minimal", "high"],
} satisfies ModelInfo;

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: "automation-1",
    revision: 1,
    name: "Daily summary",
    instruction: "Summarize project changes.",
    schedule: { kind: "daily", localTime: "09:00" },
    timeZone: "America/Sao_Paulo",
    nextOccurrenceAt: "2026-10-19T12:00:00.000Z",
    workspaceId: project.id,
    cwd: project.rootPath,
    agentId: null,
    providerId: model.provider,
    modelId: model.id,
    thinkingLevel: "minimal",
    enabled: true,
    createdAt: "2026-10-18T12:00:00.000Z",
    updatedAt: "2026-10-18T12:00:00.000Z",
    ...overrides,
  };
}

function execution(overrides: Partial<AutomationExecution> = {}): AutomationExecution {
  return {
    id: "execution-1",
    automationId: "automation-1",
    automationRevision: 1,
    triggerKey: "manual:execution-1",
    triggerKind: "manual",
    scheduledFor: null,
    config: {
      name: "Daily summary",
      instruction: "Summarize project changes.",
      schedule: { kind: "daily", localTime: "09:00" },
      timeZone: "America/Sao_Paulo",
      workspaceId: project.id,
      cwd: project.rootPath,
      agentId: null,
      providerId: model.provider,
      modelId: model.id,
      thinkingLevel: "minimal",
    },
    status: "completed",
    sessionId: "session-result-1",
    runId: "run-1",
    createdAt: "2026-10-18T12:00:00.000Z",
    startedAt: "2026-10-18T12:00:00.000Z",
    completedAt: "2026-10-18T12:01:00.000Z",
    ...overrides,
  };
}

function setup(definitions: AutomationDefinition[] = []) {
  const api = {
    list: vi.fn(async () => definitions),
    get: vi.fn(),
    history: vi.fn(async () => [] as AutomationExecution[]),
    create: vi.fn(async (input) => definition({ ...input, id: "created-1" })),
    update: vi.fn(async ({ id }) => definition({ id })),
    setEnabled: vi.fn(async (id, enabled) => definition({ id, enabled })),
    delete: vi.fn(async () => undefined),
    runNow: vi.fn(async () => execution({ status: "claimed" })),
    stop: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
  };
  const onOpenConversation = vi.fn();
  render(
    <AutomationsPage
      activeWorkspaceId={project.id}
      agents={[] as AgentInfo[]}
      api={api as never}
      defaultModelId={model.id}
      models={[model]}
      onOpenConversation={onOpenConversation}
      workspaces={[project]}
    />,
  );
  return { api, onOpenConversation };
}

describe("AutomationsPage", () => {
  it("creates from the minimal editor with a pinned user model and Project", async () => {
    const { api } = setup();
    await screen.findByText("No automations yet.");
    fireEvent.click(screen.getByRole("button", { name: /New automation/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Daily summary" } });
    fireEvent.change(screen.getByLabelText("What should Modus do?"), {
      target: { value: "Summarize project changes." },
    });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: project.id } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: model.id } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Daily summary",
          instruction: "Summarize project changes.",
          workspaceId: project.id,
          modelId: model.id,
          providerId: model.provider,
          schedule: { kind: "daily", localTime: "09:00" },
        }),
      ),
    );
  });

  it("shows execution history and opens its linked conversation", async () => {
    const { api, onOpenConversation } = setup([definition()]);
    api.history.mockResolvedValue([execution()]);
    fireEvent.click(await screen.findByRole("button", { name: /Daily summary/ }));
    await screen.findByText("Recent runs");
    fireEvent.click(await screen.findByRole("button", { name: "Open conversation" }));
    expect(onOpenConversation).toHaveBeenCalledWith("session-result-1");
  });

  it("pauses and runs the selected automation from its detail screen", async () => {
    const { api } = setup([definition()]);
    fireEvent.click(await screen.findByRole("button", { name: /Daily summary/ }));
    await screen.findByText("Recent runs");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith("automation-1", false));
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(api.runNow).toHaveBeenCalledWith("automation-1"));
  });
});
