// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { GroupMessageRow } from "./GroupMessageRow";
import { GroupRoomLocaleProvider } from "./groupRoomI18n";
import {
  groupMessageWaitingSource,
  groupMessageWaitingState,
  isGroupMessageWaitingForYou,
} from "./groupWaiting";

afterEach(cleanup);

const members = [{ sessionId: "s-a", title: "Alpha" }];
const labels = new Map([["s-a", { title: "Alpha" }]]);

function message(patch: Partial<GroupMessage>): GroupMessage {
  return {
    id: "m-1",
    groupId: "g-1",
    authorKind: "agent",
    authorSessionId: "s-a",
    kind: "message",
    body: "",
    mentions: [],
    createdAt: "2026-10-02T12:00:00.000Z",
    ...patch,
  };
}

describe("amber 'Waiting for you' from structured state (C6)", () => {
  it("structured: a turn card with status awaiting_user, whatever its text", () => {
    const card = message({ status: "awaiting_user", turnId: "t-1", body: "Plano pronto." });
    expect(groupMessageWaitingSource(card)).toBe("status");
    expect(isGroupMessageWaitingForYou(card)).toBe(true);
    expect(groupMessageWaitingState(card, ["s-a"])).toBe("active");
    expect(groupMessageWaitingState(card, new Set(["s-b"]))).toBe("stale");
  });

  it("does not read the body of a structured message", () => {
    // A normal message that merely says the words is not waiting.
    const said = message({ status: "completed", body: "Waiting for you to review this." });
    expect(isGroupMessageWaitingForYou(said)).toBe(false);
    expect(groupMessageWaitingState(said, ["s-a"])).toBeUndefined();
  });

  it("legacy fallback: an old status row that only carries the English text", () => {
    const legacy = message({ kind: "status", body: "Waiting for you" });
    expect(groupMessageWaitingSource(legacy)).toBe("legacy-text");
    expect(groupMessageWaitingState(legacy, ["s-a"])).toBe("active");
    expect(groupMessageWaitingState(legacy, [])).toBe("stale");
    expect(groupMessageWaitingSource(message({ kind: "status", body: "Turn failed" }))).toBe(
      undefined,
    );
  });

  it("renders the structured card amber and marks it active", () => {
    render(
      <GroupMessageRow
        activeWaitingSessionIds={["s-a"]}
        labels={labels}
        locale="en"
        members={members}
        message={message({ status: "awaiting_user", turnId: "t-1", chainId: "c-1" })}
      />,
    );
    const row = screen.getByTestId("group-message");
    expect(row.getAttribute("data-waiting-active")).toBe("true");
    expect(row.getAttribute("data-waiting-stale")).toBeNull();
    const badge = screen.getByTestId("group-message-status");
    expect(badge.textContent).toBe("Waiting for you");
    expect(badge.className).toContain("text-amber-400");
  });

  it("marks a structured card stale once the ask is over", () => {
    render(
      <GroupMessageRow
        activeWaitingSessionIds={[]}
        labels={labels}
        locale="en"
        members={members}
        message={message({ status: "awaiting_user", turnId: "t-1", chainId: "c-1" })}
      />,
    );
    const row = screen.getByTestId("group-message");
    expect(row.getAttribute("data-waiting-stale")).toBe("true");
    expect(row.getAttribute("data-waiting-active")).toBeNull();
  });

  it("legacy text row: amber when active, localised, in a pt room", () => {
    render(
      <GroupRoomLocaleProvider locale="pt-BR">
        <GroupMessageRow
          activeWaitingSessionIds={["s-a"]}
          labels={labels}
          members={members}
          message={message({ kind: "status", body: "Waiting for you" })}
        />
      </GroupRoomLocaleProvider>,
    );
    const row = screen.getByTestId("group-message");
    expect(row.getAttribute("data-waiting-active")).toBe("true");
    expect(row.textContent).toContain("Aguardando você");
    expect(row.textContent).not.toContain("Waiting for you");
  });

  it("legacy text row: stale (no amber) when its author no longer waits", () => {
    render(
      <GroupMessageRow
        activeWaitingSessionIds={[]}
        labels={labels}
        locale="zh-CN"
        members={members}
        message={message({ kind: "status", body: "Waiting for you" })}
      />,
    );
    const row = screen.getByTestId("group-message");
    expect(row.getAttribute("data-waiting-active")).toBeNull();
    expect(row.getAttribute("data-waiting-stale")).toBe("true");
    expect(row.textContent).toContain("等待你");
  });
});

describe("persisted status bodies render in the room locale", () => {
  it("keeps classification on the English body (Turn failed stays an error row)", () => {
    render(
      <GroupMessageRow
        labels={labels}
        locale="pt"
        members={members}
        message={message({ kind: "status", body: "Turn failed" })}
      />,
    );
    const row = screen.getByTestId("group-message");
    expect(row.getAttribute("data-prompt-kit")).toBe("system-message");
    expect(row.textContent).toContain("Turno falhou");
  });

  it("localises the collab Blocked line but keeps the agent's reason", () => {
    render(
      <GroupMessageRow
        labels={labels}
        locale="zh"
        members={members}
        message={message({ kind: "status", body: "Blocked · need the API key" })}
      />,
    );
    expect(screen.getByTestId("group-message").textContent).toContain("受阻——need the API key");
  });
});
