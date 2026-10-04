// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupMessage } from "../../../../shared/contracts";
import { groupText } from "../../../../shared/group-room-locale";
import { GroupMessageList } from "./GroupMessageList";
import { GroupMessageRow } from "./GroupMessageRow";
import { GroupRoomLocaleProvider, useGroupRoomLocale } from "./groupRoomI18n";

afterEach(cleanup);

const members = [{ sessionId: "s-a", title: "Alpha" }];
const labels = new Map([["s-a", { title: "Alpha" }]]);

function userMessage(patch: Partial<GroupMessage> = {}): GroupMessage {
  return {
    id: "u-1",
    groupId: "g-1",
    authorKind: "user",
    kind: "message",
    body: "Oi",
    mentions: [],
    createdAt: "2026-06-08T17:17:00.000Z",
    ...patch,
  };
}

function EmptyList({ locale }: { locale: string }) {
  return (
    <GroupRoomLocaleProvider locale={locale}>
      <GroupMessageList
        avatars={new Map()}
        cwd={undefined}
        error={undefined}
        groupId="g-1"
        hasOlder={false}
        loadOlder={async () => undefined}
        loaded
        loadingOlder={false}
        memberStates={new Map()}
        members={members}
        messages={[]}
        onOpenFile={undefined}
        workingRows={[]}
      />
    </GroupRoomLocaleProvider>
  );
}

describe("room locale provider (C6)", () => {
  it("renders the empty transcript in pt and zh", () => {
    const { unmount } = render(<EmptyList locale="pt-BR" />);
    expect(screen.getByTestId("group-room-empty").textContent).toBe(groupText("list.empty", "pt"));
    unmount();
    render(<EmptyList locale="zh-CN" />);
    expect(screen.getByTestId("group-room-empty").textContent).toBe(groupText("list.empty", "zh"));
  });

  it("renders the user's own message chrome in the room locale", () => {
    render(
      <GroupRoomLocaleProvider locale="pt-BR">
        <GroupMessageRow labels={labels} members={members} message={userMessage()} />
      </GroupRoomLocaleProvider>,
    );
    const header = screen.getByTestId("group-message-header");
    expect(header.textContent).toContain("Você");
    expect(header.textContent).toContain("Humano");
    expect(screen.getByTestId("group-user-avatar").textContent).toBe("V");
    // The clock follows the room locale too (Intl pt-BR: "8 de jun. 14:17").
    const created = new Date("2026-06-08T17:17:00.000Z");
    const time = header.querySelector("time");
    expect(time?.textContent).toBe(
      `${created.toLocaleDateString("pt-BR", { month: "short", day: "numeric" })} ${created.toLocaleTimeString("pt-BR", { hour: "numeric", minute: "2-digit" })}`,
    );
    expect(time?.textContent).toContain("de jun.");
  });

  it("a component's own locale prop wins over the provider", () => {
    function Probe({ override }: { override?: string }) {
      return <span data-testid="probe">{useGroupRoomLocale(override) ?? "default"}</span>;
    }
    render(
      <GroupRoomLocaleProvider locale="zh-CN">
        <Probe override="pt-BR" />
      </GroupRoomLocaleProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("pt-BR");
  });

  it("without a provider the renderer locale applies (en under tests)", () => {
    render(<GroupMessageRow labels={labels} members={members} message={userMessage()} />);
    expect(screen.getByTestId("group-message-header").textContent).toContain("You");
  });
});
