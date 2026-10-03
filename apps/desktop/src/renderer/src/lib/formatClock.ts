import { formatGroupRoomDate } from "../../../shared/group-room-locale";

/**
 * Cursor-style message clock: time for today, weekday + time within the last
 * week, short date + time beyond that ("5:17 PM" / "Monday 5:17 PM" /
 * "Jun 3 5:17 PM"). `now` is injectable for tests. `locale` is a BCP-47 tag
 * for `Intl` (the group room passes `groupRoomIntlLocale(...)`) and makes the
 * whole clock that locale. Omitted (C6.2): en-US weekday / month names, with
 * the system's hour cycle ("21:47" / "Friday 21:47" / "Oct 2 21:47" on a 24h
 * system, "9:47 PM" on a 12h one).
 */
export function formatClock(ms?: number, now: Date = new Date(), locale?: string): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const time = formatGroupRoomDate(date, { hour: "numeric", minute: "2-digit" }, locale);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startOfToday) {
    return time;
  }
  if (ms >= startOfToday - 6 * 24 * 60 * 60 * 1000) {
    return `${formatGroupRoomDate(date, { weekday: "long" }, locale)} ${time}`;
  }
  return `${formatGroupRoomDate(date, { month: "short", day: "numeric" }, locale)} ${time}`;
}
