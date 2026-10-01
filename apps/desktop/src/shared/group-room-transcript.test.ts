import { describe, expect, it } from "vitest";
import type { GroupCollabStatus } from "./group-collab-status";
import {
  collectRoomMessageDetails,
  formatNaturalCollabStatus,
  inlineLiveStatusLabel,
  isHandoffPacketLine,
  isLiveStreamReconciled,
  isNearBottom,
  isOrchestrationOnlyRoomMessage,
  parseHandoffPacketLine,
  shouldPersistCollabStatusInTranscript,
  shouldShowInFlightRow,
  splitRoomMessageBody,
} from "./group-room-transcript";

describe("splitRoomMessageBody", () => {
  it("peels ops packet fields out of prose and keeps trailing collab statuses", () => {
    const body = [
      "Here is the plan.",
      "Owner: @Builder",
      "Objective: wire the toggle",
      "Inputs: design.md",
      "Deliverable: PR",
      "Constraints: no force-push",
      "Approval: human before merge",
      "Handoff → @Builder · wire the toggle",
    ].join("\n");
    expect(splitRoomMessageBody(body)).toEqual({
      prose: "Here is the plan.",
      statuses: [{ kind: "handoff", targetName: "Builder", objective: "wire the toggle" }],
      details: [
        { key: "Owner", value: "@Builder" },
        { key: "Objective", value: "wire the toggle" },
        { key: "Inputs", value: "design.md" },
        { key: "Deliverable", value: "PR" },
        { key: "Constraints", value: "no force-push" },
        { key: "Approval", value: "human before merge" },
      ],
    });
  });

  it("recognizes packet lines case-insensitively", () => {
    expect(isHandoffPacketLine("owner: @X")).toBe(true);
    expect(parseHandoffPacketLine("Objective: ship it")).toEqual({
      key: "Objective",
      value: "ship it",
    });
    expect(isHandoffPacketLine("Hello Owner:")).toBe(false);
  });
});

describe("formatNaturalCollabStatus", () => {
  it("renders handoffs as natural @phrases without typed prefixes", () => {
    const handoff: GroupCollabStatus = {
      kind: "handoff",
      targetName: "Builder",
      objective: "revise only the confirmed blockers",
    };
    expect(formatNaturalCollabStatus(handoff)).toBe("@Builder, revise only the confirmed blockers");
    expect(
      formatNaturalCollabStatus({ kind: "handoff", targetName: "Reviewer", objective: "" }),
    ).toBe("@Reviewer, please take this from here.");
  });

  it("keeps block / ask tones readable without IDs", () => {
    expect(formatNaturalCollabStatus({ kind: "blocked", reason: "missing design" })).toBe(
      "Blocked — missing design",
    );
    expect(formatNaturalCollabStatus({ kind: "ready" })).toBe("Ready for you");
  });
});

describe("inlineLiveStatusLabel", () => {
  it("shows exploring / waiting / tests living status", () => {
    expect(inlineLiveStatusLabel({ phase: "Exploring", presenceState: "exploring" })).toBe(
      "Exploring…",
    );
    expect(
      inlineLiveStatusLabel({
        phase: "Waiting",
        presenceState: "waiting_for_agent",
        waitingFor: "Planner",
      }),
    ).toBe("Waiting for @Planner…");
    expect(
      inlineLiveStatusLabel({
        phase: "Working",
        presenceState: "running_tool",
        activity: "Running tests",
      }),
    ).toBe("Running tests…");
    expect(
      inlineLiveStatusLabel({
        phase: "Waiting on model",
        presenceState: "thinking",
      }),
    ).toBe("Waiting on model…");
  });

  it("yields Still working… after silence", () => {
    expect(inlineLiveStatusLabel({ phase: "Thinking", stillWorking: true })).toBe("Still working…");
  });

  it("appends queued age", () => {
    expect(
      inlineLiveStatusLabel({
        phase: "Queued",
        presenceState: "queued",
        startedAt: 10_000,
        nowMs: 25_000,
      }),
    ).toBe("Queued · 15s");
  });
});

