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
  it.each([
    ["agent", agentMessage("Agent response")],
    [
      "user",
      {
        id: "u1",
        groupId: "g1",
        authorKind: "user",
        kind: "message",
        body: "User message",
        mentions: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      } satisfies GroupMessage,
    ],
  ])("renders the %s message surface without a card border", (_kind, message) => {
    const { container } = render(
      <GroupMessageRow labels={labels} members={members} message={message} />,
    );

    const surface = container.querySelector('[data-prompt-kit="message"]');
    expect(surface).toBeTruthy();
    expect(
      surface?.className.split(/\s+/u).some((className) => className.startsWith("border")),
    ).toBe(false);
    expect(surface?.textContent).toContain(message.body);
  });

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

  it("keeps public text canonical and renders only safe live progress", () => {
    const thinking: GroupLiveTurnSnapshot = {
      phase: "Exploring",
      thoughtPreview: "raw secret thought should not appear",
      tools: [{ id: "t1", name: "read", label: "Reading", done: false }],
      streamText: "",
      writingPreview: "",
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
    const { rerender } = render(
      <GroupMessageRow
        labels={labels}
        liveTurn={{ mode: "running", live: thinking }}
        members={members}
        message={{ ...agentMessage("Canonical public text"), status: "running" }}
        streaming
      />,
    );
    expect(screen.getByTestId("group-live-status")).toBeTruthy();
    expect(screen.queryByTestId("group-prompt-tool")).toBeNull();
    expect(screen.getByText("Canonical public text")).toBeTruthy();
    expect(screen.queryByTestId("group-prompt-steps")).toBeNull();
    expect(screen.getByTestId("group-prompt-cot")).toBeTruthy();
    expect(screen.queryByText(/raw secret thought/i)).toBeNull();

    const writing: GroupLiveTurnSnapshot = {
      ...thinking,
      streamText: "Unpersisted snapshot prose",
      writingPreview: "Unpersisted snapshot prose",
      presence: { ...thinking.presence, state: "writing", label: "Writing" },
    };
    rerender(
      <GroupMessageRow
        labels={labels}
        liveTurn={{ mode: "running", live: writing }}
        members={members}
        message={{ ...agentMessage("Looking at the composer next."), status: "writing" }}
        streaming
      />,
    );
    expect(screen.getByTestId("group-live-status")).toBeTruthy();
    expect(screen.queryByTestId("group-prompt-tool")).toBeNull();
    expect(screen.getByTestId("group-live-writing").textContent).toContain(
      "Looking at the composer",
    );
    expect(screen.queryByText("Unpersisted snapshot prose")).toBeNull();
  });

  it("shows Ready for you as an ephemeral chip, not a transcript status line", () => {
    render(
      <GroupMessageRow labels={labels} members={members} message={agentMessage("Ready for you")} />,
    );
    expect(screen.getByTestId("group-ready-ephemeral")).toBeTruthy();
    expect(screen.queryByTestId("group-collab-status")).toBeNull();
  });

  it("strips redundant self-intros from agent prose", () => {
    render(
      <GroupMessageRow
        labels={labels}
        members={members}
        message={agentMessage("Aqui é o @Planner, vamos revisar o fluxo.")}
      />,
    );
    expect(screen.queryByText(/Aqui é o/i)).toBeNull();
    expect(screen.getByText(/vamos revisar o fluxo/i)).toBeTruthy();
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
