import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../shared/contracts";
import { mergeActivitySnapshots, reduceActivity } from "../features/agent/agentEventHub";

describe("App session activity hydration", () => {
  it("hydrates multiple pending inputs from the session list snapshot", () => {
    const activity = mergeActivitySnapshots({}, [
      {
        id: "session-1",
        status: "running",
        activitySnapshot: {
          eventCursor: 21,
          pendingInputRequestIds: ["question:q1", "permission:p1"],
        },
      },
    ]);

    expect(activity["session-1"]).toMatchObject({
      running: true,
      needsInput: true,
      pendingInputRequestIds: ["question:q1", "permission:p1"],
      eventCursor: 21,
    });
  });

  it("does not overwrite activity changed after the list snapshot was read", () => {
    const live = reduceActivity(
      undefined,
      {
        type: "question.requested",
        sessionId: "session-1",
        request: { id: "new-question", questions: [] },
        eventCursor: 30,
      } as AgentEvent,
      false,
    );
    const activity = mergeActivitySnapshots({ "session-1": live }, [
      {
        id: "session-1",
        status: "idle",
        activitySnapshot: { eventCursor: 29, pendingInputRequestIds: [] },
      },
    ]);

    expect(activity["session-1"]).toBe(live);
    expect(activity["session-1"]?.needsInput).toBe(true);
  });
});
