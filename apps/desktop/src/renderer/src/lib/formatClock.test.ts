import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupRoomIntlLocale, systemHourCycle } from "../../../shared/group-room-locale";
import { formatClock } from "./formatClock";
import { simulateSystemLocale } from "./systemLocale.test-helpers";

// Fixed reference: Thursday 2026-06-11 14:00 local time.
const now = new Date(2026, 5, 11, 14, 0, 0);

describe("formatClock", () => {
  it("returns an empty string for missing or invalid input", () => {
    expect(formatClock(undefined, now)).toBe("");
    expect(formatClock(0, now)).toBe("");
    expect(formatClock(Number.NaN, now)).toBe("");
  });

  const today = new Date(2026, 5, 11, 9, 5).getTime();
  const evening = new Date(2026, 5, 11, 21, 47).getTime();
  const monday = new Date(2026, 5, 8, 17, 17).getTime();
  const older = new Date(2026, 5, 3, 17, 17).getTime();

  // C6.2: no locale = en-US names with the system hour cycle.
  describe("no locale on a pt-BR (h23) system", () => {
    let restore = () => {};
    beforeEach(() => {
      restore = simulateSystemLocale("pt-BR");
    });
    afterEach(() => {
      restore();
      vi.restoreAllMocks();
    });

    it("24h time, English weekday and month, no AM/PM, no padding", () => {
      expect(systemHourCycle()).toBe("h23");
      expect(formatClock(evening, now)).toBe("21:47");
      for (const ms of [evening, today, monday, older]) {
        expect(formatClock(ms, now)).not.toMatch(/AM|PM|\u202f|h/);
      }
      expect(formatClock(today, now)).toBe("9:05");
      expect(formatClock(monday, now)).toBe("Monday 17:17");
      expect(formatClock(older, now)).toBe("Jun 3 17:17");
    });
  });

  describe("no locale on an en-US (h12) system", () => {
    let restore = () => {};
    beforeEach(() => {
      restore = simulateSystemLocale("en-US");
    });
    afterEach(() => {
      restore();
      vi.restoreAllMocks();
    });

    it("12h time, same as before C6", () => {
      expect(systemHourCycle()).toBe("h12");
      expect(formatClock(evening, now)).toBe("9:47 PM");
      expect(formatClock(today, now)).toBe("9:05 AM");
      expect(formatClock(monday, now)).toBe("Monday 5:17 PM");
      expect(formatClock(older, now)).toBe("Jun 3 5:17 PM");
      // Identical to the pre-C6 call on that system.
      expect(formatClock(evening, now)).toBe(
        new Date(evening).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      );
    });
  });
});

// C6: the group room passes its locale (groupRoomIntlLocale) so the clock
// matches the room copy instead of the OS locale.
describe("formatClock with the room locale", () => {
  const monday = new Date(2026, 5, 8, 17, 17).getTime();
  const older = new Date(2026, 5, 3, 17, 17).getTime();
  const today = new Date(2026, 5, 11, 9, 5).getTime();

  it("formats in pt-BR (24h clock, Portuguese weekday and month)", () => {
    const pt = groupRoomIntlLocale("pt-BR");
    expect(pt).toBe("pt-BR");
    expect(formatClock(today, now, pt)).toBe("9:05");
    expect(formatClock(monday, now, pt)).toBe("segunda-feira 17:17");
    expect(formatClock(older, now, pt)).toBe("3 de jun. 17:17");
  });

  it("formats in zh-CN (Chinese weekday and month)", () => {
    const zh = groupRoomIntlLocale("zh");
    expect(zh).toBe("zh");
    expect(formatClock(monday, now, zh)).toBe("星期一 17:17");
    expect(formatClock(older, now, zh)).toBe("6月3日 17:17");
    expect(formatClock(monday, now, groupRoomIntlLocale("zh-CN"))).toBe("星期一 17:17");
  });

  it("uses the catalog's resolution rule for unsupported tags (English)", () => {
    expect(groupRoomIntlLocale("fr-FR")).toBe("en-US");
    expect(formatClock(monday, now, groupRoomIntlLocale("fr-FR"))).toBe("Monday 5:17 PM");
  });
});
