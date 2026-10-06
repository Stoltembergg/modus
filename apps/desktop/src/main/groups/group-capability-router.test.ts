import { describe, expect, it, vi } from "vitest";
import type { AgentGroupMember, GroupTask } from "../../shared/contracts";
import type { GroupWorkState } from "../../shared/group-work-state";
import { ToolRegistry } from "../agent/tools/registry";
import { type GroupRoutingInput, routeGroupTask } from "./group-capability-router";

const task: GroupTask = {
  id: "task",
  groupId: "g",
  title: "hello",
  kind: "code",
  stage: "implement",
  status: "in_progress",
  priority: "normal",
  createdAt: "now",
  updatedAt: "now",
};
const member = (id: string, capabilityIds = ["implement"]): AgentGroupMember => ({
  sessionId: id,
  groupId: "g",
  agentId: id,
  name: id,
  agentRole: "",
  joinedAt: "now",
  capabilityIds,
  supportedTaskKinds: ["code"],
});
const state = (members: AgentGroupMember[]): GroupWorkState => ({
  groupId: "g",
  tasks: [task],
  members,
  gates: {},
  omitted: { tasks: 0, members: 0, criteria: 0 },
  budgets: { remainingAgentMessages: 10, remainingMemberWakes: 10, remainingInputTokens: 10000 },
});
const input = (members = [member("a"), member("b"), member("lead", ["plan"])]) => ({
  task,
  workState: state(members),
  leadSessionId: "lead",
  memberAvailability: Object.fromEntries(members.map((m) => [m.sessionId, "available" as const])),
  currentLoad: {},
  toolConfigurations: Object.fromEntries(
    members.map((m) => [m.sessionId, { profile: "chat" as const }]),
  ),
});

