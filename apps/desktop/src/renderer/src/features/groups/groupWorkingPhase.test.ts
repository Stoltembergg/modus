import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../../shared/contracts";
import { groupMemberWorkingPhase, listGroupWorkingSessionIds } from "./groupWorkingPhase";

const ev = (event: AgentEvent) => ({ event });

const runStarted = {
  type: "run.started",
  sessionId: "s",
  runId: "r",
  delivery: "normal",
} as AgentEvent;

describe("groupMemberWorkingPhase", () => {
  it("labels queued wakes without reading events", () => {
    expect(
      groupMemberWorkingPhase(
        [ev({ type: "thinking.delta", sessionId: "s", messageId: "m", delta: "…" })],
        "queued",
      ),
    ).toBe("Queued");
  });

  it("defaults a live turn to Waiting on model before any stream", () => {
    expect(groupMemberWorkingPhase([], "running")).toBe("Waiting on model");
    expect(groupMemberWorkingPhase([ev(runStarted)], "running")).toBe("Waiting on model");
  });

  it("tracks Waiting on model → Exploring → Writing from semantic presence", () => {
    const events = [
      ev(runStarted),
      ev({ type: "thinking.delta", sessionId: "s", messageId: "m1", delta: "plan" }),
      ev({
        type: "tool.started",
        sessionId: "s",
        toolCallId: "t1",
        toolName: "read",
      }),
      ev({ type: "tool.ended", sessionId: "s", toolCallId: "t1", isError: false }),
      ev({ type: "message.delta", sessionId: "s", messageId: "m2", delta: "hi" }),
    ];
    expect(groupMemberWorkingPhase(events.slice(0, 2), "running")).toBe("Waiting on model");
    expect(groupMemberWorkingPhase(events.slice(0, 3), "running")).toBe("Exploring");
    expect(groupMemberWorkingPhase(events.slice(0, 4), "running")).toBe("Waiting on model");
    expect(groupMemberWorkingPhase(events, "running")).toBe("Writing");
  });

  it("labels edit tools as Implementing", () => {
    expect(
      groupMemberWorkingPhase(
        [
          ev(runStarted),
          ev({ type: "tool.started", sessionId: "s", toolCallId: "t", toolName: "edit" }),
        ],
        "running",
      ),
    ).toBe("Implementing");
  });
});

describe("listGroupWorkingSessionIds", () => {
  it("lists running before queued and dedupes", () => {
    expect(
      listGroupWorkingSessionIds({
        runningSessionIds: ["a", "b"],
        queuedSessionIds: ["b", "c"],
      }),
    ).toEqual([
      { sessionId: "a", mode: "running" },
      { sessionId: "b", mode: "running" },
      { sessionId: "c", mode: "queued" },
    ]);
  });
});
