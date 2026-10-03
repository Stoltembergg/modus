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
import { simulateSystemLocale } from "../../lib/systemLocale.test-helpers";
import { GroupMessageHeader } from "./GroupMessageHeader";
import { GroupMessageRow } from "./GroupMessageRow";
import { newGroupDefaultName } from "./newGroupModel";

/**
 * C6.2: without an explicit locale every catalog TEXT is English, whatever the
 * system language; date names are en-US too, while the hour cycle follows the
 * system (24h on pt-BR). The "pt system" is simulated: navigator.language =
 * pt-BR and every default `Intl` / `toLocale*` call resolves to pt-BR (h23).
 */
let restoreSystem = () => {};

const todayAt = (hours: number, minutes: number) => {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
};

beforeEach(() => {
  restoreSystem = simulateSystemLocale("pt-BR");
});
afterEach(() => {
  cleanup();
  restoreSystem();
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

  it("formatClock: 24h system hour cycle with English names (exact shapes)", () => {
    expect(groupRoomIntlLocale(undefined)).toBeUndefined();
    expect(groupRoomIntlLocale(null)).toBeUndefined();
    const friday = new Date(2026, 9, 2, 21, 47).getTime();
    // today
    expect(formatClock(friday, new Date(2026, 9, 2, 23, 0))).toBe("21:47");
    // earlier the same week
    expect(formatClock(friday, new Date(2026, 9, 4, 12, 0))).toBe("Friday 21:47");
    // older
    expect(formatClock(friday, new Date(2026, 9, 20, 12, 0))).toBe("Oct 2 21:47");
    expect(formatClock(new Date(2026, 9, 2, 9, 5).getTime(), new Date(2026, 9, 2, 23, 0))).toBe(
      "9:05",
    );
  });

  it("day separators: Today / Yesterday and English long dates", () => {
    const now = new Date(2026, 9, 4, 12, 0);
    expect(formatGroupDaySeparator(new Date(2026, 9, 4, 9, 0).toISOString(), now)).toBe("Today");
    expect(formatGroupDaySeparator(new Date(2026, 9, 3, 9, 0).toISOString(), now)).toBe(
      "Yesterday",
    );
    expect(formatGroupDaySeparator(new Date(2026, 9, 2, 21, 47).toISOString(), now)).toBe("Friday");
    expect(formatGroupDaySeparator(new Date(2026, 8, 15, 12, 0).toISOString(), now)).toBe(
      "Sep 15, 2026",
    );
  });

  it("message header tooltip is English with the 24h system clock", () => {
    render(<GroupMessageHeader createdAt={new Date(2026, 9, 2, 21, 47).toISOString()} name="A" />);
    const time = screen.getByTestId("group-message-header").querySelector("time");
    expect(time?.getAttribute("title")).toBe("Oct 2, 2026, 21:47");
  });
});

describe("no explicit locale on an en-US (h12) system (C6.2)", () => {
  it("keeps the 12h clock", () => {
    restoreSystem();
    vi.restoreAllMocks();
    restoreSystem = simulateSystemLocale("en-US");
    const friday = new Date(2026, 9, 2, 21, 47).getTime();
    expect(formatClock(friday, new Date(2026, 9, 2, 23, 0))).toBe("9:47 PM");
    expect(formatClock(friday, new Date(2026, 9, 4, 12, 0))).toBe("Friday 9:47 PM");
    expect(formatClock(friday, new Date(2026, 9, 20, 12, 0))).toBe("Oct 2 9:47 PM");
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
    const friday = new Date(2026, 9, 2, 21, 47).getTime();
    const later = new Date(2026, 9, 4, 12, 0);
    expect(formatClock(friday, later, groupRoomIntlLocale("pt-BR"))).toBe("sexta-feira 21:47");
    expect(formatClock(friday, new Date(2026, 9, 20), groupRoomIntlLocale("pt-BR"))).toBe(
      "2 de out. 21:47",
    );
    expect(formatClock(friday, later, groupRoomIntlLocale("zh-CN"))).toBe("星期五 21:47");
    expect(formatGroupDaySeparator(new Date(2026, 8, 15, 12).toISOString(), later, "pt-BR")).toBe(
      "15 de set. de 2026",
    );
    render(
      <GroupMessageHeader createdAt={todayAt(21, 47).toISOString()} locale="en-US" name="A" />,
    );
    expect(screen.getByTestId("group-message-header").querySelector("time")?.textContent).toBe(
      "9:47 PM",
    );
  });
});
