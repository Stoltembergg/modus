import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  getAgentSession: vi.fn(),
  getAgentRuntime: vi.fn(),
  getRunWorkspaceRevision: vi.fn(),
  listAgentEventPage: vi.fn(),
  isWorkspaceWatched: vi.fn(),
  readPlanById: vi.fn(),
  updatePlanContentById: vi.fn(),
  recordAgentEvent: vi.fn(),
  senderWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
  fingerprintPlanSource: vi.fn(),
  promotePlanRevision: vi.fn(),
  publishPlanUpdated: vi.fn(),
  recordPermissionDecision: vi.fn(),
  startPlanBuild: vi.fn(),
  assertPlanBuildSessionAvailable: vi.fn(),
  startProviderAuth: vi.fn(),
  startAgentReview: vi.fn(),
  getAgent: vi.fn(),
  getDefaultModelId: vi.fn(),
  isUsableModelId: vi.fn(),
  requireAgentChatWritable: vi.fn(),
  restoreCheckpoint: vi.fn(),
  approveMcpServer: vi.fn(),
  fromWebContents: vi.fn(),
  reaGetStatus: vi.fn(),
  reaSetEnabled: vi.fn(),
  reaRetry: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "C:/modus-user-data", getVersion: () => "test" },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  clipboard: { writeImage: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: never[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  nativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => false })) },
  shell: { openPath: vi.fn(async () => "") },
}));

vi.mock("../agent/agent-store", () => ({
  getAgentSession: mocks.getAgentSession,
}));
vi.mock("../agent/agent-event-store", () => ({
  listAgentEventPage: mocks.listAgentEventPage,
  recordAgentEvent: mocks.recordAgentEvent,
  getRunWorkspaceRevision: mocks.getRunWorkspaceRevision,
  getWorkspaceHarnessInsightEvidence: vi.fn(() => ({ runs: [], events: [] })),
}));
vi.mock("../files/files-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../files/files-watcher")>()),
  isWorkspaceWatched: mocks.isWorkspaceWatched,
}));
vi.mock("../agent/checkpoint-service", () => ({
  getLastTurnComparison: vi.fn(),
  getSessionBaseCheckpoint: vi.fn(),
  listCheckpoints: vi.fn(),
  restoreCheckpoint: mocks.restoreCheckpoint,
}));
vi.mock("../agent/tools/plan-tools", () => ({
  plansRoot: () => "C:/plans",
  registerPlanTools: vi.fn(),
}));
vi.mock("../agent/runtime-registry", () => ({ getAgentRuntime: mocks.getAgentRuntime }));
vi.mock("../agent/review-service", () => ({
  listAgentReviews: vi.fn(() => []),
  startAgentReview: mocks.startAgentReview,
}));
vi.mock("../plan/plan-store", () => ({
  fingerprintPlanSource: mocks.fingerprintPlanSource,
  promotePlanRevision: mocks.promotePlanRevision,
  readPlanById: mocks.readPlanById,
  updatePlanContentById: mocks.updatePlanContentById,
}));

vi.mock("../agent/model-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/model-service")>()),
  startProviderAuth: mocks.startProviderAuth,
  getDefaultModelId: mocks.getDefaultModelId,
  isUsableModelId: mocks.isUsableModelId,
}));
vi.mock("../agents/agents-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agents-store")>()),
  getAgent: mocks.getAgent,
  requireAgentChatWritable: mocks.requireAgentChatWritable,
}));
vi.mock("../permissions/permission-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../permissions/permission-store")>()),
  recordPermissionDecision: mocks.recordPermissionDecision,
}));
vi.mock("../mcp/mcp-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp/mcp-service")>()),
  approveMcpServer: mocks.approveMcpServer,
}));

import { IPC_CHANNELS } from "./channels";
import { registerAppIpc } from "./register-app-ipc";
import { registerTrustedSender } from "./trusted-sender";

