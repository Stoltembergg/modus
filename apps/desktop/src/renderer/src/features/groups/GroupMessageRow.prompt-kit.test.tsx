// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { GroupMessageRow } from "./GroupMessageRow";
import type { GroupLiveTurnSnapshot } from "./groupLiveTurn";

afterEach(() => cleanup());

const members = [
  { sessionId: "s-planner", title: "Planner" },
  { sessionId: "s-builder", title: "Builder" },
];
const labels = new Map([
  ["s-planner", { title: "Planner" }],
  ["s-builder", { title: "Builder" }],
]);

function agentMessage(body: string): GroupMessage {
  return {
    id: "m1",
    groupId: "g1",
    authorKind: "agent",
    authorSessionId: "s-planner",
    kind: "message",
    body,
    mentions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("GroupMessageRow Prompt Kit", () => {
  it("renders System Message for waiting / blocked statuses", () => {
    render(
      <GroupMessageRow
        activeWaitingSessionIds={["s-planner"]}
        labels={labels}
        members={members}
        message={{
          id: "s1",
          groupId: "g1",
          authorKind: "agent",
          authorSessionId: "s-planner",
          kind: "status",
          body: "Waiting for you",
          mentions: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        }}
      />,
    );
    const row = screen.getByTestId("group-message");
    expect(row.getAttribute("data-prompt-kit")).toBe("system-message");
    expect(row.getAttribute("data-waiting-active")).toBe("true");
  });

  it("hides worktree ops status from the transcript", () => {
    const { container } = render(
      <GroupMessageRow
        labels={labels}
        members={members}
        message={{
          id: "s2",
          groupId: "g1",
          authorKind: "system",
          kind: "status",
          body: "Worktree ready: `feat/x`",
          mentions: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        }}
      />,
    );
    expect(container.querySelector("[data-testid=group-message]")).toBeNull();
  });

  it("shows Steps and CoT inside a streaming agent message", () => {
    const live: GroupLiveTurnSnapshot = {
      phase: "Exploring",
      thoughtPreview: "raw secret thought should not appear",
      tools: [{ id: "t1", name: "read", label: "Reading", done: false }],
      streamText: "Looking at the composer next.",
      writingPreview: "Looking at the composer next.",
      lastEventAt: Date.now(),
      collapsed: false,
      presence: {
        state: "exploring",
        label: "Exploring",
        startedAt: Date.now(),
        lastProgressAt: Date.now(),
        activity: "reading files",
      },
    };
    render(
      <GroupMessageRow
        labels={labels}
        liveTurn={{ mode: "running", live }}
        members={members}
        message={agentMessage("")}
        streaming
      />,
    );
    expect(screen.getByTestId("group-prompt-steps")).toBeTruthy();
    expect(screen.getByTestId("group-prompt-cot")).toBeTruthy();
    expect(screen.getByTestId("group-live-writing").textContent).toContain(
      "Looking at the composer",
    );
    expect(screen.queryByText(/raw secret thought/i)).toBeNull();
  });

  it("renders user attachment chips on the message", () => {
    render(
      <GroupMessageRow
        labels={labels}
        members={members}
        message={{
          id: "u1",
          groupId: "g1",
          authorKind: "user",
          kind: "message",
          body: "please review",
          mentions: [],
          attachments: [{ type: "image", data: "AAA", mimeType: "image/png", name: "shot.png" }],
          createdAt: "2026-01-01T00:00:00.000Z",
        }}
      />,
    );
    expect(screen.getByTestId("group-message-attachments")).toBeTruthy();
    expect(screen.getByText("shot.png")).toBeTruthy();
  });
});
