import { describe, expect, it } from "vitest";
import { groupRoomIntlLocale } from "../../../shared/group-room-locale";
import { formatClock } from "./formatClock";

// Fixed reference: Thursday 2026-06-11 14:00 local time.
const now = new Date(2026, 5, 11, 14, 0, 0);

describe("formatClock", () => {
  it("returns an empty string for missing or invalid input", () => {
    expect(formatClock(undefined, now)).toBe("");
    expect(formatClock(0, now)).toBe("");
    expect(formatClock(Number.NaN, now)).toBe("");
  });

  // Labels honor the system locale, so expectations are derived through the
  // same Intl calls — the tests pin down BRANCH selection (today / week / older).
  const timeOf = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  it("shows only the time for today's messages", () => {
    const todayMorning = new Date(2026, 5, 11, 9, 5).getTime();
    expect(formatClock(todayMorning, now)).toBe(timeOf(todayMorning));
  });

  it("shows weekday + time within the last week", () => {
    const monday = new Date(2026, 5, 8, 17, 17).getTime();
    const weekday = new Date(monday).toLocaleDateString([], { weekday: "long" });
    expect(formatClock(monday, now)).toBe(`${weekday} ${timeOf(monday)}`);
  });

  it("shows a short date + time beyond a week", () => {
    const older = new Date(2026, 5, 3, 17, 17).getTime();
    const date = new Date(older).toLocaleDateString([], { month: "short", day: "numeric" });
    const label = formatClock(older, now);
    expect(label).toBe(`${date} ${timeOf(older)}`);
    expect(label).not.toBe(timeOf(older));
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
