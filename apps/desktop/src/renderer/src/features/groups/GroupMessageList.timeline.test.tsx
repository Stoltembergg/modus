// @vitest-environment happy-dom
// chore: re-trigger Package for tip after bot action_required (2026-10-01T11:34Z)
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { GROUP_MESSAGE_VIRTUALIZE_THRESHOLD, GroupMessageList } from "./GroupMessageList";
import type { GroupMemberWorkingRow } from "./useGroupMemberWorking";

afterEach(cleanup);
const members = [
  { sessionId: "s-a", title: "Alpha" },
  { sessionId: "s-b", title: "Beta" },
];
const states = new Map();
const appCssFromWorkspace = resolve(process.cwd(), "src/renderer/src/styles/app.css");
const appCssFromRepo = resolve(process.cwd(), "apps/desktop/src/renderer/src/styles/app.css");
const timelineStyles = readFileSync(
  existsSync(appCssFromWorkspace) ? appCssFromWorkspace : appCssFromRepo,
  "utf8",
);
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
  loaded = true,
  workingRows = [],
  executionFilter,
}: {
  messages: readonly GroupMessage[];
  groupId?: string;
  loaded?: boolean;
  workingRows?: readonly GroupMemberWorkingRow[];
  executionFilter?: string | undefined;
}) {
  return (
    <GroupMessageList
      avatars={new Map()}
      cwd={undefined}
      error={undefined}
      executionFilter={executionFilter}
      groupId={groupId}
      hasOlder={false}
      loadOlder={async () => undefined}
      loaded={loaded}
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

function entryMessageIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      ".group-message-card-enter [data-testid='group-message']",
    ),
    (row) => row.dataset.messageId ?? "",
  );
}

