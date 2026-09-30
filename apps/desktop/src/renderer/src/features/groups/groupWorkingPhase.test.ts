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

  it("defaults a live turn to Thinking before any stream", () => {
    expect(groupMemberWorkingPhase([], "running")).toBe("Thinking");
    expect(groupMemberWorkingPhase([ev(runStarted)], "running")).toBe("Thinking");
  });

  it("tracks Thinking → tool verb → Writing from real events", () => {
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
    expect(groupMemberWorkingPhase(events.slice(0, 2), "running")).toBe("Thinking");
    expect(groupMemberWorkingPhase(events.slice(0, 3), "running")).toBe("Reading");
    expect(groupMemberWorkingPhase(events.slice(0, 4), "running")).toBe("Thinking");
    expect(groupMemberWorkingPhase(events, "running")).toBe("Writing");
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
