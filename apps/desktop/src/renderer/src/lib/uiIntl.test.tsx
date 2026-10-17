// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatCredits, formatMoney } from "../features/settings/sections/account-billing";
import { formatClock } from "./formatClock";
import {
  formatUiCompactAge,
  formatUiDate,
  formatUiNumber,
  formatUiRelativeTime,
  uiIntlLocale,
  useUiIntlLocale,
} from "./uiIntl";

afterEach(() => {
  cleanup();
  document.documentElement.lang = "";
});

const MIN = 60_000;
const date = new Date(2026, 9, 17, 21, 5);

describe("dates and numbers follow the app language (<html lang>)", () => {
  it("nothing set (tests, pre-boot) → en-US", () => {
    document.documentElement.lang = "";
    expect(uiIntlLocale()).toBe("en-US");
    expect(formatUiNumber(5000.5)).toBe("5,000.5");
  });

  it("English", () => {
    document.documentElement.lang = "en-US";
    expect(formatUiNumber(5000.5)).toBe("5,000.5");
    expect(formatUiDate(date, { month: "long", day: "numeric" })).toBe("October 17");
    expect(formatUiRelativeTime(5 * MIN)).toBe("5m ago");
    expect(formatUiRelativeTime(10_000)).toBe("now");
    expect(formatUiCompactAge(5 * MIN)).toBe("5m");
    expect(formatCredits(5000)).toBe("5,000");
    expect(formatClock(date.getTime(), date)).toBe("9:05 PM");
  });

  it("Português (Brasil)", () => {
    document.documentElement.lang = "pt-BR";
    expect(formatUiNumber(5000.5)).toBe("5.000,5");
    expect(formatUiDate(date, { month: "long", day: "numeric" })).toBe("17 de outubro");
    expect(formatUiRelativeTime(5 * MIN)).toBe("há 5 min.");
    expect(formatUiRelativeTime(10_000)).toBe("agora");
    expect(formatUiRelativeTime(3 * 24 * 60 * MIN)).toBe("há 3 dias");
    expect(formatUiCompactAge(5 * MIN)).toBe("5 min");
    expect(formatCredits(5000)).toBe("5.000");
    expect(formatMoney(3690, "BRL").replace(/\s/g, " ")).toBe("R$ 36,90");
    expect(formatClock(date.getTime(), date)).toBe("21:05");
  });

  it("System keeps the OS region for Intl (en-GB dates, English text)", () => {
    document.documentElement.lang = "en-GB";
    expect(formatUiDate(date, { day: "2-digit", month: "2-digit", year: "numeric" })).toBe(
      "17/10/2026",
    );
  });

  it("components re-render with the new locale on a language change", async () => {
    function Probe() {
      const locale = useUiIntlLocale();
      return <span data-testid="n">{formatUiNumber(1234.5, undefined, locale)}</span>;
    }
    document.documentElement.lang = "en-US";
    render(<Probe />);
    expect(screen.getByTestId("n").textContent).toBe("1,234.5");
    document.documentElement.lang = "pt-BR";
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("n").textContent).toBe("1.234,5");
  });
});
