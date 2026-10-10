import { describe, expect, it } from "vitest";
import { appendAgentEvents, createAgentEventAccumulator } from "./agent-events";
import type { AgentEvent } from "./contracts";

function deltaItem(delta: string, eventCursor: number) {
  return {
    id: `delta-${eventCursor}`,
    event: {
      type: "message.delta",
      sessionId: "session",
      messageId: "message",
      delta,
      eventCursor,
    } as AgentEvent,
    createdAt: `2026-01-01T00:00:0${eventCursor}.000Z`,
  };
}

describe("agent event folding", () => {
  it("folds deltas across pages with one persistent accumulator index", () => {
    const accumulator = createAgentEventAccumulator([deltaItem("first", 1)]);
    accumulator.append([deltaItem(" second", 2)]);
    accumulator.append([deltaItem(" third", 3)]);

    expect(accumulator.items()).toHaveLength(1);
    expect(accumulator.items()[0]?.event).toMatchObject({
      type: "message.delta",
      delta: "first second third",
      eventCursor: 3,
    });
  });

  it("keeps appendAgentEvents immutable while reusing the accumulator fold rules", () => {
    const first = deltaItem("first", 1);
    const next = appendAgentEvents([first], [deltaItem(" second", 2)]);

    expect(first.event).toMatchObject({ delta: "first", eventCursor: 1 });
    expect(next[0]?.event).toMatchObject({ delta: "first second", eventCursor: 2 });
  });
});
