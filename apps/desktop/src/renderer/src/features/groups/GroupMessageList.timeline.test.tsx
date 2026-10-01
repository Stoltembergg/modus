// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { GroupMessageList } from "./GroupMessageList";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

afterEach(cleanup);
const members = [
  { sessionId: "s-a", title: "Alpha" },
  { sessionId: "s-b", title: "Beta" },
];
const states = new Map();
function message(id: string, body: string, extra: Partial<GroupMessage> = {}): GroupMessage {
  return {
    id,
    groupId: "g-1",
    authorKind: "agent",
    ...(extra.authorKind === "user" ? {} : { authorSessionId: "s-a" }),
    kind: "message",
    body,
    mentions: [],
    createdAt: "2026-10-01T12:30:00.000Z",
    ...extra,
  };
}
function List({
  messages,
  groupId = "g-1",
  workingRows = [],
}: {
  messages: readonly GroupMessage[];
  groupId?: string;
  workingRows?: readonly GroupMemberWorkingRow[];
}) {
  return (
    <GroupMessageList
      avatars={new Map()}
      cwd={undefined}
      error={undefined}
      groupId={groupId}
      hasOlder={false}
      loadOlder={async () => undefined}
      loaded
      loadingOlder={false}
      memberStates={states}
      members={members}
      messages={messages}
      onOpenFile={undefined}
      roles={new Map([["s-a", "Researcher"]])}
      workingRows={workingRows}
    />
  );
}

describe("Groups canonical timeline", () => {
  it("keeps replies in chronological order and quotes their original message", async () => {
    render(
      <List
        messages={[
          message("a", "Task A", { authorKind: "user" }),
          message("answer-a", "First response", { replyToMessageId: "a" }),
          message("a2", "A follow-up", { replyToMessageId: "answer-a" }),
          message("b", "Task B", { authorKind: "user" }),
          message("answer-a2", "Late response", { replyToMessageId: "a" }),
        ]}
      />,
    );
    const rows = await screen.findAllByTestId("group-message");
    expect(rows.map((row) => row.dataset.messageId)).toEqual([
      "a",
      "answer-a",
      "a2",
      "b",
      "answer-a2",
    ]);
    expect(within(rows[1] as HTMLElement).getByTestId("group-message-quote").textContent).toContain(
      "Task A",
    );
    expect(within(rows[2] as HTMLElement).getByTestId("group-message-quote").textContent).toContain(
      "First response",
    );
    expect(screen.queryByTestId("group-thread-replies")).toBeNull();
  });

  it("keeps the same card node when its canonical writing message becomes completed", async () => {
    const draft = message("public-1", "Draft", { status: "writing", turnId: "turn-1" });
    const { rerender } = render(<List messages={[draft]} />);
    const card = await screen.findByTestId("group-message");
    expect(card.dataset.status).toBe("writing");
    rerender(<List messages={[{ ...draft, body: "Finished reply", status: "completed" }]} />);
    expect(screen.getByTestId("group-message")).toBe(card);
    expect(card.dataset.status).toBe("completed");
    expect(await within(card).findByText("Finished reply")).toBeTruthy();
    expect(screen.getAllByTestId("group-message")).toHaveLength(1);
  });

  it("shows identity, role, timestamp and an explicit interrupted failure on a card", async () => {
    render(
      <List
        messages={[message("failed", "", { status: "interrupted", error: "App restarted" })]}
      />,
    );
    const card = await screen.findByTestId("group-message");
    expect(within(card).getByText("Alpha")).toBeTruthy();
    expect(within(card).getByText("Researcher")).toBeTruthy();
    expect(card.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-01T12:30:00.000Z");
    expect(within(card).getByText("Interrupted")).toBeTruthy();
    expect(within(card).getByText("App restarted")).toBeTruthy();
    expect(card.dataset.align).toBe("left");
  });

  it("places user cards on the right with a short reply quote", async () => {
    render(
      <List
        messages={[
          message("a", "Long original ".repeat(20)),
          message("u", "Thanks", {
            authorKind: "user",
            replyToMessageId: "a",
          }),
        ]}
      />,
    );
    const rows = await screen.findAllByTestId("group-message");
    expect((rows[1] as HTMLElement).dataset.align).toBe("right");
    const quote = within(rows[1] as HTMLElement).getByTestId("group-message-quote");
    expect(quote.textContent?.length).toBeLessThan(150);
    expect(quote.querySelector("a")?.getAttribute("href")).toBe("#group-message-a");
  });

  it("never repeats public text in working presence and clears presence when idle", async () => {
    const row: GroupMemberWorkingRow = {
      sessionId: "s-a",
      mode: "running",
      live: {
        phase: "Writing",
        streamText: "Stale prose",
        writingPreview: "Stale prose",
        thoughtPreview: "secret",
        tools: [],
        lastEventAt: Date.now(),
        collapsed: false,
        presence: {
          state: "writing",
          label: "Writing",
          startedAt: Date.now(),
          lastProgressAt: Date.now(),
        },
      },
    };
    const { rerender } = render(
      <List
        messages={[message("canonical", "Authoritative prose", { status: "writing" })]}
        workingRows={[row]}
      />,
    );
    expect(await screen.findByText("Authoritative prose")).toBeTruthy();
    expect(screen.queryByText("Stale prose")).toBeNull();
    expect(screen.queryByTestId("group-working-status")).toBeNull();
    rerender(<List messages={[message("canonical", "Final prose", { status: "completed" })]} />);
    expect(screen.queryByTestId("group-working-status")).toBeNull();
    expect(screen.getAllByTestId("group-message")).toHaveLength(1);
  });

  it("shows new messages without moving a reader above the bottom and resets on navigation", async () => {
    const first = message("first", "First");
    const { rerender } = render(<List messages={[first]} />);
    const list = screen.getByTestId("group-message-list");
    Object.defineProperties(list, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 200, configurable: true },
      scrollTop: { value: 100, writable: true, configurable: true },
    });
    fireEvent.scroll(list);
    rerender(<List messages={[first, message("second", "Second")]} />);
    expect(list.scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: "1 new message" })).toBeTruthy();
    // Body revisions are not additional unread messages.
    rerender(
      <List messages={[first, message("second", "Second complete", { status: "completed" })]} />,
    );
    expect(screen.getByRole("button", { name: "1 new message" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1 new message" }));
    expect(list.scrollTop).toBe(1000);
    expect(screen.queryByTestId("group-new-messages")).toBeNull();
    list.scrollTop = 100;
    fireEvent.scroll(list);
    rerender(
      <List groupId="g-2" messages={[message("other", "Another room", { groupId: "g-2" })]} />,
    );
    expect(screen.queryByTestId("group-new-messages")).toBeNull();
    expect(list.scrollTop).toBe(1000);
  });
});