describe("permission decision IPC", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.recordPermissionDecision.mockReset();
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });

  it("requires a live permission request before recording a decision", () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.permissionDecide);
    if (!handler) throw new Error("Permission decision IPC handler was not registered.");

    expect(() =>
      handler(
        trustedEvent as never,
        {
          sessionId: "session-a",
          action: "shell.execute",
          target: "rm -rf build-output",
          decision: "allow-workspace",
        } as never,
      ),
    ).toThrow();
    expect(mocks.recordPermissionDecision).not.toHaveBeenCalled();
  });

  it("does not persist decisions for expired permission requests", () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.permissionDecide);
    if (!handler) throw new Error("Permission decision IPC handler was not registered.");

    expect(() =>
      handler(
        trustedEvent as never,
        {
          requestId: "expired-request",
          sessionId: "session-a",
          action: "shell.execute",
          target: "rm -rf build-output",
          decision: "allow-workspace",
        } as never,
      ),
    ).toThrow("Permission request is no longer active.");
    expect(mocks.recordPermissionDecision).not.toHaveBeenCalled();
  });
});

describe("project MCP trust IPC", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.approveMcpServer.mockReset();
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });

  it("forwards only a validated fingerprinted project approval from the trusted renderer", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.mcpApprove);
    if (!handler) throw new Error("MCP approval IPC handler was not registered.");
    const fingerprint = "a".repeat(64);
    mocks.approveMcpServer.mockResolvedValue([]);

    await handler(
      trustedEvent as never,
      { cwd: "/work/project", name: "docs", expectedFingerprint: fingerprint } as never,
    );

    expect(mocks.approveMcpServer).toHaveBeenCalledWith("/work/project", "docs", fingerprint);
  });

  it("rejects malformed fingerprints before the trust decision is reached", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.mcpApprove);
    if (!handler) throw new Error("MCP approval IPC handler was not registered.");

    await expect(
      handler(
        trustedEvent as never,
        { cwd: "/work/project", name: "docs", expectedFingerprint: "secret" } as never,
      ),
    ).rejects.toThrow();
    expect(mocks.approveMcpServer).not.toHaveBeenCalled();
  });
});

describe("built-in REA settings IPC", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };
  const reaIntegration = {
    getStatus: mocks.reaGetStatus,
    setEnabled: mocks.reaSetEnabled,
    retry: mocks.reaRetry,
  };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.reaGetStatus.mockReset();
    mocks.reaSetEnabled.mockReset();
    mocks.reaRetry.mockReset();
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc({ reaIntegration });
  });

  it("validates status, toggle, and retry requests and returns sanitized status", async () => {
    mocks.reaGetStatus.mockReturnValue({ enabled: true, status: "not_started", providerNotes: [] });
    mocks.reaSetEnabled.mockResolvedValue({
      enabled: false,
      status: "disabled",
      providerNotes: [],
    });
    mocks.reaRetry.mockReturnValue({ enabled: true, status: "not_started", providerNotes: [] });
    const getStatus = mocks.handlers.get(IPC_CHANNELS.reaGetStatus);
    const setEnabled = mocks.handlers.get(IPC_CHANNELS.reaSetEnabled);
    const retry = mocks.handlers.get(IPC_CHANNELS.reaRetry);
    if (!getStatus || !setEnabled || !retry) throw new Error("REA settings IPC handlers missing");

    expect(await getStatus(trustedEvent as never, undefined as never)).toEqual({
      enabled: true,
      status: "not_started",
      providerNotes: [],
    });
    expect(await setEnabled(trustedEvent as never, { enabled: false } as never)).toEqual({
      enabled: false,
      status: "disabled",
      providerNotes: [],
    });
    expect(await retry(trustedEvent as never, undefined as never)).toMatchObject({
      enabled: true,
      status: "not_started",
    });
    await expect(
      setEnabled(trustedEvent as never, { enabled: false, cwd: "project" } as never),
    ).rejects.toThrow(/invalid IPC payload/i);
    mocks.reaGetStatus.mockReturnValueOnce({
      enabled: true,
      status: "failed",
      note: "C:\\private\\provider stderr secret",
      providerNotes: [],
    });
    expect(() => getStatus(trustedEvent as never, undefined as never)).toThrow();
    expect(mocks.reaSetEnabled).toHaveBeenCalledTimes(1);
  });

  it("sanitizes persistence failures returned by the REA enable toggle", async () => {
    mocks.reaSetEnabled.mockRejectedValue(
      new Error("EACCES while writing C:\\private\\modus\\rea.json with secret details"),
    );
    const setEnabled = mocks.handlers.get(IPC_CHANNELS.reaSetEnabled);
    if (!setEnabled) throw new Error("REA enable IPC handler missing");

    let rendererError: unknown;
    try {
      await setEnabled(trustedEvent as never, { enabled: false } as never);
    } catch (error) {
      rendererError = error;
    }
    expect(rendererError).toBeInstanceOf(Error);
    expect(String(rendererError)).toContain("Unable to save REA settings.");
    expect(String(rendererError)).not.toContain("C:\\private");
    expect(String(rendererError)).not.toContain("secret details");
  });
});

