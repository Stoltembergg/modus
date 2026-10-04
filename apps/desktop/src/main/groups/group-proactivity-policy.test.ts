import { describe, expect, it } from "vitest";
import type { GroupDecisionSnapshot, GroupTaskTrigger } from "../../shared/group-work-state";
import { decideGroupNextAction } from "./group-proactivity-policy";

const member = (sessionId: string, archived = false) => ({
  groupId: "g",
  sessionId,
  agentId: sessionId,
  name: sessionId,
  agentRole: "",
  joinedAt: "2026-01-01",
  ...(archived ? { archived: true as const } : {}),
});
const task = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  groupId: "g",
  title: id,
  status: "in_progress" as const,
  ownerSessionId: "owner",
  reviewerSessionId: "reviewer",
  stateVersion: 2,
  executionId: "execution",
  priority: "normal" as const,
  dependencyIds: [],
  verificationPolicy: { mode: "required" as const, requireReview: true },
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  ...overrides,
});
const trigger = (
  kind: GroupTaskTrigger["kind"],
  overrides: Partial<GroupTaskTrigger> = {},
): GroupTaskTrigger => ({
  kind,
  groupId: "g",
  taskId: "t",
  taskVersion: 2,
  executionId: "execution",
  sourceEventId: "event",
  sequence: 1,
  ...overrides,
});
const snapshot = (overrides: Partial<GroupDecisionSnapshot> = {}): GroupDecisionSnapshot => ({
  mode: "opt_in_auto",
  stopRequested: false,
  waitingForUser: false,
  triggers: [trigger("task_assigned")],
  explicitWakeSourceEventIds: [],
  memberAvailability: { owner: "available", reviewer: "available" },
  reviewStates: { t: "pending" },
  workState: {
    groupId: "g",
    tasks: [task("t")],
    gates: { t: { satisfied: false, reasonCodes: ["review-required"] } },
    members: [member("owner"), member("reviewer")],
    execution: { id: "execution", stopped: false, waitingForUser: false },
    omitted: { tasks: 0, members: 0, criteria: 0 },
    budgets: { remainingAgentMessages: 5, remainingMemberWakes: 5, remainingInputTokens: 1000 },
  },
  ...overrides,
});

