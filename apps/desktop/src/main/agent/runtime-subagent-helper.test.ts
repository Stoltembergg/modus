import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEventPage } from "../../shared/agent-events";
import type { AgentEvent } from "../../shared/contracts";

const { listAgentEvents, listAgentEventPage, listAgentEventRawPage, listAgentRunMessagePage } =
  vi.hoisted(() => ({
    listAgentEvents: vi.fn(),
    listAgentEventPage: vi.fn(),
    listAgentEventRawPage: vi.fn(),
    listAgentRunMessagePage: vi.fn(),
  }));

vi.mock("./agent-event-store", () => ({
  listAgentEvents,
  listAgentEventPage,
  listAgentEventRawPage,
  listAgentRunMessagePage,
  MAX_AGENT_EVENT_PAGE_SIZE: 256,
}));

const { lastAssistantOutput, runAssistantOutput } = await import("./runtime-subagent-helper");

function item(event: AgentEvent): AgentEventPage["events"][number] {
  return {
    id: `${event.type}-${"messageId" in event ? event.messageId : "event"}`,
    event,
    createdAt: "now",
  };
}

function page(
  events: AgentEvent[],
  options: { snapshotCursor: number; nextCursor?: number; hasMore: boolean },
): AgentEventPage {
  return {
    events: events.map(item),
    summaryEvents: [],
    activityEvents: [],
    ...options,
  };
}

describe("runtime-subagent-helper assistant output paging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAgentEvents.mockImplementation(() => {
      throw new Error("unbounded event listing must not be used");
    });
  });

  it("reconstructs the final assistant message across bounded session pages", () => {
    listAgentEventRawPage
      .mockReturnValueOnce(
        page(
          [
            {
              type: "message.started",
              sessionId: "session-a",
              messageId: "answer",
              role: "assistant",
            },
            {
              type: "message.delta",
              sessionId: "session-a",
              messageId: "answer",
              delta: "The answer ",
            },
          ],
          { snapshotCursor: 40, nextCursor: 25, hasMore: true },
        ),
      )
      .mockReturnValueOnce(
        page(
          [
            {
              type: "message.delta",
              sessionId: "session-a",
              messageId: "answer",
              delta: "is complete.",
            },
            { type: "message.completed", sessionId: "session-a", messageId: "answer" },
          ],
          { snapshotCursor: 40, nextCursor: 40, hasMore: false },
        ),
      );

    expect(lastAssistantOutput("session-a")).toBe("The answer is complete.");
    expect(listAgentEventRawPage).toHaveBeenNthCalledWith(1, "session-a", {
      afterCursor: 0,
      limit: 256,
    });
    expect(listAgentEventRawPage).toHaveBeenNthCalledWith(2, "session-a", {
      afterCursor: 25,
      limit: 256,
      snapshotCursor: 40,
    });
    expect(listAgentEventPage).not.toHaveBeenCalled();
    expect(listAgentEvents).not.toHaveBeenCalled();
  });

  it("does not append expanded message text again when a page starts with its delta", () => {
    listAgentEventPage
      .mockReturnValueOnce(
        page(
          [
            {
              type: "message.started",
              sessionId: "session-a",
              messageId: "answer",
              role: "assistant",
            },
            {
              type: "message.delta",
              sessionId: "session-a",
              messageId: "answer",
              delta: "complete answer",
            },
            { type: "message.completed", sessionId: "session-a", messageId: "answer" },
          ],
          { snapshotCursor: 30, nextCursor: 25, hasMore: true },
        ),
      )
      .mockReturnValueOnce(
        page(
          [
            {
              type: "message.delta",
              sessionId: "session-a",
              messageId: "answer",
              delta: "complete answer",
            },
            { type: "message.completed", sessionId: "session-a", messageId: "answer" },
          ],
          { snapshotCursor: 30, nextCursor: 30, hasMore: false },
        ),
      );
    listAgentEventRawPage
      .mockReturnValueOnce(
        page(
          [
            {
              type: "message.started",
              sessionId: "session-a",
              messageId: "answer",
              role: "assistant",
            },
          ],
          { snapshotCursor: 30, nextCursor: 25, hasMore: true },
        ),
      )
      .mockReturnValueOnce(
        page(
          [
            {
              type: "message.delta",
              sessionId: "session-a",
              messageId: "answer",
              delta: "complete answer",
            },
            { type: "message.completed", sessionId: "session-a", messageId: "answer" },
          ],
          { snapshotCursor: 30, nextCursor: 30, hasMore: false },
        ),
      );

    expect(lastAssistantOutput("session-a")).toBe("complete answer");
    expect(listAgentEventRawPage).toHaveBeenCalledTimes(2);
    expect(listAgentEvents).not.toHaveBeenCalled();
  });

  it("reconstructs one run's assistant output across message pages", () => {
    listAgentRunMessagePage
      .mockReturnValueOnce(
        page(
          [
            {
              type: "message.started",
              sessionId: "session-a",
              messageId: "answer",
              role: "assistant",
            },
            {
              type: "message.delta",
              sessionId: "session-a",
              messageId: "answer",
              delta: "run-scoped ",
            },
          ],
          { snapshotCursor: 40, nextCursor: 25, hasMore: true },
        ),
      )
      .mockReturnValueOnce(
        page(
          [{ type: "message.delta", sessionId: "session-a", messageId: "answer", delta: "answer" }],
          { snapshotCursor: 40, nextCursor: 40, hasMore: false },
        ),
      );

    expect(runAssistantOutput("session-a", "run-a")).toBe("run-scoped answer");
    expect(listAgentRunMessagePage).toHaveBeenNthCalledWith(1, "session-a", "run-a", {
      afterCursor: 0,
      limit: 256,
    });
    expect(listAgentRunMessagePage).toHaveBeenNthCalledWith(2, "session-a", "run-a", {
      afterCursor: 25,
      limit: 256,
      snapshotCursor: 40,
    });
    expect(listAgentEvents).not.toHaveBeenCalled();
  });
});
