import { describe, expect, it, vi } from "vitest";
import type { AgentGroupMember, GroupTask } from "../../shared/contracts";
import type { GroupWorkState } from "../../shared/group-work-state";
import { ToolRegistry } from "../agent/tools/registry";
import { routeGroupTask } from "./group-capability-router";

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
    ).toMatchObject({ kind: "needs_user", reasonCode: "capability-incompatible" });
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
