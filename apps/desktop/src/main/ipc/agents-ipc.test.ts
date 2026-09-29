import { describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../../shared/contracts";
import type { AgentsIpcService } from "./agents-ipc";
import type { TrustedSenderEvent } from "./trusted-sender";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));

// `agent:*` already names the session channels, so the agents entity uses `agents:*`.
const AGENTS_CHANNELS = [
  "agents:list",
  "agents:create",
  "agents:update",
  "agents:archive",
  "agents:delete",
];

const AGENT: AgentInfo = {
  id: "a-1",
  name: "Jennie",
  role: "",
  instructions: "",
  avatarFace: "happy",
  avatarColor: "blue",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

type Handler = (event: TrustedSenderEvent, input?: unknown) => unknown;

const MODEL = "openai/gpt-5";

function mockService() {
  return {
    listAgents: vi.fn((): AgentInfo[] => [AGENT]),
    createAgentInGroup: vi.fn((_input: unknown): AgentInfo => AGENT),
    getAgent: vi.fn((_id: string): AgentInfo | undefined => ({ ...AGENT, modelId: MODEL })),
    isModelAvailable: vi.fn((modelId: string) => modelId === MODEL),
    updateAgent: vi.fn((_id: string, _input: unknown): AgentInfo => AGENT),
    setAgentArchived: vi.fn((_id: string, _archived: boolean): AgentInfo => AGENT),
    deleteAgent: vi.fn((_id: string): void => undefined),
  } satisfies AgentsIpcService;
}

async function register(service: AgentsIpcService) {
  const { registerAgentsIpcHandlers } = await import("./agents-ipc");
  const { assertTrustedSender } = await import("./trusted-sender");
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  };
  registerAgentsIpcHandlers(ipcMain, assertTrustedSender, service);
  return handlers;
}

async function trustedEvent() {
  const { registerTrustedSender } = await import("./trusted-sender");
  const sender = { mainFrame: { url: "file:///index.html" } };
  const unregister = registerTrustedSender(sender, "file:///index.html");
  return { trusted: { sender, senderFrame: sender.mainFrame }, unregister };
}

