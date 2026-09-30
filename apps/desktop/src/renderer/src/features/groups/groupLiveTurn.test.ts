import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../../shared/contracts";
import { buildGroupLiveTurn, isStillWorking, STILL_WORKING_AFTER_MS } from "./groupLiveTurn";

const ev = (event: AgentEvent, createdAt?: string) =>
  createdAt ? { event, createdAt } : { event };

const runStarted = {
  type: "run.started",
  sessionId: "s",
  runId: "r",
  delivery: "normal",
} as AgentEvent;

describe("buildGroupLiveTurn", () => {
  it("returns Queued with empty previews", () => {
    const snap = buildGroupLiveTurn(
      [ev({ type: "thinking.delta", sessionId: "s", messageId: "m", delta: "x" })],
      "queued",
    );
    expect(snap.phase).toBe("Queued");
    expect(snap.thoughtPreview).toBe("");
    expect(snap.tools).toEqual([]);
  });

  it("streams thought, tools, and writing into previews", () => {
    const events = [
      ev(runStarted, "2026-01-01T00:00:00.000Z"),
      ev(
        { type: "thinking.delta", sessionId: "s", messageId: "m1", delta: "Plan the toggle" },
        "2026-01-01T00:00:01.000Z",
      ),
      ev(
        { type: "tool.started", sessionId: "s", toolCallId: "t1", toolName: "read" },
        "2026-01-01T00:00:02.000Z",
      ),
      ev(
        { type: "tool.ended", sessionId: "s", toolCallId: "t1", toolName: "read", isError: false },
        "2026-01-01T00:00:03.000Z",
      ),
      ev(
        {
          type: "message.delta",
          sessionId: "s",
          messageId: "m2",
          delta: "I'll hand off to Builder",
        },
        "2026-01-01T00:00:04.000Z",
      ),
    ];
    const snap = buildGroupLiveTurn(events, "running");
    expect(snap.phase).toBe("Writing");
    expect(snap.thoughtPreview).toContain("Plan the toggle");
    expect(snap.tools).toEqual([{ id: "t1", name: "read", label: "Reading", done: true }]);
    expect(snap.writingPreview).toContain("hand off");
    expect(snap.lastEventAt).toBe(Date.parse("2026-01-01T00:00:04.000Z"));
  });

  it("keeps open tools as not done and caps the list", () => {
    const events = [
      ev(runStarted),
      ...Array.from({ length: 6 }, (_, i) =>
        ev({
          type: "tool.started",
          sessionId: "s",
          toolCallId: `t${i}`,
          toolName: "bash",
        }),
      ),
    ];
    const snap = buildGroupLiveTurn(events, "running");
    expect(snap.tools).toHaveLength(4);
    expect(snap.tools.every((t) => t.done === false)).toBe(true);
    expect(snap.tools[0]?.id).toBe("t2");
  });
});

describe("isStillWorking", () => {
  it("is false when queued", () => {
    expect(isStillWorking("queued", 1, 100_000)).toBe(false);
  });

  it("is true after silence while running", () => {
    const last = 1_000;
    expect(isStillWorking("running", last, last + STILL_WORKING_AFTER_MS - 1)).toBe(false);
    expect(isStillWorking("running", last, last + STILL_WORKING_AFTER_MS)).toBe(true);
  });
});
