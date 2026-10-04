import { describe, expect, it } from "vitest";
import type { GroupMessage, GroupRuntimeEvent } from "../../../../shared/contracts";
import { shouldRefreshGroupSidePanel } from "./groupSidePanelRefresh";

const msg = (kind: GroupMessage["kind"]): GroupMessage => ({
  id: "m1",
  groupId: "g-1",
  authorKind: "system",
  kind,
  body: "x",
  mentions: [],
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("shouldRefreshGroupSidePanel", () => {
  it("ignores other groups and project-setup events", () => {
    expect(
      shouldRefreshGroupSidePanel("g-1", {
        type: "group.activity",
        groupId: "g-2",
        runningSessionIds: [],
        queuedSessionIds: [],
        waitingSessionIds: [],
      }),
    ).toBe(false);
    expect(
      shouldRefreshGroupSidePanel("g-1", {
        type: "group.project-setup",
        workspaceId: "ws",
        groupId: "g-1",
        status: "ready",
        fingerprint: "f",
        edgeCount: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as GroupRuntimeEvent),
    ).toBe(false);
  });

  it("refreshes on activity and chain-ended for this group", () => {
    expect(
      shouldRefreshGroupSidePanel("g-1", {
        type: "group.activity",
        groupId: "g-1",
        runningSessionIds: ["a"],
        queuedSessionIds: [],
        waitingSessionIds: [],
      }),
    ).toBe(true);
    expect(
      shouldRefreshGroupSidePanel("g-1", {
        type: "group.chain-ended",
        groupId: "g-1",
        chainId: "c",
        reason: "stopped",
      }),
    ).toBe(true);
  });

  it("refreshes on a versioned task change for this group", () => {
    expect(
      shouldRefreshGroupSidePanel("g-1", {
        type: "group.task-changed",
        groupId: "g-1",
        taskId: "t-1",
        stateVersion: 2,
      }),
    ).toBe(true);
    expect(
      shouldRefreshGroupSidePanel("g-1", {
        type: "group.task-changed",
        groupId: "g-2",
        taskId: "t-1",
        stateVersion: 2,
      }),
    ).toBe(false);
  });

  it("refreshes suggestions and mode after versioned proactivity events", () => {
    expect(
      shouldRefreshGroupSidePanel("g-1", {
        type: "group.suggestion-changed",
        groupId: "g-1",
        actionId: "a-1",
        version: 2,
      }),
    ).toBe(true);
    expect(
      shouldRefreshGroupSidePanel("g-1", {
        type: "group.proactivity-mode-changed",
        groupId: "g-1",
        mode: "suggest",
      }),
    ).toBe(true);
  });

  it("refreshes only status messages, not ordinary chat messages", () => {
    expect(
      shouldRefreshGroupSidePanel("g-1", {
        type: "group.message",
        groupId: "g-1",
        message: msg("status"),
      }),
    ).toBe(true);
    expect(
      shouldRefreshGroupSidePanel("g-1", {
        type: "group.message",
        groupId: "g-1",
        message: msg("message"),
      }),
    ).toBe(false);
  });
});