describe("agent event page IPC", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.listAgentEventPage.mockReset();
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });

  it("does not expose unbounded full-history event reads over IPC", () => {
    expect(mocks.handlers.has("agent:list-events")).toBe(false);
    expect(mocks.handlers.has(IPC_CHANNELS.agentListEventPage)).toBe(true);
  });

  it("passes trusted bounded page requests to the stable-cursor store", () => {
    const page = { events: [], snapshotCursor: 42, hasMore: true, nextCursor: 31 };
    mocks.listAgentEventPage.mockReturnValue(page);
    const handler = mocks.handlers.get(IPC_CHANNELS.agentListEventPage);
    if (!handler) throw new Error("Agent event page IPC handler was not registered.");

    expect(
      handler(
        trustedEvent as never,
        {
          sessionId: "session-a",
          options: { direction: "backward", beforeCursor: 31, snapshotCursor: 42, limit: 128 },
        } as never,
      ),
    ).toEqual(page);
    expect(mocks.listAgentEventPage).toHaveBeenCalledWith("session-a", {
      direction: "backward",
      beforeCursor: 31,
      snapshotCursor: 42,
      limit: 128,
    });
  });

  it("routes run-scoped tool history requests through the same bounded store", () => {
    const page = { events: [], snapshotCursor: 42, hasMore: false };
    mocks.listAgentEventPage.mockReturnValue(page);
    const handler = mocks.handlers.get(IPC_CHANNELS.agentListEventPage);
    if (!handler) throw new Error("Agent event page IPC handler was not registered.");

    expect(
      handler(
        trustedEvent as never,
        {
          sessionId: "session-a",
          options: { direction: "forward", runId: "run-a", afterCursor: 0, limit: 64 },
        } as never,
      ),
    ).toEqual(page);
    expect(mocks.listAgentEventPage).toHaveBeenCalledWith("session-a", {
      direction: "forward",
      runId: "run-a",
      afterCursor: 0,
      limit: 64,
    });
  });

  it("rejects malformed page cursors before querying the store", () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.agentListEventPage);
    if (!handler) throw new Error("Agent event page IPC handler was not registered.");

    expect(() =>
      handler(
        trustedEvent as never,
        {
          sessionId: "session-a",
          options: { direction: "backward", beforeCursor: -1 },
        } as never,
      ),
    ).toThrow("Invalid IPC payload");
    expect(mocks.listAgentEventPage).not.toHaveBeenCalled();
  });
});

describe("groups retired (PR 4)", () => {
  beforeEach(() => mocks.handlers.clear());

  it("registers no group:* handler, and the migration notice/transcript handlers instead", () => {
    registerAppIpc();
    const groupChannels = [...mocks.handlers.keys()].filter((channel) =>
      String(channel).startsWith("group:"),
    );
    expect(groupChannels).toEqual([]);
    expect(mocks.handlers.has(IPC_CHANNELS.groupIntegrationPreview)).toBe(false);
    expect(mocks.handlers.has(IPC_CHANNELS.groupsMigrationNotice)).toBe(true);
    expect(mocks.handlers.has(IPC_CHANNELS.groupsMigrationNoticeDismiss)).toBe(true);
    expect(mocks.handlers.has(IPC_CHANNELS.migratedGroupTranscript)).toBe(true);
  });
});