describe("decideGroupNextAction", () => {
  it.each([
    ["task_assigned", "wake_owner", "owner"],
    ["task_unblocked", "wake_owner", "owner"],
    ["review_requested", "wake_reviewer", "reviewer"],
    ["review_changes_requested", "wake_owner", "owner"],
    ["task_qa_updated", "wake_reviewer", "reviewer"],
  ] as const)("routes %s in opt-in mode", (kind, expectedKind, target) => {
    expect(
      decideGroupNextAction(
        snapshot({
          triggers: [trigger(kind)],
          reviewStates: {
            t: kind === "review_changes_requested" ? "changes_requested" : "pending",
          },
        }),
      ),
    ).toMatchObject({
      kind: expectedKind,
      targetSessionId: target,
      sourceEventId: "event",
      taskId: "t",
    });
  });

  it.each([
    "task_assigned",
    "task_unblocked",
    "review_requested",
    "review_changes_requested",
    "task_qa_updated",
  ] as const)("suggest mode only suggests for %s", (kind) => {
    const decision = decideGroupNextAction(
      snapshot({ mode: "suggest", triggers: [trigger(kind)] }),
    );
    expect(decision).toMatchObject({ kind: "suggest", taskId: "t", sourceEventId: "event" });
    expect(decision?.targetSessionId).toBeUndefined();
  });

  it("suppresses an already scheduled explicit wake", () => {
    expect(decideGroupNextAction(snapshot({ explicitWakeSourceEventIds: ["event"] }))).toBeNull();
  });

  it("is deterministic for identical snapshots and returns one winner", () => {
    const input = snapshot({
      triggers: [
        trigger("task_assigned"),
        trigger("review_requested", { sourceEventId: "later", sequence: 2 }),
      ],
    });
    expect(decideGroupNextAction(input)).toEqual(decideGroupNextAction(input));
    expect(decideGroupNextAction(input)?.sourceEventId).toBe("event");
    expect(decideGroupNextAction(input)?.idempotencyKey).toContain("event");
  });

  it("stop_or_waiting_user_prevents_auto_wake", () => {
    expect(decideGroupNextAction(snapshot({ stopRequested: true }))).toBeNull();
    expect(decideGroupNextAction(snapshot({ waitingForUser: true }))).toBeNull();
    expect(
      decideGroupNextAction(
        snapshot({
          workState: {
            ...snapshot().workState,
            execution: { id: "execution", stopped: true, waitingForUser: false },
          },
        }),
      ),
    ).toBeNull();
  });

  it("missing_qa_suggests_without_claiming_completion", () => {
    const decision = decideGroupNextAction(
      snapshot({
        triggers: [trigger("task_qa_updated")],
        workState: {
          ...snapshot().workState,
          gates: {
            t: { satisfied: false, reasonCodes: ["criterion-unverified", "review-required"] },
          },
        },
      }),
    );
    expect(decision).toMatchObject({ kind: "suggest", reasonCode: "qa-missing" });
  });

  it("unavailable_member_or_exhausted_budget_never_wakes", () => {
    expect(
      decideGroupNextAction(
        snapshot({ memberAvailability: { owner: "unavailable", reviewer: "available" } }),
      ),
    ).toMatchObject({ kind: "suggest", reasonCode: "member-unavailable" });
    expect(
      decideGroupNextAction(
        snapshot({
          workState: {
            ...snapshot().workState,
            budgets: {
              remainingAgentMessages: 5,
              remainingMemberWakes: 0,
              remainingInputTokens: 1000,
            },
          },
        }),
      ),
    ).toMatchObject({ kind: "suggest", reasonCode: "budget-exhausted" });
    expect(
      decideGroupNextAction(
        snapshot({
          workState: {
            ...snapshot().workState,
            members: [member("owner", true), member("reviewer")],
          },
        }),
      ),
    ).toMatchObject({ kind: "suggest", reasonCode: "member-unavailable" });
  });

  it("silence_and_public_text_are_not_events", () => {
    expect(decideGroupNextAction(snapshot({ triggers: [] }))).toBeNull();
    expect(
      decideGroupNextAction(
        snapshot({
          triggers: [
            { ...trigger("task_assigned"), kind: "Agreed" } as unknown as GroupTaskTrigger,
          ],
        }),
      ),
    ).toBeNull();
    expect(
      decideGroupNextAction(
        snapshot({
          triggers: [
            { ...trigger("task_assigned"), kind: "public_mention" } as unknown as GroupTaskTrigger,
          ],
        }),
      ),
    ).toBeNull();
  });

  it("rejects terminal, stale and mismatched triggers", () => {
    expect(
      decideGroupNextAction(
        snapshot({
          workState: { ...snapshot().workState, tasks: [task("t", { status: "done" })] },
        }),
      ),
    ).toBeNull();
    expect(
      decideGroupNextAction(
        snapshot({
          workState: { ...snapshot().workState, tasks: [task("t", { status: "cancelled" })] },
        }),
      ),
    ).toBeNull();
    expect(
      decideGroupNextAction(snapshot({ triggers: [trigger("task_assigned", { taskVersion: 1 })] })),
    ).toBeNull();
    expect(
      decideGroupNextAction(
        snapshot({ triggers: [trigger("task_assigned", { groupId: "other" })] }),
      ),
    ).toBeNull();
    expect(
      decideGroupNextAction(
        snapshot({ triggers: [trigger("task_assigned", { executionId: "old" })] }),
      ),
    ).toBeNull();
  });

  it("dependencies and required QA gates prevent reviewer wakes", () => {
    expect(
      decideGroupNextAction(
        snapshot({
          workState: { ...snapshot().workState, tasks: [task("t", { dependencyIds: ["dep"] })] },
        }),
      ),
    ).toMatchObject({ kind: "suggest", reasonCode: "dependency-incomplete" });
    expect(
      decideGroupNextAction(
        snapshot({
          triggers: [trigger("review_requested")],
          workState: {
            ...snapshot().workState,
            gates: {
              t: { satisfied: false, reasonCodes: ["criterion-unverified", "review-required"] },
            },
          },
        }),
      ),
    ).toMatchObject({ kind: "suggest", reasonCode: "qa-missing" });
  });

  it("arbitrates priority, then sequence, then task ID", () => {
    const workState = {
      ...snapshot().workState,
      tasks: [
        task("z", { priority: "high" }),
        task("a", { priority: "high" }),
        task("t", { priority: "low" }),
      ],
      gates: {
        z: { satisfied: true, reasonCodes: [] },
        a: { satisfied: true, reasonCodes: [] },
        t: { satisfied: true, reasonCodes: [] },
      },
    };
    const triggers = [
      trigger("task_assigned", { taskId: "t", sourceEventId: "low", sequence: 1 }),
      trigger("task_assigned", { taskId: "z", sourceEventId: "z", sequence: 3 }),
      trigger("task_assigned", { taskId: "a", sourceEventId: "a", sequence: 3 }),
    ];
    expect(decideGroupNextAction(snapshot({ workState, triggers }))?.taskId).toBe("a");
    expect(
      decideGroupNextAction(
        snapshot({
          workState,
          triggers: [
            ...triggers,
            trigger("task_assigned", { taskId: "z", sourceEventId: "earlier", sequence: 2 }),
          ],
        }),
      )?.sourceEventId,
    ).toBe("earlier");
  });
});
