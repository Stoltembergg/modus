// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { groupPluralText, groupRoomIntlLocale } from "../../../../shared/group-room-locale";
import { formatClock } from "../../lib/formatClock";
import {
  GroupRoomLocaleProvider,
  groupTextFor,
  useGroupRoomLocale,
  useGroupText,
} from "./groupRoomI18n";

afterEach(cleanup);

function PluralProbe({ override }: { override?: string }) {
  const t = useGroupText(override);
  return <span data-testid="plural">{t.plural("list.newMessages", 3)}</span>;
}

describe("room locale provider (C6)", () => {
  it("useGroupText follows the provider locale in pt and zh", () => {
    const { unmount } = render(
      <GroupRoomLocaleProvider locale="pt-BR">
        <PluralProbe />
      </GroupRoomLocaleProvider>,
    );
    expect(screen.getByTestId("plural").textContent).toBe(
      groupPluralText("list.newMessages", 3, "pt"),
    );
    expect(screen.getByTestId("plural").textContent).toBe("3 novas mensagens");
    unmount();
    render(
      <GroupRoomLocaleProvider locale="zh-CN">
        <PluralProbe />
      </GroupRoomLocaleProvider>,
    );
    expect(screen.getByTestId("plural").textContent).toBe("3 条新消息");
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
    render(<PluralProbe />);
    expect(screen.getByTestId("plural").textContent).toBe("3 new messages");
  });

  it("groupTextFor binds the locale outside React", () => {
    const t = groupTextFor("pt-BR");
    expect(t.locale).toBe("pt-BR");
    expect(t.plural("list.newMessages", 1)).toBe("1 nova mensagem");
    expect(groupTextFor(undefined)("common.lead")).toBe("Lead");
  });

  it('the message clock follows the room locale (pt-BR: "8 de jun. 14:17")', () => {
    function ClockProbe() {
      const locale = useGroupRoomLocale();
      const created = new Date("2026-06-08T17:17:00.000Z");
      return (
        <time data-testid="clock">
          {formatClock(
            created.getTime(),
            new Date("2026-07-01T12:00:00.000Z"),
            groupRoomIntlLocale(locale),
          )}
        </time>
      );
    }
    render(
      <GroupRoomLocaleProvider locale="pt-BR">
        <ClockProbe />
      </GroupRoomLocaleProvider>,
    );
    const created = new Date("2026-06-08T17:17:00.000Z");
    const text = screen.getByTestId("clock").textContent;
    expect(text).toBe(
      `${created.toLocaleDateString("pt-BR", { month: "short", day: "numeric" })} ${created.toLocaleTimeString("pt-BR", { hour: "numeric", minute: "2-digit" })}`,
    );
    expect(text).toContain("de jun.");
  });
});