describe("provider auth start IPC", () => {
  it("forwards the acknowledgement to the main service", async () => {
    const sender = { mainFrame: { url: "file:///app/index.html" } };
    registerTrustedSender(sender, "file:///app/index.html");
    mocks.handlers.clear();
    mocks.startProviderAuth.mockReset().mockReturnValue({
      id: "op",
      provider: "antigravity",
      status: "pending",
      message: "Preparing",
    });
    registerAppIpc();
    const handler = mocks.handlers.get(IPC_CHANNELS.modelProviderAuthStart);

    await handler?.(
      { sender, senderFrame: sender.mainFrame } as never,
      { provider: "antigravity", riskAcknowledged: true } as never,
    );

    expect(mocks.startProviderAuth).toHaveBeenCalledWith("antigravity", expect.any(Function), {
      riskAcknowledged: true,
    });
  });
});

describe("app version IPC", () => {
  it("returns app.getVersion() to a trusted renderer and rejects others", async () => {
    const sender = { mainFrame: { url: "file:///app/index.html" } };
    registerTrustedSender(sender, "file:///app/index.html");
    mocks.handlers.clear();
    registerAppIpc();
    const handler = mocks.handlers.get(IPC_CHANNELS.appVersion);

    expect(await handler?.({ sender, senderFrame: sender.mainFrame } as never)).toBe("test");
    expect(() =>
      handler?.({
        sender: { mainFrame: { url: "file:///attacker.html" } },
        senderFrame: { url: "file:///attacker.html" },
      } as never),
    ).toThrow("Blocked IPC call from untrusted renderer frame.");
  });
});

describe("subagent worktree IPC with Agent Group member sessions", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.getAgentSession.mockReset();
    // A member session with a group worktree: it has no parentSessionId.
    mocks.getAgentSession.mockReturnValue({
      id: "member-1",
      workspaceId: "workspace-1",
      cwd: "C:/workspace/.modus/worktrees/group-g1-alpha",
      subagentWorktree: {
        path: "C:/workspace/.modus/worktrees/group-g1-alpha",
        branch: "group/g1/alpha",
        baseSha: "abc123",
        integrationStatus: "applied",
      },
    });
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });

  it.each([
    IPC_CHANNELS.agentApplySubagentWorktree,
    IPC_CHANNELS.agentAbortSubagentWorktreeApply,
    IPC_CHANNELS.agentCleanupSubagentWorktree,
  ])("%s refuses a member session (no parentSessionId)", async (channel) => {
    const handler = mocks.handlers.get(channel);
    if (!handler) throw new Error(`${channel} was not registered.`);
    await expect(handler(trustedEvent as never, "member-1" as never)).rejects.toThrow(
      "Subagent worktree not found.",
    );
    // Refused before looking up any parent session or touching git.
    expect(mocks.getAgentSession).toHaveBeenCalledTimes(1);
    expect(mocks.getAgentSession).toHaveBeenCalledWith("member-1");
  });
});

