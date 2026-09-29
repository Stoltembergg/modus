import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentGroupWithMembers } from "../../shared/contracts";
import type { GroupIpcService } from "./group-ipc";
import type { TrustedSenderEvent } from "./trusted-sender";

let userData: string;

vi.mock("electron", () => ({
  app: {
    getPath: () => userData,
  },
}));

const GROUP_CHANNELS = [
  "group:list",
  "group:create",
  "group:rename",
  "group:delete",
  "group:add-member",
  "group:remove-member",
  "group:set-lead",
];

const GROUP: AgentGroupWithMembers = {
  id: "g-1",
  name: "Crew",
  mode: "free",
  members: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

type Handler = (event: TrustedSenderEvent, input?: unknown) => unknown;

function mockService() {
  return {
    listAgentGroupsWithMembers: vi.fn((): AgentGroupWithMembers[] => [GROUP]),
    createAgentGroupWithMembers: vi.fn((_input: unknown): AgentGroupWithMembers => GROUP),
    renameAgentGroup: vi.fn((_groupId: string, _name: string): unknown => undefined),
    deleteAgentGroup: vi.fn((_groupId: string): void => undefined),
    addAgentGroupMember: vi.fn((_input: unknown): unknown => undefined),
    removeAgentGroupMember: vi.fn((_groupId: string, _sessionId: string): void => undefined),
    setAgentGroupLead: vi.fn((_groupId: string, _sessionId: string | null): unknown => undefined),
  } satisfies GroupIpcService;
}

async function register(service: GroupIpcService) {
  const { registerGroupIpcHandlers } = await import("./group-ipc");
  const { assertTrustedSender } = await import("./trusted-sender");
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  };
  registerGroupIpcHandlers(ipcMain, assertTrustedSender, service);
  return handlers;
}

async function trustedEvent() {
  const { registerTrustedSender } = await import("./trusted-sender");
  const sender = { mainFrame: { url: "file:///index.html" } };
  const unregister = registerTrustedSender(sender, "file:///index.html");
  return { trusted: { sender, senderFrame: sender.mainFrame }, unregister };
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), "modus-group-ipc-test-"));
});

afterAll(async () => {
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
});

