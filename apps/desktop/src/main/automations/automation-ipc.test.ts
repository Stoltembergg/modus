import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../ipc/channels";
import { registerAutomationIpcHandlers } from "./automation-ipc";

function setup() {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const ipcMain = {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      handlers.set(channel, handler);
    },
  };
  const service = {
    listDefinitions: vi.fn(() => [{ id: "automation-1" }]),
    getDefinition: vi.fn(() => ({
      id: "automation-1",
      workspaceId: "project-1",
      cwd: "/project/one",
    })),
    listHistory: vi.fn(() => [{ id: "execution-1" }]),
    createDefinition: vi.fn(async (input) => ({ id: "created", ...input })),
    updateDefinition: vi.fn(async (id, revision, patch) => ({ id, revision, ...patch })),
    setEnabled: vi.fn((id, enabled) => ({ id, enabled })),
    deleteDefinition: vi.fn(),
    runNow: vi.fn(async (id) => ({ id })),
    stopExecution: vi.fn(),
  };
  const assertTrustedSender = vi.fn();
  const resolveWorkspace = vi.fn((id: string) =>
    id === "project-1" || id === "project-2"
      ? {
          id,
          rootPath: id === "project-1" ? "/project/one" : "/project/two",
          displayName: "Project",
          isGitRepository: false,
          lastOpenedAt: "2026-10-18T00:00:00.000Z",
          pinned: false,
          inbox: false,
        }
      : undefined,
  );
  registerAutomationIpcHandlers({
    ipcMain: ipcMain as never,
    assertTrustedSender: assertTrustedSender as never,
    resolveWorkspace,
    service: service as never,
  });
  const invoke = (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({ sender: {} }, payload);
  };
  return { handlers, service, assertTrustedSender, resolveWorkspace, invoke };
}

const createInput = {
  name: "Daily summary",
  instruction: "Summarize project changes.",
  schedule: { kind: "daily", localTime: "09:00" },
  timeZone: "America/Sao_Paulo",
  workspaceId: "project-1",
  agentId: null,
  providerId: "openai",
  modelId: "openai/gpt-6.1-sol",
  thinkingLevel: "minimal",
};

describe("automation IPC", () => {
  it("checks a trusted sender before parsing or invoking every host operation", async () => {
    const { handlers, assertTrustedSender, service } = setup();
    vi.mocked(assertTrustedSender).mockImplementation(() => {
      throw new Error("untrusted sender");
    });
    const automationHandlers = [...handlers.entries()].filter(([channel]) =>
      channel.startsWith("automation:"),
    );

    for (const [, handler] of automationHandlers) {
      await expect(handler({ sender: {} }, undefined)).rejects.toThrow("untrusted sender");
    }

    expect(automationHandlers).toHaveLength(9);
    expect(assertTrustedSender).toHaveBeenCalledTimes(automationHandlers.length);
    expect(service.listDefinitions).not.toHaveBeenCalled();
    expect(service.createDefinition).not.toHaveBeenCalled();
  });

  it("resolves the Project working directory in the main process before creating", async () => {
    const { invoke, service, resolveWorkspace } = setup();

    await invoke(IPC_CHANNELS.automationCreate, createInput);

    expect(resolveWorkspace).toHaveBeenCalledWith("project-1");
    expect(service.createDefinition).toHaveBeenCalledWith({
      ...createInput,
      cwd: "/project/one",
      enabled: true,
    });
  });

  it("rejects renderer-supplied paths and unknown creation fields", async () => {
    const { invoke, service } = setup();

    await expect(
      invoke(IPC_CHANNELS.automationCreate, { ...createInput, cwd: "/tmp/arbitrary" }),
    ).rejects.toThrow(/Invalid IPC payload/);
    expect(service.createDefinition).not.toHaveBeenCalled();
  });

  it("resolves a changed Project path from the host before updating", async () => {
    const { invoke, service } = setup();

    await invoke(IPC_CHANNELS.automationUpdate, {
      id: "automation-1",
      revision: 3,
      patch: { workspaceId: "project-2" },
    });

    expect(service.updateDefinition).toHaveBeenCalledWith("automation-1", 3, {
      workspaceId: "project-2",
      cwd: "/project/two",
    });
  });

  it("validates malformed operation payloads before calling the service", async () => {
    const { invoke, service } = setup();

    await expect(invoke(IPC_CHANNELS.automationRunNow, { id: "" })).rejects.toThrow(
      /Invalid IPC payload/,
    );
    expect(service.runNow).not.toHaveBeenCalled();
  });

  it("accepts only a boolean enabled state", async () => {
    const { invoke, service } = setup();

    await expect(
      invoke(IPC_CHANNELS.automationSetEnabled, { id: "automation-1", enabled: "false" }),
    ).rejects.toThrow(/Invalid IPC payload/);
    expect(service.setEnabled).not.toHaveBeenCalled();
  });
});