describe("agent:prompt preserves the session model", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };
  const prompt = vi.fn(async () => ({ outcome: "ok" }));

  beforeEach(() => {
    mocks.handlers.clear();
    prompt.mockClear();
    mocks.getDefaultModelId.mockReset().mockReturnValue("anthropic/claude-opus-5-5");
    mocks.isUsableModelId.mockReset().mockReturnValue(true);
    mocks.getAgentSession.mockReset();
    mocks.getAgent.mockReset();
    mocks.requireAgentChatWritable.mockReset();
    mocks.fromWebContents.mockReturnValue(mocks.senderWindow);
    mocks.getAgentRuntime.mockReturnValue({ prompt });
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });

  it("an old session's model (sent by the renderer) and its thinking are ignored for the run", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      model: "anthropic/claude-opus-5-5",
    });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);
    await handler?.(
      trustedEvent as never,
      {
        sessionId: "session-1",
        message: "hi",
        model: "openai/old-disallowed",
        thinkingVariant: "max",
      } as never,
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input.model).toBe("anthropic/claude-opus-5-5");
    expect(input).not.toHaveProperty("thinkingVariant");
    expect(input).not.toHaveProperty("thinkingLevel");
  });

  it("preserves the exact Modus model selected for a 1:1 session", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      model: "modus/anthropic/claude-fable-5-1",
    });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);
    await handler?.(
      trustedEvent as never,
      { sessionId: "session-1", message: "hi", model: "modus/anthropic/claude-fable-5-1" } as never,
    );
    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input.model).toBe("modus/anthropic/claude-fable-5-1");
    expect(mocks.getAgentSession).toHaveBeenCalledWith("session-1");
  });

  it("a BYOK session keeps its stored model instead of the Settings default", async () => {
    mocks.getAgentSession.mockReturnValue({ id: "session-1", model: "openai/gpt-5" });
    mocks.getDefaultModelId.mockReturnValue("modus/deepseek/deepseek-flash");
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);
    await handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never);
    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input.model).toBe("openai/gpt-5");
  });

  it("preserves the model selected for a linked session over its agent setting", async () => {
    const sessionModel = "byok/session-selection";
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: sessionModel,
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/agent-model" });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);

    await handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never);

    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input.model).toBe(sessionModel);
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("uses the linked agent model when the session has no saved selection", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: null,
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/agent-model" });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);

    await handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never);

    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input.model).toBe("byok/agent-model");
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("uses the Settings default when a linked agent has no model", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: null,
    });
    mocks.getAgent.mockReturnValue({ modelId: null });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);

    await handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never);

    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input).toHaveProperty("model", null);
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("restores a saved session model when it differs from the linked agent", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: "byok/session-selection",
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/agent-model" });
    const ensure = vi.fn().mockResolvedValue({ id: "session-1" });
    mocks.getAgentRuntime.mockReturnValue({ ensure });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentEnsure);
    if (!handler) throw new Error("Agent ensure IPC handler was not registered.");

    await handler(trustedEvent as never, "session-1" as never);

    expect(ensure).toHaveBeenCalledWith(mocks.senderWindow, "session-1", "byok/session-selection");
  });

  it("uses the linked agent model to restore a session with no saved selection", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: null,
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/agent-model" });
    const ensure = vi.fn().mockResolvedValue({ id: "session-1" });
    mocks.getAgentRuntime.mockReturnValue({ ensure });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentEnsure);
    if (!handler) throw new Error("Agent ensure IPC handler was not registered.");

    await handler(trustedEvent as never, "session-1" as never);

    expect(ensure).toHaveBeenCalledWith(mocks.senderWindow, "session-1", "byok/agent-model");
  });

  it("passes the app-default directive into restoration for a linked agent without a model", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: null,
    });
    mocks.getAgent.mockReturnValue({ modelId: null });
    const ensure = vi.fn().mockResolvedValue({ id: "session-1" });
    mocks.getAgentRuntime.mockReturnValue({ ensure });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentEnsure);
    if (!handler) throw new Error("Agent ensure IPC handler was not registered.");

    await handler(trustedEvent as never, "session-1" as never);

    expect(ensure).toHaveBeenCalledWith(mocks.senderWindow, "session-1", null);
  });

  it("rejects a removed linked agent model before restoring its session", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: null,
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/removed-model" });
    mocks.isUsableModelId.mockReturnValue(false);
    const ensure = vi.fn().mockResolvedValue({ id: "session-1" });
    mocks.getAgentRuntime.mockReturnValue({ ensure });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentEnsure);
    if (!handler) throw new Error("Agent ensure IPC handler was not registered.");

    await expect(handler(trustedEvent as never, "session-1" as never)).rejects.toThrow(
      "Selected model is unavailable: byok/removed-model",
    );

    expect(ensure).not.toHaveBeenCalled();
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("defers a legacy session with no database model to runtime branch restoration", async () => {
    mocks.getAgentSession.mockReturnValue({ id: "session-1", model: undefined });
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);

    await handler?.(
      trustedEvent as never,
      {
        sessionId: "session-1",
        message: "hi",
        model: "renderer/untrusted",
      } as never,
    );

    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input).not.toHaveProperty("model");
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("defers an absent session choice to runtime when Settings has no default", async () => {
    mocks.getDefaultModelId.mockReturnValue(undefined);
    prompt.mockRejectedValueOnce(new Error("No model is configured"));
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);
    await expect(
      handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never),
    ).rejects.toThrow("No model is configured");
    expect(prompt).toHaveBeenCalledTimes(1);
    const input = (prompt.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input).not.toHaveProperty("model");
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it.each([
    "byok/removed-model",
    "modus/removed-model",
  ])("refuses unavailable explicit model %s without sending a request to the Settings default", async (selectedModel) => {
    mocks.getAgentSession.mockReturnValue({ id: "session-1", model: selectedModel });
    mocks.isUsableModelId.mockReturnValue(false);
    const handler = mocks.handlers.get(IPC_CHANNELS.agentPrompt);

    await expect(
      handler?.(trustedEvent as never, { sessionId: "session-1", message: "hi" } as never),
    ).rejects.toThrow(`Selected model is unavailable: ${selectedModel}`);

    expect(prompt).not.toHaveBeenCalled();
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });
});

