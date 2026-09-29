import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentGroupWithMembers, GroupDecision, GroupTask } from "../../shared/contracts";
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
  "group:update-members",
  "group:list-tasks",
  "group:cancel-task",
  "group:list-decisions",
  "group:delete-decision",
  "group:set-mode",
  "group:set-workspace",
];

const MODEL = "openai/gpt-5";
const agentSpec = (name: string) => ({ name, modelId: MODEL });

const GROUP: AgentGroupWithMembers = {
  id: "g-1",
  name: "Crew",
  mode: "free",
  members: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const TASK: GroupTask = {
  id: "t-1",
  groupId: "g-1",
  title: "Parser",
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const DECISION: GroupDecision = {
  id: "d-1",
  groupId: "g-1",
  text: "Use SQLite",
  authorSessionId: "s-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

type Handler = (event: TrustedSenderEvent, input?: unknown) => unknown;

function mockService() {
  return {
    listAgentGroupsWithMembers: vi.fn((): AgentGroupWithMembers[] => [GROUP]),
    createAgentGroupWithMembers: vi.fn((_input: unknown): AgentGroupWithMembers => GROUP),
    isModelAvailable: vi.fn((modelId: string) => modelId === MODEL),
    renameAgentGroup: vi.fn((_groupId: string, _name: string): unknown => undefined),
    deleteAgentGroup: vi.fn((_groupId: string): void => undefined),
    addAgentGroupMember: vi.fn((_input: unknown): unknown => undefined),
    removeAgentGroupMember: vi.fn((_groupId: string, _sessionId: string): void => undefined),
    setAgentGroupLead: vi.fn((_groupId: string, _sessionId: string | null): unknown => undefined),
    setAgentGroupMode: vi.fn(
      (_groupId: string, _mode: "free" | "coordinator"): unknown => undefined,
    ),
    setAgentGroupWorkspace: vi.fn(
      (_groupId: string, _workspaceId: string | null): unknown => undefined,
    ),
    updateAgentGroupMembers: vi.fn((_input: unknown): AgentGroupWithMembers => GROUP),
    listGroupTasks: vi.fn((_groupId: string): GroupTask[] => [TASK]),
    cancelGroupTask: vi.fn((_taskId: string): GroupTask => ({ ...TASK, status: "cancelled" })),
    listGroupDecisions: vi.fn((_groupId: string): GroupDecision[] => [DECISION]),
    deleteGroupDecision: vi.fn((_decisionId: string): GroupDecision => DECISION),
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
          workspaceId: "ws-1",
          members: [
            { ...agentSpec("Ana"), role: "Reviewer" },
            { name: "Bo", templateId: "planner" },
          ],
          leadName: "Ana",
        }),
      ).toEqual(GROUP);
      expect(service.createAgentGroupWithMembers).toHaveBeenCalledWith({
        name: "Crew",
        workspaceId: "ws-1",
        members: [
          { ...agentSpec("Ana"), role: "Reviewer" },
          { name: "Bo", templateId: "planner" },
        ],
        leadName: "Ana",
      });
      expect(handlers.get("group:rename")?.(trusted, { id: "g-1", name: "New" })).toEqual([GROUP]);
      expect(service.renameAgentGroup).toHaveBeenCalledWith("g-1", "New");
      handlers.get("group:delete")?.(trusted, { id: "g-1" });
      expect(service.deleteAgentGroup).toHaveBeenCalledWith("g-1");
      handlers.get("group:add-member")?.(trusted, { groupId: "g-1", agentId: "a-3" });
      expect(service.addAgentGroupMember).toHaveBeenCalledWith({ groupId: "g-1", agentId: "a-3" });
      handlers.get("group:set-workspace")?.(trusted, { groupId: "g-1", workspaceId: "ws-2" });
      expect(service.setAgentGroupWorkspace).toHaveBeenCalledWith("g-1", "ws-2");
      handlers.get("group:remove-member")?.(trusted, { groupId: "g-1", sessionId: "s-3" });
      expect(service.removeAgentGroupMember).toHaveBeenCalledWith("g-1", "s-3");
      handlers.get("group:set-lead")?.(trusted, { groupId: "g-1", sessionId: null });
      expect(service.setAgentGroupLead).toHaveBeenCalledWith("g-1", null);
      expect(
        handlers.get("group:set-mode")?.(trusted, { groupId: "g-1", mode: "coordinator" }),
      ).toEqual([GROUP]);
      expect(service.setAgentGroupMode).toHaveBeenCalledWith("g-1", "coordinator");
      expect(
        handlers.get("group:update-members")?.(trusted, {
          groupId: "g-1",
          add: [agentSpec("Cy"), { ...agentSpec("Di"), role: "verify" }],
          removeAgentIds: [],
          lead: { name: "Cy" },
        }),
      ).toEqual([GROUP]);
      expect(service.updateAgentGroupMembers).toHaveBeenCalledWith({
        groupId: "g-1",
        add: [agentSpec("Cy"), { ...agentSpec("Di"), role: "verify" }],
        removeAgentIds: [],
        lead: { name: "Cy" },
      });
      expect(handlers.get("group:list-tasks")?.(trusted, { groupId: "g-1" })).toEqual([TASK]);
      expect(service.listGroupTasks).toHaveBeenCalledWith("g-1");
      expect(handlers.get("group:cancel-task")?.(trusted, { taskId: "t-1" })).toMatchObject({
        status: "cancelled",
      });
      expect(service.cancelGroupTask).toHaveBeenCalledWith("t-1");
      expect(handlers.get("group:list-decisions")?.(trusted, { groupId: "g-1" })).toEqual([
        DECISION,
      ]);
      expect(service.listGroupDecisions).toHaveBeenCalledWith("g-1");
      expect(handlers.get("group:delete-decision")?.(trusted, { decisionId: "d-1" })).toEqual(
        DECISION,
      );
      expect(service.deleteGroupDecision).toHaveBeenCalledWith("d-1");
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
          workspaceId: "ws",
          members: Array.from({ length: 33 }, (_, i) => agentSpec(`A${i}`)),
        }),
      ).toThrow(/Invalid IPC payload/);
      expect(call("group:create", { name: "x".repeat(121), members: [] })).toThrow(
        /Invalid IPC payload/,
      );
      expect(call("group:rename", { id: "g-1" })).toThrow(/Invalid IPC payload/);
      expect(call("group:delete", "g-1")).toThrow(/Invalid IPC payload/);
      expect(call("group:add-member", { groupId: "g-1" })).toThrow(/Invalid IPC payload/);
      expect(call("group:set-workspace", { groupId: "g-1" })).toThrow(/Invalid IPC payload/);
      expect(call("group:remove-member", { groupId: "g-1", sessionId: "" })).toThrow(
        /Invalid IPC payload/,
      );
      expect(call("group:set-lead", { groupId: "g-1" })).toThrow(/Invalid IPC payload/);
      expect(call("group:set-mode", { groupId: "g-1", mode: "chaos" })).toThrow(
        /Invalid IPC payload/,
      );
      expect(call("group:set-mode", { groupId: "g-1" })).toThrow(/Invalid IPC payload/);
      expect(call("group:update-members", { groupId: "g-1", members: [] })).toThrow(
        /Invalid IPC payload/,
      );
      expect(call("group:list-tasks", { groupId: "" })).toThrow(/Invalid IPC payload/);
      expect(call("group:cancel-task", { taskId: "t-1", status: "done" })).toThrow(
        /Invalid IPC payload/,
      );
      expect(call("group:list-decisions", { groupId: "" })).toThrow(/Invalid IPC payload/);
      expect(call("group:list-decisions", "g-1")).toThrow(/Invalid IPC payload/);
      expect(call("group:delete-decision", { decisionId: "" })).toThrow(/Invalid IPC payload/);
      expect(call("group:delete-decision", { decisionId: "x".repeat(129) })).toThrow(
        /Invalid IPC payload/,
      );
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("group:delete-decision is the user's only: a member session in the payload is refused", async () => {
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    try {
      for (const input of [
        { decisionId: "d-1", sessionId: "s-1" },
        { decisionId: "d-1", actorSessionId: "s-1" },
        { decisionId: "d-1", authorSessionId: "s-1" },
      ]) {
        expect(() => handlers.get("group:delete-decision")?.(trusted, input)).toThrow(
          /Invalid IPC payload/,
        );
      }
      expect(service.deleteGroupDecision).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("group:delete-decision with the real store deletes the row and posts nothing", async () => {
    const store = await import("../groups/group-store");
    const { decodeGroupErrorMessage } = await import("../../shared/group-errors");
    const handlers = await register({
      ...mockService(),
      listGroupDecisions: (groupId) => store.listGroupDecisions(groupId),
      deleteGroupDecision: store.deleteGroupDecision,
    });
    const group = store.createAgentGroup({ name: "Decisions" });
    const keep = store.recordGroupDecision({ groupId: group.id, text: "Keep" });
    const drop = store.recordGroupDecision({ groupId: group.id, text: "Drop" });
    const { trusted, unregister } = await trustedEvent();
    try {
      expect(
        (
          handlers.get("group:list-decisions")?.(trusted, { groupId: group.id }) as GroupDecision[]
        ).map((decision) => decision.id),
      ).toEqual([drop.id, keep.id]);
      expect(
        handlers.get("group:delete-decision")?.(trusted, { decisionId: drop.id }),
      ).toMatchObject({ id: drop.id });
      expect(store.listGroupDecisions(group.id).map((decision) => decision.id)).toEqual([keep.id]);
      expect(store.listGroupMessages(group.id)).toEqual([]);
      let caught: unknown;
      try {
        handlers.get("group:delete-decision")?.(trusted, { decisionId: drop.id });
      } catch (error) {
        caught = error;
      }
      expect(decodeGroupErrorMessage(caught).code).toBe("decision-not-found");
    } finally {
      unregister();
    }
  });

  it("group:create with the real store: new agents, and nothing written when one is refused", async () => {
    const { getDatabase } = await import("../db/database");
    const store = await import("../groups/group-store");
    const agents = await import("../agents/agents-store");
    const handlers = await register({
      ...mockService(),
      listAgentGroupsWithMembers: () => store.listAgentGroupsWithMembers(),
      createAgentGroupWithMembers: (input) => agents.createGroupWithNewAgents(input),
    });
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
       values ('ws-ipc', 'root-ws-ipc', 'repo', 1, ?, ?)`,
    ).run(now, now);
    const count = (table: string) =>
      Number((db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n);
    const { trusted, unregister } = await trustedEvent();
    try {
      const created = handlers.get("group:create")?.(trusted, {
        name: "First",
        workspaceId: "ws-ipc",
        members: [agentSpec("Ana"), agentSpec("Bo")],
        leadName: "ana",
      }) as AgentGroupWithMembers;
      expect(created.members.map((member) => member.name)).toEqual(["Ana", "Bo"]);
      expect(created.leadSessionId).toBe(created.members[0]?.sessionId);
      const before = [count("agent_groups"), count("agents"), count("agent_sessions")];

      // Two agents with the same name in one group: the second is refused, all rolls back.
      expect(() =>
        handlers.get("group:create")?.(trusted, {
          name: "Second",
          workspaceId: "ws-ipc",
          members: [agentSpec("Cy"), agentSpec("cy")],
        }),
      ).toThrow(/^\[group-error:agent-name-taken\] /);
      expect([count("agent_groups"), count("agents"), count("agent_sessions")]).toEqual(before);
    } finally {
      unregister();
    }
  });

  it("group:update-members with the real store: one transaction, final-state rules", async () => {
    const { getDatabase } = await import("../db/database");
    const store = await import("../groups/group-store");
    const agents = await import("../agents/agents-store");
    const service = {
      ...mockService(),
      listAgentGroupsWithMembers: () => store.listAgentGroupsWithMembers(),
      updateAgentGroupMembers: (input: Parameters<GroupIpcService["updateAgentGroupMembers"]>[0]) =>
        agents.updateGroupMembers(input).group,
    };
    const handlers = await register(service);
    const now = new Date().toISOString();
    getDatabase()
      .prepare(
        `insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
         values ('ws-upd', 'root-ws-upd', 'repo', 1, ?, ?)`,
      )
      .run(now, now);
    const group = agents.createGroupWithNewAgents({
      name: "Swap",
      workspaceId: "ws-upd",
      members: [agentSpec("Ana"), agentSpec("Bo")],
      leadName: "Ana",
    });
    const oldIds = group.members.map((member) => member.agentId);
    const { trusted, unregister } = await trustedEvent();
    const update = (input: Record<string, unknown>) => () =>
      handlers.get("group:update-members")?.(trusted, {
        groupId: group.id,
        add: [],
        removeAgentIds: [],
        lead: null,
        ...input,
      });
    try {
      // Fewer than 2 in the final state, or a model-less new agent: refused before the store.
      expect(update({ removeAgentIds: [oldIds[0]] })).toThrow(
        /^\[group-error:group-min-members\] /,
      );
      expect(update({ add: [{ name: "Cy" }] })).toThrow(/^\[group-error:agent-model-required\] /);
      // Replace both members at once: add 2 new, remove the 2 old, lead a new one.
      const listed = update({
        add: [agentSpec("Cy"), agentSpec("Di")],
        removeAgentIds: oldIds,
        lead: { name: "Di" },
      })() as AgentGroupWithMembers[];
      const after = listed.find((row) => row.id === group.id);
      expect(after?.members.map((member) => member.name)).toEqual(["Cy", "Di"]);
      expect(after?.leadSessionId).toBe(after?.members[1]?.sessionId);
      for (const agentId of oldIds) expect(agents.getAgent(agentId)).toBeUndefined();
    } finally {
      unregister();
    }
  });

  it("group:create refuses no folder, the member count and the model rule before the store", async () => {
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    const create = (input: Record<string, unknown>) => () =>
      handlers.get("group:create")?.(trusted, {
        name: "x",
        workspaceId: "ws",
        members: [agentSpec("A"), agentSpec("B")],
        ...input,
      });
    try {
      expect(create({ workspaceId: null })).toThrow(/^\[group-error:group-project-required\] /);
      expect(create({ workspaceId: "modus-inbox-chats" })).toThrow(
        /^\[group-error:group-project-required\] /,
      );
      expect(create({ members: [agentSpec("A")] })).toThrow(/^\[group-error:group-min-members\] /);
      expect(create({ members: Array.from({ length: 11 }, (_, i) => agentSpec(`A${i}`)) })).toThrow(
        /^\[group-error:group-max-members\] /,
      );
      expect(create({ members: [{ name: "A" }, agentSpec("B")] })).toThrow(
        /^\[group-error:agent-model-required\] /,
      );
      expect(create({ members: [{ name: "A", modelId: "gone/x" }, agentSpec("B")] })).toThrow(
        /^\[group-error:agent-model-unavailable\] /,
      );
      expect(service.createAgentGroupWithMembers).not.toHaveBeenCalled();
      create({ members: Array.from({ length: 10 }, (_, i) => agentSpec(`A${i}`)) })();
      create({ members: [{ name: "T", templateId: "planner" }, agentSpec("B")] })();
      expect(service.createAgentGroupWithMembers).toHaveBeenCalledTimes(2);
      expect(() =>
        handlers.get("group:set-workspace")?.(trusted, { groupId: "g-1", workspaceId: null }),
      ).toThrow(/^\[group-error:group-project-required\] /);
      expect(service.setAgentGroupWorkspace).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("add refuses an 11th member and remove refuses at 2 (archived members count)", async () => {
    const member = (index: number) => ({
      groupId: "g-1",
      sessionId: `s-${index}`,
      agentId: `a-${index}`,
      name: `A${index}`,
      agentRole: "",
      joinedAt: "2026-01-01T00:00:00.000Z",
      ...(index === 0 ? { archived: true as const } : {}),
    });
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    try {
      service.listAgentGroupsWithMembers.mockReturnValue([
        { ...GROUP, members: Array.from({ length: 10 }, (_, i) => member(i)) },
      ]);
      expect(() =>
        handlers.get("group:add-member")?.(trusted, { groupId: "g-1", agentId: "a-new" }),
      ).toThrow(/^\[group-error:group-max-members\] /);
      service.listAgentGroupsWithMembers.mockReturnValue([
        { ...GROUP, members: [member(0), member(1)] },
      ]);
      expect(() =>
        handlers.get("group:remove-member")?.(trusted, { groupId: "g-1", sessionId: "s-1" }),
      ).toThrow(/^\[group-error:group-min-members\] /);
      expect(service.addAgentGroupMember).not.toHaveBeenCalled();
      expect(service.removeAgentGroupMember).not.toHaveBeenCalled();
      // At 3 the removal goes through.
      service.listAgentGroupsWithMembers.mockReturnValue([
        { ...GROUP, members: [member(0), member(1), member(2)] },
      ]);
      handlers.get("group:remove-member")?.(trusted, { groupId: "g-1", sessionId: "s-2" });
      expect(service.removeAgentGroupMember).toHaveBeenCalledWith("g-1", "s-2");
    } finally {
      unregister();
    }
  });

  it("preserves GroupStoreError.code across the IPC boundary", async () => {
    const { GroupStoreError } = await import("../groups/group-store");
    const { decodeGroupErrorMessage } = await import("../../shared/group-errors");
    const service = mockService();
    service.updateAgentGroupMembers.mockImplementation(() => {
      throw new GroupStoreError("archived-session", "Session s-9 is archived.");
    });
    service.renameAgentGroup.mockImplementation(() => {
      throw new Error("disk full");
    });
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    try {
      let caught: unknown;
      try {
        handlers.get("group:update-members")?.(trusted, {
          groupId: "g-1",
          add: [agentSpec("A9"), agentSpec("A8")],
          removeAgentIds: [],
          lead: null,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      // Only `message` survives Electron's IPC; simulate its wrapper prefix too.
      const wire = `Error invoking remote method 'group:update-members': Error: ${(caught as Error).message}`;
      expect(decodeGroupErrorMessage(new Error(wire))).toEqual({
        code: "archived-session",
        message: "Session s-9 is archived.",
      });
      // Non-group errors pass through without a code.
      expect(() => handlers.get("group:rename")?.(trusted, { id: "g-1", name: "x" })).toThrow(
        /^disk full$/,
      );
    } finally {
      unregister();
    }
  });
});