describe("group IPC", () => {
  it("registers every group channel", async () => {
    const handlers = await register(mockService());
    expect([...handlers.keys()].sort()).toEqual([...GROUP_CHANNELS].sort());
  });

  it("rejects untrusted senders before touching the store", async () => {
    const service = mockService();
    const handlers = await register(service);
    const event = { senderFrame: { url: "https://attacker.invalid/" } };
    for (const channel of GROUP_CHANNELS) {
      expect(() => handlers.get(channel)?.(event, undefined)).toThrow(
        "Blocked IPC call from untrusted renderer frame.",
      );
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("forwards valid calls and returns the refreshed list for mutations", async () => {
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    try {
      expect(handlers.get("group:list")?.(trusted, undefined)).toEqual([GROUP]);
      expect(
        handlers.get("group:create")?.(trusted, {
          name: "  Crew ",
          workspaceId: null,
          members: [{ sessionId: "s-1", role: "review" }, { sessionId: "s-2" }],
          leadSessionId: "s-1",
        }),
      ).toEqual(GROUP);
      expect(service.createAgentGroupWithMembers).toHaveBeenCalledWith({
        name: "Crew",
        workspaceId: null,
        members: [{ sessionId: "s-1", role: "review" }, { sessionId: "s-2" }],
        leadSessionId: "s-1",
      });
      expect(handlers.get("group:rename")?.(trusted, { id: "g-1", name: "New" })).toEqual([GROUP]);
      expect(service.renameAgentGroup).toHaveBeenCalledWith("g-1", "New");
      handlers.get("group:delete")?.(trusted, { id: "g-1" });
      expect(service.deleteAgentGroup).toHaveBeenCalledWith("g-1");
      handlers.get("group:add-member")?.(trusted, { groupId: "g-1", sessionId: "s-3" });
      expect(service.addAgentGroupMember).toHaveBeenCalledWith({
        groupId: "g-1",
        sessionId: "s-3",
      });
      handlers.get("group:remove-member")?.(trusted, { groupId: "g-1", sessionId: "s-3" });
      expect(service.removeAgentGroupMember).toHaveBeenCalledWith("g-1", "s-3");
      handlers.get("group:set-lead")?.(trusted, { groupId: "g-1", sessionId: null });
      expect(service.setAgentGroupLead).toHaveBeenCalledWith("g-1", null);
    } finally {
      unregister();
    }
  });

  it("rejects malformed payloads like the other IPC domains", async () => {
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    const call = (channel: string, input: unknown) => () => handlers.get(channel)?.(trusted, input);
    try {
      expect(call("group:list", { all: true })).toThrow(/Invalid IPC payload/);
      expect(call("group:create", { name: "   ", members: [] })).toThrow(/Invalid IPC payload/);
      expect(call("group:create", { name: "x" })).toThrow(/Invalid IPC payload/);
      expect(call("group:create", { name: "x", members: [], extra: 1 })).toThrow(
        /Invalid IPC payload/,
      );
      expect(call("group:create", { name: "x", members: [], mode: "chaos" })).toThrow(
        /Invalid IPC payload/,
      );
      expect(
        call("group:create", {
          name: "x",
          members: Array.from({ length: 33 }, (_, i) => ({ sessionId: `s-${i}` })),
        }),
      ).toThrow(/Invalid IPC payload/);
      expect(call("group:create", { name: "x".repeat(121), members: [] })).toThrow(
        /Invalid IPC payload/,
      );
      expect(call("group:rename", { id: "g-1" })).toThrow(/Invalid IPC payload/);
      expect(call("group:delete", "g-1")).toThrow(/Invalid IPC payload/);
      expect(call("group:add-member", { groupId: "g-1" })).toThrow(/Invalid IPC payload/);
      expect(call("group:remove-member", { groupId: "g-1", sessionId: "" })).toThrow(
        /Invalid IPC payload/,
      );
      expect(call("group:set-lead", { groupId: "g-1" })).toThrow(/Invalid IPC payload/);
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("group:create with the real store writes nothing when a member is refused", async () => {
    const { getDatabase } = await import("../db/database");
    const store = await import("../groups/group-store");
    const handlers = await register({
      listAgentGroupsWithMembers: () => store.listAgentGroupsWithMembers(),
      createAgentGroupWithMembers: store.createAgentGroupWithMembers,
      renameAgentGroup: store.renameAgentGroup,
      deleteAgentGroup: store.deleteAgentGroup,
      addAgentGroupMember: store.addAgentGroupMember,
      removeAgentGroupMember: store.removeAgentGroupMember,
      setAgentGroupLead: store.setAgentGroupLead,
    });
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values ('ws-ipc', 'root-ws-ipc', 'repo', 1, ?, ?)`,
    ).run(now, now);
    for (const id of ["s-ok", "s-taken"]) {
      db.prepare(
        `insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
         values (?, 'ws-ipc', ?, 'root-ws-ipc', 'idle', ?, ?)`,
      ).run(id, id, now, now);
    }
    const { trusted, unregister } = await trustedEvent();
    try {
      handlers.get("group:create")?.(trusted, {
        name: "First",
        workspaceId: "ws-ipc",
        members: [{ sessionId: "s-taken" }],
      });
      const before = handlers.get("group:list")?.(trusted, undefined) as AgentGroupWithMembers[];

      expect(() =>
        handlers.get("group:create")?.(trusted, {
          name: "Second",
          workspaceId: "ws-ipc",
          members: [{ sessionId: "s-ok" }, { sessionId: "s-taken" }],
          leadSessionId: "s-ok",
        }),
      ).toThrow(/already a member/);

      expect(handlers.get("group:list")?.(trusted, undefined)).toEqual(before);
      expect(store.getAgentGroupForSession("s-ok")).toBeUndefined();
      // No new sessions are created by group:create, so none need cleanup.
      const sessions = db.prepare("select count(*) as n from agent_sessions").get() as {
        n: number;
      };
      expect(Number(sessions.n)).toBe(2);
    } finally {
      unregister();
    }
  });
});