describe("Groups canonical timeline", () => {
  it("animates only a new append after initial hydration and keeps its first entry consumed", () => {
    const initial = message("initial", "Saved history");
    const { rerender } = render(<List loaded={false} messages={[initial]} />);

    rerender(<List loaded messages={[initial]} />);
    expect(entryMessageIds()).toEqual([]);

    const appended = message("appended", "New reply");
    rerender(<List loaded messages={[initial, appended]} />);
    expect(entryMessageIds()).toEqual(["appended"]);

    rerender(
      <List
        loaded
        messages={[initial, { ...appended, body: "Completed reply", status: "completed" }]}
      />,
    );
    expect(entryMessageIds()).toEqual(["appended"]);
  });

  it("does not animate older prepends, same-ID revisions, or filtered cards when shown later", () => {
    const first = message("first", "First", { chainId: "exec-a" });
    const last = message("last", "Last", { chainId: "exec-a" });
    const { rerender } = render(<List messages={[first, last]} />);

    rerender(<List messages={[message("older", "Older page"), first, last]} />);
    expect(entryMessageIds()).toEqual([]);

    rerender(
      <List
        messages={[
          message("older", "Older page"),
          first,
          { ...last, body: "Revised", status: "writing" },
        ]}
      />,
    );
    expect(entryMessageIds()).toEqual([]);

    const hidden = message("filtered-append", "Hidden by current filter", {
      chainId: "exec-b",
    });
    rerender(
      <List
        executionFilter="exec-a"
        messages={[message("older", "Older page"), first, last, hidden]}
      />,
    );
    expect(entryMessageIds()).toEqual([]);
    rerender(<List messages={[message("older", "Older page"), first, last, hidden]} />);
    expect(entryMessageIds()).toEqual([]);
  });

  it("does not animate room hydration or replay a card after navigating away and back", () => {
    const roomOne = message("one", "Room one");
    const { rerender } = render(<List messages={[roomOne]} />);
    const roomTwo = message("two", "Room two", { groupId: "g-2" });

    rerender(<List groupId="g-2" messages={[roomTwo]} />);
    expect(entryMessageIds()).toEqual([]);

    rerender(<List messages={[roomOne]} />);
    expect(entryMessageIds()).toEqual([]);
  });

  it("does not replay a virtualized append animation after the row is unmounted and remounted", async () => {
    const initial = Array.from({ length: GROUP_MESSAGE_VIRTUALIZE_THRESHOLD - 1 }, (_, index) =>
      message(`virtual-${index}`, `Body ${index}`),
    );
    const { rerender } = render(<List messages={initial} />);
    const list = screen.getByTestId("group-message-list");
    Object.defineProperties(list, {
      scrollHeight: { value: 8000, configurable: true },
      clientHeight: { value: 400, configurable: true },
      clientWidth: { value: 760, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    });
    list.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 400,
        right: 760,
        width: 760,
        height: 400,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    // Mark the reader as away from the bottom before adding the 40th item.
    fireEvent.scroll(list);
    expect(entryMessageIds()).toEqual([]);

    const appended = message("virtual-appended", "New tail", { chainId: "exec-b" });
    rerender(<List messages={[...initial, appended]} />);
    expect(list.dataset.virtualized).toBe("true");
    if (entryMessageIds().length === 0) {
      list.scrollTop = list.scrollHeight;
      fireEvent.scroll(list);
    }
    expect(entryMessageIds()).toEqual(["virtual-appended"]);

    rerender(<List executionFilter="virtual-0" messages={[...initial, appended]} />);
    expect(screen.queryByText("New tail")).toBeNull();
    expect(entryMessageIds()).toEqual([]);

    rerender(<List messages={[...initial, appended]} />);
    expect(await screen.findByText("New tail")).toBeTruthy();
    expect(entryMessageIds()).toEqual([]);
  });

  it("does not animate existing cards when a full DOM list crosses into virtualization", async () => {
    const initial = Array.from({ length: GROUP_MESSAGE_VIRTUALIZE_THRESHOLD - 1 }, (_, index) =>
      message(`threshold-${index}`, `Body ${index}`),
    );
    const { rerender } = render(<List messages={initial} />);
    const list = screen.getByTestId("group-message-list");
    Object.defineProperties(list, {
      scrollHeight: { value: 8000, configurable: true },
      clientHeight: { value: 400, configurable: true },
      clientWidth: { value: 760, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    });
    list.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 400,
        right: 760,
        width: 760,
        height: 400,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    rerender(<List messages={[...initial, message("threshold-new", "New card")]} />);

    expect(list.dataset.virtualized).toBe("true");
    list.scrollTop = list.scrollHeight;
    fireEvent.scroll(list);
    expect(await screen.findByText("New card")).toBeTruthy();
    expect(entryMessageIds()).toEqual(["threshold-new"]);
  });

  it("defines a brief upward fade and disables it for reduced motion", () => {
    expect(timelineStyles.includes("@keyframes group-message-card-enter")).toBe(true);
    expect(
      /@keyframes group-message-card-enter\s*\{\s*from\s*\{[^}]*opacity:\s*0[^}]*transform:\s*translateY\(\s*8px\s*\)/s.test(
        timelineStyles,
      ),
    ).toBe(true);
    expect(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.group-message-card-enter\s*\{[^}]*animation:\s*none;/s.test(
        timelineStyles,
      ),
    ).toBe(true);
  });

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

  it("keeps live metadata on the running card when a queued follow-up is visible or filtered alone", async () => {
    const running = message("running-a", "", {
      chainId: "exec-a",
      status: "writing",
    });
    const queued = message("queued-b", "", {
      chainId: "exec-b",
      createdAt: "2026-10-01T12:31:00.000Z",
      status: "queued",
    });
    const live: GroupMemberWorkingRow = {
      sessionId: "s-a",
      mode: "running",
      live: {
        phase: "Searching",
        streamText: "",
        writingPreview: "",
        thoughtPreview: "",
        tools: [{ id: "tool-1", name: "search", label: "Searching files", done: false }],
        lastEventAt: Date.now(),
        collapsed: false,
        presence: {
          state: "running_tool",
          label: "Searching",
          startedAt: Date.now(),
          lastProgressAt: Date.now(),
        },
      },
    };
    const { rerender } = render(<List messages={[running, queued]} workingRows={[live]} />);
    const [runningCard, queuedCard] = await screen.findAllByTestId("group-message");

    expect(within(runningCard as HTMLElement).getByTestId("group-member-live-turn")).toBeTruthy();
    expect(within(queuedCard as HTMLElement).queryByTestId("group-member-live-turn")).toBeNull();

    rerender(<List messages={[running, queued]} workingRows={[live]} executionFilter="exec-b" />);
    const filteredQueuedCard = await screen.findByTestId("group-message");
    expect(filteredQueuedCard.dataset.messageId).toBe("queued-b");
    expect(within(filteredQueuedCard).queryByTestId("group-member-live-turn")).toBeNull();
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

describe("GroupMessageList virtualization", () => {
  it(`enables the virtualizer at ${GROUP_MESSAGE_VIRTUALIZE_THRESHOLD}+ messages when the viewport has height`, () => {
    const small = Array.from({ length: GROUP_MESSAGE_VIRTUALIZE_THRESHOLD - 1 }, (_, i) =>
      message(`m-${i}`, `Body ${i}`),
    );
    const { rerender } = render(<List messages={small} />);
    const list = screen.getByTestId("group-message-list");
    expect(list.dataset.virtualized).toBe("false");
    expect(screen.queryByTestId("group-message-virtualizer")).toBeNull();
    expect(screen.getAllByTestId("group-message")).toHaveLength(small.length);

    Object.defineProperties(list, {
      scrollHeight: { value: 8000, configurable: true },
      clientHeight: { value: 400, configurable: true },
      clientWidth: { value: 760, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    });
    list.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 400,
        right: 760,
        width: 760,
        height: 400,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    const large = Array.from({ length: GROUP_MESSAGE_VIRTUALIZE_THRESHOLD + 10 }, (_, i) =>
      message(`m-${i}`, `Body ${i}`),
    );
    rerender(<List messages={large} />);
    expect(screen.getByTestId("group-message-list").dataset.virtualized).toBe("true");
    expect(screen.getByTestId("group-message-virtualizer")).toBeTruthy();
    // Only the overscanned window mounts — not every transcript row.
    const mounted = screen.getAllByTestId("group-message").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(large.length);
  });

  it("keeps a full DOM list when the scroll viewport has no height (tests / hidden)", () => {
    const large = Array.from({ length: GROUP_MESSAGE_VIRTUALIZE_THRESHOLD + 5 }, (_, i) =>
      message(`m-${i}`, `Body ${i}`),
    );
    render(<List messages={large} />);
    expect(screen.getByTestId("group-message-list").dataset.virtualized).toBe("false");
    expect(screen.getAllByTestId("group-message")).toHaveLength(large.length);
  });
});
