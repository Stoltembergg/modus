import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatUiCompactAge,
  formatUiDate,
  formatUiNumber,
  formatUiRelativeTime,
  uiIntlLocale,
  useUiIntlLocale,
} from "./uiIntl";
import * as uiLocale from "./uiLocale";

// Mock `useUiLocale` for react hook testing
vi.mock("./uiLocale", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    readUiLocale: vi.fn(),
    useUiLocale: vi.fn(),
  };
});

describe("uiIntl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("uiIntlLocale", () => {
    it("returns provided locale when given", () => {
      expect(uiIntlLocale("pt-BR")).toBe("pt-BR");
    });

    it("falls back to en-US if readUiLocale returns nothing and no arg provided", () => {
      vi.spyOn(uiLocale, "readUiLocale").mockReturnValue(undefined);
      expect(uiIntlLocale()).toBe("en-US");
    });

    it("uses readUiLocale if no arg is provided", () => {
      vi.spyOn(uiLocale, "readUiLocale").mockReturnValue("pt-BR");
      expect(uiIntlLocale()).toBe("pt-BR");
    });
  });

  describe("useUiIntlLocale", () => {
    it("uses useUiLocale to determine the intl locale", () => {
      vi.spyOn(uiLocale, "useUiLocale").mockReturnValue("zh-CN");
      expect(useUiIntlLocale()).toBe("zh-CN");
    });
  });

  describe("formatUiNumber", () => {
    it("formats numbers based on locale", () => {
      expect(formatUiNumber(1234.5, undefined, "en-US")).toBe("1,234.5");
      expect(formatUiNumber(1234.5, undefined, "pt-BR")).toBe("1.234,5");
    });

    it("applies options", () => {
      expect(formatUiNumber(1234.5, { style: "currency", currency: "USD" }, "en-US")).toBe(
        "$1,234.50",
      );
    });
  });

  describe("formatUiDate", () => {
    it("formats dates", () => {
      const date = new Date("2023-12-25T12:00:00Z");
      // Use options to ensure consistent output regardless of local timezone
      const options: Intl.DateTimeFormatOptions = {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        timeZone: "UTC",
      };

      expect(formatUiDate(date, options, "en-US")).toBe("12/25/2023");
      expect(formatUiDate(date, options, "pt-BR")).toBe("25/12/2023");
    });
  });

  describe("formatUiRelativeTime", () => {
    it("formats < 1 minute as 'now'", () => {
      expect(formatUiRelativeTime(50_000, { locale: "en-US" })).toBe("now");
      expect(formatUiRelativeTime(0, { locale: "en-US" })).toBe("now");
      expect(formatUiRelativeTime(-5000, { locale: "en-US" })).toBe("now");
    });

    it("formats minutes", () => {
      expect(formatUiRelativeTime(65_000, { locale: "en-US" })).toBe("1m ago");
      expect(formatUiRelativeTime(120_000, { locale: "en-US" })).toBe("2m ago");
    });

    it("formats hours", () => {
      expect(formatUiRelativeTime(2 * 60 * 60_000, { locale: "en-US" })).toBe("2h ago");
    });

    it("formats days", () => {
      expect(formatUiRelativeTime(3 * 24 * 60 * 60_000, { locale: "en-US" })).toBe("3d ago");
    });

    it("formats weeks", () => {
      expect(formatUiRelativeTime(10 * 24 * 60 * 60_000, { locale: "en-US" })).toBe("last wk.");
    });

    it("respects maxUnit = day", () => {
      // 10 days should not roll over to weeks
      expect(formatUiRelativeTime(10 * 24 * 60 * 60_000, { locale: "en-US", maxUnit: "day" })).toBe(
        "10d ago",
      );
    });

    it("respects locale", () => {
      // Note: Node 22 RelativeTimeFormat narrow pt-BR has specific outputs
      // We know format uses Intl.RelativeTimeFormat under the hood
      const format = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto", style: "narrow" });
      const expected = format.format(-2, "hour");
      expect(formatUiRelativeTime(2 * 60 * 60_000, { locale: "pt-BR" })).toBe(expected);
    });
  });

  describe("formatUiCompactAge", () => {
    it("formats < 1 hour in minutes", () => {
      expect(formatUiCompactAge(0, "en-US")).toBe("1m"); // Minimum 1 minute
      expect(formatUiCompactAge(30_000, "en-US")).toBe("1m"); // Minimum 1 minute
      expect(formatUiCompactAge(60_000, "en-US")).toBe("1m");
      expect(formatUiCompactAge(45 * 60_000, "en-US")).toBe("45m");
    });

    it("formats < 24 hours in hours", () => {
      expect(formatUiCompactAge(60 * 60_000, "en-US")).toBe("1h");
      expect(formatUiCompactAge(23 * 60 * 60_000, "en-US")).toBe("23h");
    });

    it("formats < 14 days in days", () => {
      expect(formatUiCompactAge(24 * 60 * 60_000, "en-US")).toBe("1d");
      expect(formatUiCompactAge(13 * 24 * 60 * 60_000, "en-US")).toBe("13d");
    });

    it("formats >= 14 days in weeks", () => {
      expect(formatUiCompactAge(14 * 24 * 60 * 60_000, "en-US")).toBe("2w");
      expect(formatUiCompactAge(30 * 24 * 60 * 60_000, "en-US")).toBe("4w");
    });

    it("respects locale", () => {
      // Note: Node 22 NumberFormat narrow pt-BR has specific outputs
      // We know format uses Intl.NumberFormat under the hood
      const unit = (val: number, name: string) =>
        new Intl.NumberFormat("pt-BR", { style: "unit", unit: name, unitDisplay: "narrow" }).format(
          val,
        );
      expect(formatUiCompactAge(60 * 60_000, "pt-BR")).toBe(unit(1, "hour"));
      expect(formatUiCompactAge(3 * 24 * 60 * 60_000, "pt-BR")).toBe(unit(3, "day"));
      expect(formatUiCompactAge(14 * 24 * 60 * 60_000, "pt-BR")).toBe(unit(2, "week"));
    });
  });
});
