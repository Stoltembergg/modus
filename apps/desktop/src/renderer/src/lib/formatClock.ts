/**
 * Cursor-style message clock: time for today, weekday + time within the last
 * week, short date + time beyond that ("5:17 PM" / "Monday 5:17 PM" /
 * "Jun 3 5:17 PM"). `now` is injectable for tests. `locale` is a BCP-47 tag
 * for `Intl` (the group room passes `groupRoomIntlLocale(...)`); omitted = the
 * runtime default, as before.
 */
export function formatClock(ms?: number, now: Date = new Date(), locale?: string): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const tag = locale ?? [];
  const time = date.toLocaleTimeString(tag, { hour: "numeric", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startOfToday) {
    return time;
  }
  if (ms >= startOfToday - 6 * 24 * 60 * 60 * 1000) {
    return `${date.toLocaleDateString(tag, { weekday: "long" })} ${time}`;
  }
  return `${date.toLocaleDateString(tag, { month: "short", day: "numeric" })} ${time}`;
}
