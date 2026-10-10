import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEventPage } from "../../shared/agent-events";
import type { AgentEvent } from "../../shared/contracts";

const { listAgentEvents, listAgentEventPage, listAgentEventRawPage } = vi.hoisted(() => ({
  listAgentEvents: vi.fn(),
  listAgentEventPage: vi.fn(),
  listAgentEventRawPage: vi.fn(),
}));

vi.mock("../agent/agent-event-store", () => ({
  listAgentEvents,
  listAgentEventPage,
  listAgentEventRawPage,
  MAX_AGENT_EVENT_PAGE_SIZE: 256,
}));

const { resolveContext } = await import("./context-service");

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

describe("past-chat transcript paging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAgentEvents.mockImplementation(() => {
      throw new Error("unbounded event listing must not be used");
    });
    listAgentEventPage.mockImplementation(() => {
      throw new Error("expanded event pages duplicate cross-boundary streams");
    });
  });

  it("preserves the transcript across bounded pages and trims each message", async () => {
    listAgentEventRawPage
      .mockReturnValueOnce(
        page(
          [
            { type: "message.started", sessionId: "past-session", messageId: "user", role: "user" },
            {
              type: "message.delta",
              sessionId: "past-session",
              messageId: "user",
              delta: " User question. ",
            },
            { type: "message.completed", sessionId: "past-session", messageId: "user" },
          ],
          { snapshotCursor: 8, nextCursor: 3, hasMore: true },
        ),
      )
      .mockReturnValueOnce(
        page(
          [
            {
              type: "message.started",
              sessionId: "past-session",
              messageId: "assistant",
              role: "assistant",
            },
            {
              type: "message.delta",
              sessionId: "past-session",
              messageId: "assistant",
              delta: "Assistant answer.",
            },
            { type: "message.completed", sessionId: "past-session", messageId: "assistant" },
          ],
          { snapshotCursor: 8, nextCursor: 8, hasMore: false },
        ),
      );

    const resolved = await resolveContext(process.cwd(), [
      { type: "past-chat", sessionId: "past-session", title: "Past session" },
    ]);

    expect(resolved[0]?.content).toBe("User: User question.\n\nAssistant: Assistant answer.");
    expect(listAgentEventRawPage).toHaveBeenNthCalledWith(1, "past-session", {
      afterCursor: 0,
      limit: 256,
    });
    expect(listAgentEventRawPage).toHaveBeenNthCalledWith(2, "past-session", {
      afterCursor: 3,
      limit: 256,
      snapshotCursor: 8,
    });
    expect(listAgentEvents).not.toHaveBeenCalled();
  });

  it("does not duplicate a streamed message expanded on both sides of a page boundary", async () => {
    const expandedStarted: Extract<AgentEvent, { type: "message.started" }> = {
      type: "message.started",
      sessionId: "past-session",
      messageId: "user",
      role: "user",
    };
    const expandedDelta: Extract<AgentEvent, { type: "message.delta" }> = {
      type: "message.delta",
      sessionId: "past-session",
      messageId: "user",
      delta: "hello world",
    };
    const expandedCompleted: Extract<AgentEvent, { type: "message.completed" }> = {
      type: "message.completed",
      sessionId: "past-session",
      messageId: "user",
    };
    const expandedMessage = [expandedStarted, expandedDelta, expandedCompleted];
    listAgentEventPage
      .mockReturnValueOnce(
        page(expandedMessage, { snapshotCursor: 6, nextCursor: 3, hasMore: true }),
      )
      .mockReturnValueOnce(
        page(expandedMessage, { snapshotCursor: 6, nextCursor: 6, hasMore: false }),
      );
    listAgentEventRawPage
      .mockReturnValueOnce(
        page([expandedStarted, { ...expandedDelta, delta: "hello " }], {
          snapshotCursor: 6,
          nextCursor: 3,
          hasMore: true,
        }),
      )
      .mockReturnValueOnce(
        page([{ ...expandedDelta, delta: "world" }, expandedCompleted], {
          snapshotCursor: 6,
          nextCursor: 6,
          hasMore: false,
        }),
      );

    const resolved = await resolveContext(process.cwd(), [
      { type: "past-chat", sessionId: "past-session", title: "Past session" },
    ]);

    expect(resolved[0]?.content).toBe("User: hello world");
    expect(listAgentEventRawPage).toHaveBeenCalledTimes(2);
  });

  it("retains only the configured transcript byte cap while streaming a large message", async () => {
    const text = "x".repeat(64 * 1024);
    listAgentEventRawPage.mockReturnValueOnce(
      page(
        [
          { type: "message.started", sessionId: "past-session", messageId: "user", role: "user" },
          { type: "message.delta", sessionId: "past-session", messageId: "user", delta: text },
          { type: "message.completed", sessionId: "past-session", messageId: "user" },
        ],
        { snapshotCursor: 3, nextCursor: 3, hasMore: false },
      ),
    );

    const resolved = await resolveContext(process.cwd(), [
      { type: "past-chat", sessionId: "past-session", title: "Past session" },
    ]);
    const expectedPrefix = Buffer.from(`User: ${text}`, "utf8")
      .subarray(0, 60 * 1024)
      .toString("utf8");

    expect(resolved[0]?.content).toBe(`${expectedPrefix}\n…(truncated)`);
  });
});
