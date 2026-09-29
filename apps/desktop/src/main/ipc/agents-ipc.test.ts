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

function mockService() {
  return {
    listAgents: vi.fn((): AgentInfo[] => [AGENT]),
    createAgent: vi.fn((_input: unknown): AgentInfo => AGENT),
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
          name: " Jennie ",
          role: "Reviewer",
          defaultWorkspaceId: null,
          avatarFace: "wink",
        }),
      ).toEqual(AGENT);
      expect(service.createAgent).toHaveBeenCalledWith({
        name: "Jennie",
        role: "Reviewer",
        defaultWorkspaceId: null,
        avatarFace: "wink",
      });
      expect(
        handlers.get("agents:update")?.(trusted, {
          id: "a-1",
          instructions: "Be terse.",
          modelId: null,
        }),
      ).toEqual([AGENT]);
      expect(service.updateAgent).toHaveBeenCalledWith("a-1", {
        instructions: "Be terse.",
        modelId: null,
      });
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
      expect(call("agents:create", { name: "  " })).toThrow(/Invalid IPC payload/);
      expect(call("agents:create", { name: "A", extra: 1 })).toThrow(/Invalid IPC payload/);
      expect(call("agents:update", { name: "A" })).toThrow(/Invalid IPC payload/);
      expect(call("agents:create", { name: "A", avatarFace: "angry" })).toThrow(
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
    service.createAgent.mockImplementation(() => {
      throw new GroupStoreError("agent-name-taken", "taken");
    });
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    try {
      expect(() => handlers.get("agents:create")?.(trusted, { name: "Jennie" })).toThrow(
        "[group-error:agent-name-taken] taken",
      );
    } finally {
      unregister();
    }
  });
});