describe("routeGroupTask", () => {
  it("explicit_mention_takes_priority", () => {
    expect(
      routeGroupTask({
        ...input(),
        task: { ...task, ownerSessionId: "a" },
        explicitMentionSessionId: "b",
      }),
    ).toMatchObject({ kind: "selected", targetSessionId: "b", reasonCode: "explicit-mention" });
  });
  it("never silently replaces an unavailable explicit mention", () => {
    for (const [id, reasonCode] of [
      ["b", "member-unavailable"],
      ["missing", "member-absent"],
    ] as const) {
      const result = routeGroupTask({
        ...input(),
        memberAvailability: { a: "available", b: "unavailable", lead: "available" },
        explicitMentionSessionId: id,
      });
      expect(result).toMatchObject({ kind: "needs_user", targetSessionId: id, reasonCode });
    }
    expect(
      routeGroupTask({ ...input([member("b", [])]), explicitMentionSessionId: "b" }),
    ).toMatchObject({ kind: "needs_user", reasonCode: "capabilities-unconfigured" });
    expect(
      routeGroupTask({
        ...input([{ ...member("b"), archived: true }]),
        explicitMentionSessionId: "b",
      }),
    ).toMatchObject({ kind: "needs_user", reasonCode: "member-archived" });
  });
  it("busy_or_permission_incompatible_member_is_not_auto_selected", () => {
    const registry = new ToolRegistry();
    const resolve = vi.spyOn(registry, "resolveActiveTools");
    const classify = vi.spyOn(registry, "classify");
    const config = { profile: "chat" as const, overrides: { disable: ["edit", "write"] } };
    expect(
      routeGroupTask({
        ...input(),
        memberAvailability: { a: "unavailable", b: "available", lead: "available" },
        toolConfigurations: { a: { profile: "chat" }, b: config, lead: { profile: "chat" } },
        toolRegistry: registry,
      }),
    ).toMatchObject({
      kind: "suggest_lead",
      targetSessionId: "lead",
      reasonCode: "no-capability-match",
    });
    expect(resolve).toHaveBeenCalledWith("chat", config.overrides);
    expect(classify).not.toHaveBeenCalled();
    expect(config.overrides).toEqual({ disable: ["edit", "write"] });
    expect(registry.resolveActiveTools("chat", config.overrides)).not.toContain("edit");
  });
  it("routes against the runtime's effective active tools when available", () => {
    const registry = new ToolRegistry();
    const resolve = vi.spyOn(registry, "resolveActiveTools");
    const base = input();
    const result = routeGroupTask({
      ...base,
      task: { ...task, ownerSessionId: "a" },
      toolConfigurations: {
        a: { profile: "chat", activeToolNames: ["read"] },
        b: { profile: "chat", activeToolNames: ["read", "edit"] },
        lead: { profile: "chat", activeToolNames: ["read"] },
      },
      toolRegistry: registry,
    });

    expect(result).toMatchObject({
      kind: "selected",
      targetSessionId: "b",
      reasonCode: "capability-match",
    });
    expect(resolve).not.toHaveBeenCalled();
  });
  it("renamed_portuguese_and_english_roles_route_identically", () => {
    const base = input();
    for (const title of ["oi", "review implement README", "implemente correção".repeat(80)]) {
      const renamed = base.workState.members.map((m) => ({
        ...m,
        name: title,
        role: title,
        agentRole: title,
      }));
      expect(
        routeGroupTask({
          ...base,
          task: { ...task, title, description: title },
          workState: { ...base.workState, members: renamed },
        }),
      ).toEqual(routeGroupTask(base));
    }
  });
  it("no_capabilities_or_no_lead_needs_user", () => {
    expect(routeGroupTask(input([member("a", [])]))).toMatchObject({
      kind: "needs_user",
      reasonCode: "no-eligible-lead",
    });
    expect(routeGroupTask(input([member("lead", [])]))).toMatchObject({
      kind: "suggest_lead",
      targetSessionId: "lead",
    });
  });
  it("uses owner then priority then current load then sessionId deterministically", () => {
    expect(
      routeGroupTask({ ...input(), task: { ...task, ownerSessionId: "b" }, currentLoad: { b: 5 } })
        .targetSessionId,
    ).toBe("b");
    expect(
      routeGroupTask({
        ...input(),
        workState: {
          ...input().workState,
          tasks: [task, { ...task, id: "other", priority: "high", ownerSessionId: "b" }],
        },
        currentLoad: { b: 5 },
      }).targetSessionId,
    ).toBe("b");
    expect(routeGroupTask({ ...input(), currentLoad: { a: 2, b: 1 } }).targetSessionId).toBe("b");
    expect(routeGroupTask(input([member("b"), member("a")])).targetSessionId).toBe("a");
  });
  it("requires verification tools from typed criteria and respects dependency gates", () => {
    expect(
      routeGroupTask({
        ...input([member("a", ["verify"])]),
        task: {
          ...task,
          stage: "verify",
          criteria: [{ id: "c", description: "", requiredCheckKinds: ["tests"] }],
        },
        toolConfigurations: { a: { profile: "review" } },
      }),
    ).toMatchObject({ kind: "needs_user" });
    expect(
      routeGroupTask({ ...input(), task: { ...task, dependencyIds: ["missing"] } }),
    ).toMatchObject({ kind: "needs_user", reasonCode: "dependency-incomplete" });
  });
});

