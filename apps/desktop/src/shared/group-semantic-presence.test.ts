import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./contracts";
import { buildGroupSemanticPresence, shouldShowStillWorking } from "./group-semantic-presence";

const ev = (event: AgentEvent, createdAt: string) => ({ event, createdAt });

describe("buildGroupSemanticPresence", () => {
  it("maps read tools to exploring and edits to implementing", () => {
    const exploring = buildGroupSemanticPresence(
      [
        ev(
          { type: "run.started", sessionId: "s", runId: "r", delivery: "normal" },
          "2026-01-01T00:00:00.000Z",
        ),
        ev(
          { type: "tool.started", sessionId: "s", toolCallId: "t1", toolName: "read" },
          "2026-01-01T00:00:01.000Z",
        ),
      ],
      "running",
    );
    expect(exploring.state).toBe("exploring");
    expect(exploring.label).toBe("Exploring");
    expect(exploring.activity).toMatch(/Read/i);

    const implementing = buildGroupSemanticPresence(
      [
        ev(
          { type: "run.started", sessionId: "s", runId: "r", delivery: "normal" },
          "2026-01-01T00:00:00.000Z",
        ),
        ev(
          { type: "tool.started", sessionId: "s", toolCallId: "t2", toolName: "edit" },
          "2026-01-01T00:00:02.000Z",
        ),
      ],
      "running",
    );
    expect(implementing.state).toBe("running_tool");
    expect(implementing.label).toBe("Implementing");
  });

  it("marks writing and done, and queued mode", () => {
    const writing = buildGroupSemanticPresence(
      [
        ev(
          { type: "run.started", sessionId: "s", runId: "r", delivery: "normal" },
          "2026-01-01T00:00:00.000Z",
        ),
        ev(
          { type: "message.delta", sessionId: "s", messageId: "m", delta: "hi" },
          "2026-01-01T00:00:03.000Z",
        ),
      ],
      "running",
    );
    expect(writing.state).toBe("writing");
    expect(writing.label).toBe("Writing");

    const done = buildGroupSemanticPresence(
      [
        ...[
          ev(
            { type: "run.started", sessionId: "s", runId: "r", delivery: "normal" },
            "2026-01-01T00:00:00.000Z",
          ),
          ev({ type: "run.completed", sessionId: "s", runId: "r" }, "2026-01-01T00:00:04.000Z"),
        ],
      ],
      "running",
    );
    expect(done.state).toBe("done");
    expect(done.label).toBe("Done");

    expect(buildGroupSemanticPresence([], "queued").state).toBe("queued");
  });
});

describe("shouldShowStillWorking", () => {
  it("is true after silence while running tools/thinking", () => {
    const presence = buildGroupSemanticPresence(
      [
        ev(
          { type: "run.started", sessionId: "s", runId: "r", delivery: "normal" },
          "2026-01-01T00:00:00.000Z",
        ),
        ev(
          { type: "thinking.delta", sessionId: "s", messageId: "m", delta: "x" },
          "2026-01-01T00:00:01.000Z",
        ),
      ],
      "running",
    );
    const last = presence.lastProgressAt;
    expect(shouldShowStillWorking(presence, last + 7_999, 8_000)).toBe(false);
    expect(shouldShowStillWorking(presence, last + 8_000, 8_000)).toBe(true);
  });
});
