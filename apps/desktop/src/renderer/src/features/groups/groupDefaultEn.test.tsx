// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { formatGroupDaySeparator } from "../../../../shared/group-conversation-minors";
import {
  filesSearchText,
  groupRoomIntlLocale,
  groupStatusLabel,
  groupText,
  resolveGroupRoomLocale,
} from "../../../../shared/group-room-locale";
import { formatClock } from "../../lib/formatClock";
import { GroupMessageHeader } from "./GroupMessageHeader";
import { GroupMessageRow } from "./GroupMessageRow";
import { newGroupDefaultName } from "./newGroupModel";

/**
 * C6.2: without an explicit locale every catalog TEXT is English, whatever the
 * system language; dates and clocks keep the system locale (as before C6).
 * The "pt system" is simulated: navigator.language = pt-BR, and `Intl` calls
 * that ask for the runtime default (no tag / `[]`) get pt-BR.
 */
type ToLocale = (this: Date, locales?: Intl.LocalesArgument, options?: object) => string;
function simulatePtSystem() {
  vi.spyOn(navigator, "language", "get").mockReturnValue("pt-BR");
  for (const name of ["toLocaleTimeString", "toLocaleDateString", "toLocaleString"] as const) {
    const original = Date.prototype[name] as ToLocale;
    vi.spyOn(Date.prototype, name).mockImplementation(function (
      this: Date,
      locales?: Intl.LocalesArgument,
      options?: object,
    ) {
      const systemDefault =
        locales === undefined || (Array.isArray(locales) && locales.length === 0);
      return original.call(this, systemDefault ? "pt-BR" : locales, options);
    } as ToLocale);
  }
}

const todayAt = (hours: number, minutes: number) => {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
};

beforeEach(simulatePtSystem);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("no explicit locale on a pt system: English text (C6.2)", () => {
  it("catalog lookups resolve to en", () => {
    expect(resolveGroupRoomLocale(undefined)).toBe("en");
    expect(resolveGroupRoomLocale(null)).toBe("en");
    expect(groupStatusLabel("waitingForYou")).toBe("Waiting for you");
    expect(groupText("row.replyingTo", undefined, { name: "Ana" })).toBe("Replying to Ana");
    expect(filesSearchText("files.noFileOpen")).toBe("No file open");
    expect(newGroupDefaultName(undefined)).toBe("New group");
    expect(newGroupDefaultName(null)).toBe("New group");
  });

  it("room row: badge in English, clock in the system (24h) format", () => {
    const message: GroupMessage = {
      id: "m-1",
      groupId: "g-1",
      authorKind: "agent",
      authorSessionId: "s-a",
      kind: "message",
      body: "",
      mentions: [],
      createdAt: todayAt(21, 47).toISOString(),
      turnId: "turn-1",
      chainId: "chain-1",
      status: "queued",
    };
    render(
      <GroupMessageRow
        labels={new Map([["s-a", { title: "Alpha" }]])}
        members={[{ sessionId: "s-a", title: "Alpha" }]}
        message={message}
        onRetry={async () => undefined}
      />,
    );
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.queryByText("Na fila")).toBeNull();
    expect(screen.getByTestId("group-message-header").querySelector("time")?.textContent).toBe(
      "21:47",
    );
  });

  it("formatClock / groupRoomIntlLocale: no tag = system locale, as before C6", () => {
    expect(groupRoomIntlLocale(undefined)).toBeUndefined();
    expect(groupRoomIntlLocale(null)).toBeUndefined();
    expect(formatClock(todayAt(21, 47).getTime())).toBe("21:47");
    expect(formatClock(todayAt(21, 47).getTime(), undefined, groupRoomIntlLocale(undefined))).toBe(
      "21:47",
    );
  });

  it("day separators: Today / Yesterday from the en catalog, long date from the system", () => {
    const now = todayAt(12, 0);
    expect(formatGroupDaySeparator(todayAt(9, 0).toISOString(), now)).toBe("Today");
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    expect(formatGroupDaySeparator(yesterday.toISOString(), now)).toBe("Yesterday");
    const older = new Date(now);
    older.setDate(now.getDate() - 3);
    expect(formatGroupDaySeparator(older.toISOString(), now)).toBe(
      older.toLocaleDateString("pt-BR", { weekday: "long" }),
    );
    const old = new Date(2025, 0, 15, 12, 0);
    expect(formatGroupDaySeparator(old.toISOString(), now)).toBe(
      old.toLocaleDateString("pt-BR", { month: "short", day: "numeric", year: "numeric" }),
    );
  });
});

describe("an explicit locale still selects pt / zh (C6.2)", () => {
  it("text, clock and day separator follow the explicit tag", () => {
    expect(groupStatusLabel("waitingForYou", "pt-BR")).toBe("Aguardando você");
    expect(groupStatusLabel("waitingForYou", "zh-CN")).toBe("等待你");
    expect(filesSearchText("files.noFileOpen", "pt")).toBe("Nenhum arquivo aberto");
    expect(newGroupDefaultName("pt-BR")).toBe("Novo grupo");
    const now = todayAt(12, 0);
    expect(formatGroupDaySeparator(todayAt(9, 0).toISOString(), now, "pt-BR")).toBe("Hoje");
    render(
      <GroupMessageHeader createdAt={todayAt(21, 47).toISOString()} locale="en-US" name="A" />,
    );
    expect(screen.getByTestId("group-message-header").querySelector("time")?.textContent).toBe(
      "9:47 PM",
    );
  });
});
