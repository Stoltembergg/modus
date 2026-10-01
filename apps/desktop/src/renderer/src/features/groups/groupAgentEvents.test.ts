import { describe, expect, it } from "vitest";
import type { AgentEventItem } from "../../../../shared/agent-events";
import type { AgentEvent } from "../../../../shared/contracts";
import { compactGroupAgentEvents, mergeGroupAgentSeed } from "./groupAgentEvents";

const item = (event: AgentEvent, eventCursor: number): AgentEventItem => ({
  id: String(eventCursor),
  event: { ...event, eventCursor },
  createdAt: "2026-10-01T00:00:00.000Z",
});
const start = (runId: string, cursor: number) =>
  item({ type: "run.started", sessionId: "s", runId, delivery: "normal" }, cursor);
const delta = (text: string, cursor: number) =>
  item({ type: "message.delta", sessionId: "s", messageId: "m", delta: text }, cursor);

describe("group event snapshot cursor", () => {
  it("merges repeated identical chunks only after the seed cursor", () => {
    const merged = mergeGroupAgentSeed(
      [start("r", 1), delta("abcabc", 3)],
      [delta("abc", 2), delta("abc", 3), delta("abc", 4)],
      "working",
    );
    expect(
      merged
        .filter(({ event }) => event.type === "message.delta")
        .map(({ event }) => (event.type === "message.delta" ? event.delta : "")),
    ).toEqual(["abcabcabc"]);
  });
  it("folds a long stream into one part and keeps the newest cursor", () => {
    const compact = compactGroupAgentEvents(
      [
        start("old", 1),
        delta("old text", 2),
        start("new", 3),
        ...Array.from({ length: 1_000 }, (_, index) => delta("x", index + 4)),
      ],
      "working",
    );
    expect(compact).toHaveLength(2);
    expect(compact[0]?.event).toMatchObject({ type: "run.started", runId: "new" });
    expect(compact[1]?.event).toMatchObject({
      type: "message.delta",
      delta: "x".repeat(1_000),
      eventCursor: 1_003,
    });
  });
  it("keeps the current run boundary while bounding completed activity parts", () => {
    const compact = compactGroupAgentEvents(
      [
        start("r", 1),
        ...Array.from({ length: 1_000 }, (_, index) =>
          item(
            { type: "tool.ended", sessionId: "s", toolCallId: `tool-${index}`, isError: false },
            index + 2,
          ),
        ),
      ],
      "working",
    );
    expect(compact.length).toBeLessThanOrEqual(512);
    expect(compact[0]?.event).toMatchObject({ type: "run.started", runId: "r" });
    expect(compact.at(-1)?.event).toMatchObject({ type: "tool.ended", toolCallId: "tool-999" });
  });
  it("keeps one current question state per request id", () => {
    const compact = compactGroupAgentEvents(
      [
        item(
          { type: "question.requested", sessionId: "s", request: { id: "q", questions: [] } },
          1,
        ),
        item(
          {
            type: "question.resolved",
            sessionId: "s",
            requestId: "q",
            answers: [],
            skipped: false,
          },
          2,
        ),
      ],
      "questions",
    );
    expect(compact.map(({ event }) => event.type)).toEqual(["question.resolved"]);
  });
});