describe("reviewStart preserves the session model", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.getAgentSession.mockReset();
    mocks.getAgent.mockReset();
    mocks.getAgentRuntime.mockReset();
    mocks.startAgentReview.mockReset().mockResolvedValue({ id: "review-1" });
    mocks.getDefaultModelId.mockReset().mockReturnValue("openai/current-default");
    mocks.isUsableModelId.mockReset().mockReturnValue(true);
    mocks.fromWebContents.mockReturnValue(mocks.senderWindow);
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });

  it("passes the exact stored session model to the dedicated review", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      model: "byok/session-model",
    });
    const handler = mocks.handlers.get(IPC_CHANNELS.reviewStart);
    if (!handler) throw new Error("Review start IPC handler was not registered.");

    await handler(
      trustedEvent as never,
      {
        cwd: "C:/workspace",
        sessionId: "session-1",
      } as never,
    );

    expect(mocks.startAgentReview).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "byok/session-model" }),
    );
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("preserves a linked session's selected model for review over its agent setting", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      agentId: "agent-1",
      model: "byok/session-selection",
    });
    mocks.getAgent.mockReturnValue({ modelId: "byok/agent-model" });
    const handler = mocks.handlers.get(IPC_CHANNELS.reviewStart);
    if (!handler) throw new Error("Review start IPC handler was not registered.");

    await handler(
      trustedEvent as never,
      {
        cwd: "C:/workspace",
        sessionId: "session-1",
      } as never,
    );

    expect(mocks.startAgentReview).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "byok/session-selection" }),
    );
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("restores an unlinked legacy branch before choosing the review model", async () => {
    mocks.getAgentSession.mockReturnValue({ id: "session-1" });
    const ensure = vi.fn().mockResolvedValue({ id: "session-1", model: "byok/legacy-model" });
    mocks.getAgentRuntime.mockReturnValue({ ensure });
    const handler = mocks.handlers.get(IPC_CHANNELS.reviewStart);
    if (!handler) throw new Error("Review start IPC handler was not registered.");

    await handler(
      trustedEvent as never,
      {
        cwd: "C:/workspace",
        sessionId: "session-1",
      } as never,
    );

    expect(ensure).toHaveBeenCalledWith(mocks.senderWindow, "session-1");
    expect(mocks.startAgentReview).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "byok/legacy-model" }),
    );
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });

  it("does not start a review on the default when the stored model is unavailable", async () => {
    mocks.getAgentSession.mockReturnValue({
      id: "session-1",
      model: "byok/removed-model",
    });
    mocks.isUsableModelId.mockReturnValue(false);
    const handler = mocks.handlers.get(IPC_CHANNELS.reviewStart);
    if (!handler) throw new Error("Review start IPC handler was not registered.");

    await expect(
      handler(
        trustedEvent as never,
        {
          cwd: "C:/workspace",
          sessionId: "session-1",
        } as never,
      ),
    ).rejects.toThrow("Selected model is unavailable: byok/removed-model");

    expect(mocks.startAgentReview).not.toHaveBeenCalled();
    expect(mocks.getDefaultModelId).not.toHaveBeenCalled();
  });
});