describe("capability metadata and dispatch snapshots", () => {
  const dispatch = (
    availability: "available" | "busy-but-queueable" | "hard-unavailable",
    pendingTaskJobCount = 0,
    capacity = 2,
  ) => ({ availability, pendingTaskJobCount, capacity });
  const withDispatch = (memberDispatch: NonNullable<GroupRoutingInput["memberDispatch"]>) => ({
    ...input(),
    memberDispatch,
  });

  it("accepts custom registered tool capabilities without requiring built-in names", () => {
    const registry = new ToolRegistry();
    const read = registry.getEntry("read");
    if (!read) throw new Error("Missing built-in read tool");
    registry.registerTool({
      entry: { ...read, name: "project_io", capabilities: ["read", "write"] },
      definition: { name: "project_io" } as Parameters<
        ToolRegistry["registerTool"]
      >[0]["definition"],
    });
    const base = input([member("a")]);
    expect(
      routeGroupTask({
        ...base,
        toolRegistry: registry,
        toolConfigurations: { a: { profile: "chat", activeToolNames: ["project_io"] } },
      }),
    ).toMatchObject({ kind: "selected", targetSessionId: "a" });
  });
  it("requires network capability for research", () => {
    const members = [{ ...member("a", ["research"]), supportedTaskKinds: ["research" as const] }];
    const read = new ToolRegistry().getEntry("read");
    if (!read) throw new Error("Missing built-in read tool");
    const registry = new ToolRegistry([{ ...read, name: "web_search", capabilities: ["network"] }]);
    const base = {
      ...input(members),
      toolRegistry: registry,
      task: { ...task, kind: "research" as const },
    };
    expect(
      routeGroupTask({
        ...base,
        toolConfigurations: { a: { profile: "chat", activeToolNames: ["read"] } },
      }),
    ).toMatchObject({ kind: "needs_user" });
    expect(
      routeGroupTask({
        ...base,
        toolConfigurations: { a: { profile: "chat", activeToolNames: ["web_search"] } },
      }),
    ).toMatchObject({ kind: "selected" });
  });
  it("queues compatible busy explicit targets and preserves their precedence", () => {
    expect(
      routeGroupTask({
        ...withDispatch({
          a: dispatch("available"),
          b: dispatch("busy-but-queueable", 1),
          lead: dispatch("available"),
        }),
        explicitMentionSessionId: "b",
      }),
    ).toMatchObject({ kind: "selected", targetSessionId: "b", reasonCode: "explicit-mention" });
  });
  it("selects busy members with a queue slot when other members are hard unavailable", () => {
    expect(
      routeGroupTask(
        withDispatch({
          a: dispatch("hard-unavailable"),
          b: dispatch("busy-but-queueable", 1),
          lead: dispatch("hard-unavailable"),
        }),
      ),
    ).toMatchObject({
      kind: "selected",
      targetSessionId: "b",
      candidateSessionIds: ["b"],
      eligibleSessionIds: ["b"],
    });
  });
  it("rejects full queues, hard unavailable members and missing snapshots", () => {
    for (const memberDispatch of [
      { b: dispatch("busy-but-queueable", 2) },
      { b: dispatch("available", 2) },
      { b: dispatch("hard-unavailable") },
      {},
    ]) {
      expect(
        routeGroupTask({ ...withDispatch(memberDispatch), explicitMentionSessionId: "b" }),
      ).toMatchObject({
        kind: "needs_user",
        reasonCode: "member-unavailable",
        candidateSessionIds: [],
      });
    }
  });
  it("returns candidates by queue load and stable session IDs", () => {
    const base = withDispatch({
      a: dispatch("available", 1, 3),
      b: dispatch("busy-but-queueable", 0, 3),
      lead: dispatch("available"),
    });
    expect(routeGroupTask(base)).toMatchObject({
      targetSessionId: "b",
      candidateSessionIds: ["b", "a"],
    });
    expect(
      routeGroupTask({
        ...base,
        memberDispatch: {
          ...base.memberDispatch,
          a: dispatch("available"),
          b: dispatch("available"),
        },
        workState: state([member("b"), member("a")]),
      }),
    ).toMatchObject({ targetSessionId: "a", candidateSessionIds: ["a", "b"] });
  });
  it("keeps missing member capabilities unconfigured and legacy tasks on the lead path", () => {
    const unconfigured = member("a");
    delete unconfigured.capabilityIds;
    expect(
      routeGroupTask({
        ...input([unconfigured]),
        explicitMentionSessionId: "a",
      }),
    ).toMatchObject({ reasonCode: "capabilities-unconfigured" });
    const missingKind = { ...task };
    delete missingKind.kind;
    for (const legacy of [missingKind, { ...task, kind: "legacy" as const }]) {
      expect(routeGroupTask({ ...input(), task: legacy })).toMatchObject({
        kind: "suggest_lead",
        targetSessionId: "lead",
      });
    }
  });
  it("requires read capability and an independent reviewer", () => {
    const base = input([member("a", ["review"]), member("b", ["review"])]);
    const reviewing = {
      ...task,
      status: "in_review" as const,
      ownerSessionId: "a",
      reviewerSessionId: "b",
    };
    expect(
      routeGroupTask({ ...base, task: reviewing, explicitMentionSessionId: "a" }),
    ).toMatchObject({ kind: "needs_user", reasonCode: "capability-incompatible" });
    expect(
      routeGroupTask({
        ...base,
        task: reviewing,
        toolConfigurations: {
          a: { profile: "chat", activeToolNames: ["read"] },
          b: { profile: "chat", activeToolNames: ["edit"] },
        },
      }),
    ).toMatchObject({ kind: "needs_user" });
  });
});
