import { describe, expect, it } from "vitest";
import type { AgentEventItem } from "./agentEventHub";
import type { TimelineBlock, WorkFoldBlockItem } from "./Timeline";
import { buildVisibleTimelineBlocks } from "./Timeline";
import { splitTimelinePresentation } from "./timelinePresentation";

const userMessage: TimelineBlock = {
  id: "prompt",
  type: "message",
  role: "user",
  content: "Ship the parser",
};

function fold(status: WorkFoldBlockItem["run"]["status"]): WorkFoldBlockItem {
  return {
    id: "fold:run-1",
    type: "work-fold",
    run: {
      id: "run-1",
      runId: "run-1",
      type: "run",
      status,
      startedAt: 10,
      ...(status === "running" ? {} : { completedAt: 20 }),
    },
    items: [
      {
        id: "work-activity:thinking",
        type: "work-activity-group",
        items: [
          { id: "thinking", type: "thought", text: "Inspecting the parser" },
          { id: "read", type: "tool", name: "read", output: "parser.ts", isComplete: true },
        ],
      },
      {
        id: "intermediate",
        type: "message",
        role: "assistant",
        content: "I found the entry point.",
      },
    ],
  };
}

describe("splitTimelinePresentation", () => {
  it("projects real event streams into a clean prompt and final answer transcript", () => {
    const events: AgentEventItem[] = [
      { id: "1", event: { type: "message.started", sessionId: "s", messageId: "u", role: "user" } },
      {
        id: "2",
        event: { type: "message.delta", sessionId: "s", messageId: "u", delta: "Fix the parser" },
      },
      { id: "3", event: { type: "message.completed", sessionId: "s", messageId: "u" } },
      { id: "4", event: { type: "run.started", sessionId: "s", runId: "r", delivery: "normal" } },
      {
        id: "5",
        event: { type: "message.started", sessionId: "s", messageId: "draft", role: "assistant" },
      },
      {
        id: "6",
        event: {
          type: "message.delta",
          sessionId: "s",
          messageId: "draft",
          delta: "Inspecting the parser.",
        },
      },
      { id: "7", event: { type: "message.completed", sessionId: "s", messageId: "draft" } },
      {
        id: "8",
        event: {
          type: "thinking.delta",
          sessionId: "s",
          messageId: "draft",
          delta: "Check parse flow",
        },
      },
      { id: "9", event: { type: "thinking.completed", sessionId: "s", messageId: "draft" } },
      {
        id: "10",
        event: { type: "tool.started", sessionId: "s", toolCallId: "t", toolName: "read" },
      },
      {
        id: "11",
        event: { type: "tool.output", sessionId: "s", toolCallId: "t", output: "parser.ts" },
      },
      { id: "12", event: { type: "tool.ended", sessionId: "s", toolCallId: "t", isError: false } },
      {
        id: "13",
        event: { type: "message.started", sessionId: "s", messageId: "final", role: "assistant" },
      },
      {
        id: "14",
        event: {
          type: "message.delta",
          sessionId: "s",
          messageId: "final",
          delta: "Parser shipped.",
        },
      },
      { id: "15", event: { type: "message.completed", sessionId: "s", messageId: "final" } },
      { id: "16", event: { type: "run.completed", sessionId: "s", runId: "r" } },
    ];

    const { transcriptBlocks, activityBlocks } = splitTimelinePresentation(
      buildVisibleTimelineBlocks(events),
    );
    const transcriptText = transcriptBlocks
      .filter((block) => block.type === "message")
      .map((block) => block.content)
      .join(" ");
    const activityFold = activityBlocks.find((block) => block.type === "work-fold");

    expect(transcriptText).toContain("Fix the parser");
    expect(transcriptText).toContain("Parser shipped.");
    expect(transcriptText).not.toContain("Inspecting the parser");
    expect(transcriptText).not.toContain("Check parse flow");
    expect(transcriptText).not.toContain("parser.ts");
    expect(activityFold?.type).toBe("work-fold");
    if (activityFold?.type === "work-fold") {
      expect(activityFold.items.length).toBeGreaterThan(0);
      expect(activityFold.run.status).toBe("completed");
    }
  });

  it("keeps the prompt and final response in chat while moving the settled work fold to Activity", () => {
    const source: TimelineBlock[] = [
      userMessage,
      fold("completed"),
      { id: "final", type: "message", role: "assistant", content: "Parser shipped." },
      {
        id: "failure",
        type: "notice",
        title: "Tool warning",
        body: "A retry was needed.",
        isError: true,
      },
    ];

    const { transcriptBlocks, activityBlocks } = splitTimelinePresentation(source);

    expect(transcriptBlocks.map((block) => block.id)).toEqual(["prompt", "final"]);
    expect(activityBlocks.map((block) => block.id)).toEqual(["fold:run-1", "failure"]);
    expect(source.map((block) => block.id)).toEqual(["prompt", "fold:run-1", "final", "failure"]);
  });

  it("keeps queued prompts in chat and hides active assistant output with the technical activity", () => {
    const activeFold = fold("running");
    activeFold.items.push({
      id: "queued-prompt",
      type: "message",
      role: "user",
      content: "Then add a test",
    });
    const streaming: TimelineBlock = {
      id: "streaming",
      type: "message",
      role: "assistant",
      content: "Draft answer",
      streaming: true,
    };

    const { transcriptBlocks, activityBlocks } = splitTimelinePresentation([
      userMessage,
      activeFold,
      streaming,
    ]);

    expect(transcriptBlocks.map((block) => block.id)).toEqual(["prompt", "queued-prompt"]);
    expect(activityBlocks.map((block) => block.id)).toEqual(["fold:run-1", "streaming"]);
    const [activityFold] = activityBlocks;
    expect(activityFold?.type).toBe("work-fold");
    if (activityFold?.type === "work-fold") {
      expect(activityFold.run.status).toBe("running");
      expect(activityFold.items.some((item) => item.id === "queued-prompt")).toBe(false);
    }
  });
});