describe("agent workspace move IPC", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };
  const moveSession = vi.fn(async (_window: unknown, input: unknown) => input);
  beforeEach(() => {
    mocks.handlers.clear();
    moveSession.mockClear();
    mocks.fromWebContents.mockReturnValue(mocks.senderWindow);
    mocks.getAgentRuntime.mockReturnValue({ moveSession });
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });
  it("forwards a validated move with the trusted sender window", async () => {
    const input = { id: "session", workspaceId: "target", pinned: false };
    await expect(
      mocks.handlers.get("agent:move")?.(trustedEvent as never, input as never),
    ).resolves.toEqual(input);
    expect(moveSession).toHaveBeenCalledWith(mocks.senderWindow, input);
  });
  it("rejects foreign senders and renderer-supplied paths before calling the runtime", async () => {
    const handler = mocks.handlers.get("agent:move");
    await expect(
      handler?.(
        { senderFrame: { url: "https://foreign.invalid" } } as never,
        { id: "session", pinned: false } as never,
      ),
    ).rejects.toThrow();
    await expect(
      handler?.(
        trustedEvent as never,
        { id: "session", pinned: false, cwd: "/arbitrary" } as never,
      ),
    ).rejects.toThrow();
    expect(moveSession).not.toHaveBeenCalled();
  });
});

describe("agent queue IPC", () => {
  const sender = { mainFrame: { url: "file:///app/index.html" } };
  const trustedEvent = { sender, senderFrame: sender.mainFrame };
  const listQueuedPrompts = vi.fn(() => [
    { id: "q-1", delivery: "follow-up", text: "Then add a test", imageCount: 0 },
  ]);
  const removeQueuedPrompt = vi.fn(() => ({ removed: true }));
  beforeEach(() => {
    mocks.handlers.clear();
    listQueuedPrompts.mockClear();
    removeQueuedPrompt.mockClear();
    mocks.getAgentSession.mockReset();
    mocks.getAgentSession.mockReturnValue({ id: "session-1", workspaceId: "workspace-1" });
    mocks.getAgentRuntime.mockReturnValue({ listQueuedPrompts, removeQueuedPrompt });
    registerTrustedSender(sender, "file:///app/index.html");
    registerAppIpc();
  });

  it("lists the session's queue from the runtime", async () => {
    await expect(
      mocks.handlers.get(IPC_CHANNELS.agentQueueList)?.(
        trustedEvent as never,
        "session-1" as never,
      ),
    ).resolves.toEqual([
      { id: "q-1", delivery: "follow-up", text: "Then add a test", imageCount: 0 },
    ]);
    expect(listQueuedPrompts).toHaveBeenCalledWith("session-1");
  });

  it("removes one queued prompt by id through the runtime", async () => {
    await expect(
      mocks.handlers.get(IPC_CHANNELS.agentQueueRemove)?.(
        trustedEvent as never,
        { sessionId: "session-1", id: "q-1" } as never,
      ),
    ).resolves.toEqual({ removed: true });
    expect(removeQueuedPrompt).toHaveBeenCalledWith("session-1", "q-1");
  });

  it("rejects foreign senders and payloads without an id", async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.agentQueueRemove);
    await expect(
      handler?.(
        { senderFrame: { url: "https://foreign.invalid" } } as never,
        { sessionId: "session-1", id: "q-1" } as never,
      ),
    ).rejects.toThrow();
    await expect(
      handler?.(trustedEvent as never, { sessionId: "session-1" } as never),
    ).rejects.toThrow("Invalid IPC payload");
    expect(removeQueuedPrompt).not.toHaveBeenCalled();
  });
});