describe("isNearBottom", () => {
  it("gates auto-follow to near-bottom only", () => {
    expect(isNearBottom(1000, 940, 50)).toBe(true); // 10px from bottom
    expect(isNearBottom(1000, 800, 50)).toBe(false); // 150px from bottom
    expect(isNearBottom(1000, 903, 50)).toBe(true); // 47px < 48 threshold
    expect(isNearBottom(1000, 902, 50)).toBe(false); // exactly 48 is not near
  });
});

describe("isLiveStreamReconciled / shouldShowInFlightRow", () => {
  const msg = (body: string, sessionId = "s-lead") => ({
    authorKind: "agent",
    authorSessionId: sessionId,
    kind: "message",
    body,
  });

  it("reconciles when persist matches or extends the stream", () => {
    expect(isLiveStreamReconciled("s-lead", "Hello", [msg("Hello")])).toBe(true);
    expect(isLiveStreamReconciled("s-lead", "Hello", [msg("Hello world")])).toBe(true);
    expect(isLiveStreamReconciled("s-lead", "Hello world", [msg("Hello")])).toBe(true);
    expect(isLiveStreamReconciled("s-lead", "Hello", [msg("Other")])).toBe(false);
    expect(isLiveStreamReconciled("s-lead", "Hello", [msg("Hello", "s-other")])).toBe(false);
  });

  it("lingers streamed rows until reconcile and drops status-only when idle", () => {
    expect(
      shouldShowInFlightRow({
        sessionId: "s-lead",
        streamText: "Draft",
        collapsed: true,
        stillWorking: false,
        messages: [],
      }),
    ).toBe(true);
    expect(
      shouldShowInFlightRow({
        sessionId: "s-lead",
        streamText: "Draft",
        collapsed: true,
        stillWorking: false,
        messages: [msg("Draft")],
      }),
    ).toBe(false);
    expect(
      shouldShowInFlightRow({
        sessionId: "s-lead",
        streamText: "",
        collapsed: false,
        stillWorking: true,
        messages: [],
      }),
    ).toBe(true);
    expect(
      shouldShowInFlightRow({
        sessionId: "s-lead",
        streamText: "",
        collapsed: true,
        stillWorking: false,
        messages: [],
      }),
    ).toBe(false);
  });
});

describe("collectRoomMessageDetails", () => {
  it("aggregates packet fields across messages", () => {
    expect(
      collectRoomMessageDetails([
        { body: "hi\nOwner: @A\nObjective: one" },
        { body: "Constraints: none" },
      ]),
    ).toEqual([
      { key: "Owner", value: "@A" },
      { key: "Objective", value: "one" },
      { key: "Constraints", value: "none" },
    ]);
  });
});

describe("orchestration handoff hide rule", () => {
  it("classifies structured handoffs by collab kind (not string heuristics)", () => {
    expect(
      isOrchestrationOnlyRoomMessage({
        kind: "status",
        body: "Handoff → @Builder · fix symlink escapes",
      }),
    ).toBe(true);
    expect(
      isOrchestrationOnlyRoomMessage({
        kind: "message",
        body: "Handoff → @Builder · Implement the open task",
      }),
    ).toBe(true);
    expect(
      isOrchestrationOnlyRoomMessage({
        kind: "message",
        body: "Here is the plan for you.\nHandoff → @Builder · wire it",
      }),
    ).toBe(false);
    expect(
      isOrchestrationOnlyRoomMessage({
        kind: "status",
        body: "Blocked · missing design",
      }),
    ).toBe(false);
    expect(shouldPersistCollabStatusInTranscript({ kind: "ready" })).toBe(false);
    expect(
      shouldPersistCollabStatusInTranscript({
        kind: "handoff",
        targetName: "Builder",
        objective: "x",
      }),
    ).toBe(false);
    expect(shouldPersistCollabStatusInTranscript({ kind: "agreed", note: "ship" })).toBe(true);
  });
});