describe("agents IPC", () => {
  it("registers exactly the agents channels", async () => {
    const handlers = await register(mockService());
    expect([...handlers.keys()].sort()).toEqual([...AGENTS_CHANNELS].sort());
  });

  it("rejects untrusted senders before touching the store", async () => {
    const service = mockService();
    const handlers = await register(service);
    const event = { senderFrame: { url: "https://attacker.invalid/" } };
    for (const channel of AGENTS_CHANNELS) {
      expect(() => handlers.get(channel)?.(event, undefined)).toThrow(
        "Blocked IPC call from untrusted renderer frame.",
      );
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("forwards valid calls; mutations other than create return the refreshed list", async () => {
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    try {
      expect(handlers.get("agents:list")?.(trusted, undefined)).toEqual([AGENT]);
      expect(
        handlers.get("agents:create")?.(trusted, {
          groupId: "g-1",
          name: " Jennie ",
          role: "Reviewer",
          modelId: MODEL,
          defaultWorkspaceId: null,
          avatarFace: "wink",
        }),
      ).toEqual(AGENT);
      expect(service.createAgentInGroup).toHaveBeenCalledWith({
        groupId: "g-1",
        name: "Jennie",
        role: "Reviewer",
        modelId: MODEL,
        defaultWorkspaceId: null,
        avatarFace: "wink",
      });
      expect(
        handlers.get("agents:update")?.(trusted, {
          id: "a-1",
          instructions: "Be terse.",
        }),
      ).toEqual([AGENT]);
      expect(service.updateAgent).toHaveBeenCalledWith("a-1", { instructions: "Be terse." });
      expect(handlers.get("agents:archive")?.(trusted, { id: "a-1", archived: true })).toEqual([
        AGENT,
      ]);
      expect(service.setAgentArchived).toHaveBeenCalledWith("a-1", true);
      expect(handlers.get("agents:delete")?.(trusted, { id: "a-1" })).toEqual([AGENT]);
      expect(service.deleteAgent).toHaveBeenCalledWith("a-1");
    } finally {
      unregister();
    }
  });

  it("rejects malformed payloads", async () => {
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    const call = (channel: string, input: unknown) => () => handlers.get(channel)?.(trusted, input);
    try {
      expect(call("agents:list", { all: true })).toThrow(/Invalid IPC payload/);
      expect(call("agents:create", { groupId: "g", name: "  " })).toThrow(/Invalid IPC payload/);
      expect(call("agents:create", { groupId: "g", name: "A", extra: 1 })).toThrow(
        /Invalid IPC payload/,
      );
      // An agent belongs to one group: groupId is required.
      expect(call("agents:create", { name: "A", modelId: MODEL })).toThrow(/Invalid IPC payload/);
      expect(call("agents:update", { name: "A" })).toThrow(/Invalid IPC payload/);
      expect(call("agents:create", { groupId: "g", name: "A", avatarFace: "angry" })).toThrow(
        /Invalid IPC payload/,
      );
      expect(call("agents:update", { id: "a-1", avatarColor: "black" })).toThrow(
        /Invalid IPC payload/,
      );
      expect(call("agents:archive", { id: "a-1" })).toThrow(/Invalid IPC payload/);
      expect(call("agents:delete", {})).toThrow(/Invalid IPC payload/);
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("serializes store error codes like the group IPC", async () => {
    const { GroupStoreError } = await import("../groups/group-store");
    const service = mockService();
    service.createAgentInGroup.mockImplementation(() => {
      throw new GroupStoreError("agent-name-taken", "taken");
    });
    service.deleteAgent.mockImplementation(() => {
      throw new GroupStoreError("group-min-members", "A group needs at least 2 agents.");
    });
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    try {
      expect(() =>
        handlers.get("agents:create")?.(trusted, { groupId: "g", name: "Jennie", modelId: MODEL }),
      ).toThrow("[group-error:agent-name-taken] taken");
      expect(() => handlers.get("agents:delete")?.(trusted, { id: "a-1" })).toThrow(
        /^\[group-error:group-min-members\] /,
      );
    } finally {
      unregister();
    }
  });

  it("the model rule: required and configured without a template; templates are exempt", async () => {
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    const create = (input: Record<string, unknown>) => () =>
      handlers.get("agents:create")?.(trusted, { groupId: "g", name: "A", ...input });
    try {
      expect(create({})).toThrow(/^\[group-error:agent-model-required\] /);
      expect(create({ modelId: null })).toThrow(/^\[group-error:agent-model-required\] /);
      expect(create({ modelId: "gone/model" })).toThrow(
        /^\[group-error:agent-model-unavailable\] /,
      );
      expect(service.createAgentInGroup).not.toHaveBeenCalled();
      // A template agent needs no model (the app default applies).
      create({ templateId: "planner" })();
      expect(service.createAgentInGroup).toHaveBeenCalledWith({
        groupId: "g",
        name: "A",
        templateId: "planner",
      });
      // Update: clearing or changing to an unknown model is refused...
      const update = (input: Record<string, unknown>) => () =>
        handlers.get("agents:update")?.(trusted, { id: "a-1", ...input });
      expect(update({ modelId: null })).toThrow(/^\[group-error:agent-model-required\] /);
      expect(update({ modelId: "gone/model" })).toThrow(
        /^\[group-error:agent-model-unavailable\] /,
      );
      // ...a stored model is not re-checked when the payload leaves it alone...
      service.isModelAvailable.mockReturnValue(false);
      update({ name: "B" })();
      // ...and an agent without a model must get one on its next update.
      service.getAgent.mockReturnValue(AGENT);
      expect(update({ name: "C" })).toThrow(/^\[group-error:agent-model-required\] /);
      // Template agents are exempt on update too.
      service.getAgent.mockReturnValue({ ...AGENT, templateId: "planner" });
      update({ modelId: null })();
      expect(service.updateAgent).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
    }
  });
});
