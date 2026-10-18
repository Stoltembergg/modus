import type { AutomationSchedule } from "./automations";

export type { AutomationSchedule } from "./automations";

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type MissedAutomationOccurrences = {
  first: string | null;
  last: string | null;
  count: number;
  nextOccurrence: string | null;
};

const HOUR_MS = 60 * 60 * 1000;

/** Returns the next scheduled instant after `after`, using calendar time in the saved zone. */
export function nextAutomationOccurrence(
  schedule: AutomationSchedule,
  timeZone: string,
  after: string,
): string | null {
  validateTimeZone(timeZone);
  validateSchedule(schedule);
  const afterMs = parseInstant(after, "after");

  if (schedule.kind === "once") {
    const atMs = parseInstant(schedule.at, "schedule.at");
    return atMs > afterMs ? new Date(atMs).toISOString() : null;
  }

  const [hour, minute] = parseLocalTime(schedule.localTime);
  const wantedDays = schedule.kind === "weekly" ? validateWeekdays(schedule.daysOfWeek) : null;
  const firstLocalDate = localDateParts(afterMs, timeZone);

  // A weekly schedule must find its next day in this range; the extra year also
  // protects against timezone transitions that skip a configured wall time.
  for (let offset = 0; offset <= 370; offset += 1) {
    const date = addCalendarDays(firstLocalDate, offset);
    if (wantedDays && !wantedDays.has(weekday(date))) continue;

    const candidate = firstInstantForLocalDateTime({ ...date, hour, minute, second: 0 }, timeZone);
    if (candidate !== null && candidate > afterMs) return new Date(candidate).toISOString();
  }
  return null;
}

/** Resolves a user-entered wall time; gaps are rejected and folds choose the first instant. */
export function localDateTimeToInstant(value: string, timeZone: string): string | null {
  validateTimeZone(timeZone);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Date and time must use the local YYYY-MM-DD HH:mm format.");
  const target: LocalDateTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: 0,
  };
  const normalized = new Date(
    Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute),
  );
  if (
    normalized.getUTCFullYear() !== target.year ||
    normalized.getUTCMonth() + 1 !== target.month ||
    normalized.getUTCDate() !== target.day ||
    target.hour > 23 ||
    target.minute > 59
  ) {
    throw new Error("Choose a valid local date and time.");
  }
  const instant = firstInstantForLocalDateTime(target, timeZone);
  return instant === null ? null : new Date(instant).toISOString();
}

/** Summarizes elapsed calendar occurrences without turning them into runnable backlog. */
export function findMissedAutomationOccurrences(
  schedule: AutomationSchedule,
  timeZone: string,
  after: string,
  through: string,
): MissedAutomationOccurrences {
  const throughMs = parseInstant(through, "through");
  const afterMs = parseInstant(after, "after");
  if (throughMs < afterMs) throw new Error("through must be at or after after.");

  let occurrence = nextAutomationOccurrence(schedule, timeZone, new Date(afterMs).toISOString());
  let first: string | null = null;
  let last: string | null = null;
  let count = 0;

  while (occurrence !== null && Date.parse(occurrence) <= throughMs) {
    first ??= occurrence;
    last = occurrence;
    count += 1;
    occurrence = nextAutomationOccurrence(schedule, timeZone, occurrence);
  }

  return { first, last, count, nextOccurrence: occurrence };
}

function parseInstant(value: string, field: string): number {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be an ISO date-time.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} must be an ISO date-time.`);
  return milliseconds;
}

function parseLocalTime(value: string): [number, number] {
  if (typeof value !== "string") throw new Error("Schedule time must use HH:mm.");
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) throw new Error("Schedule time must use HH:mm.");
  return [hour, minute];
}

function validateWeekdays(days: number[]): Set<number> {
  if (
    !Array.isArray(days) ||
    days.length === 0 ||
    days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
    new Set(days).size !== days.length
  ) {
    throw new Error("Weekly schedules require unique weekdays from 0 through 6.");
  }
  return new Set(days);
}

function validateTimeZone(timeZone: string): void {
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new Error("An IANA time zone is required.");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    throw new Error(`Invalid IANA time zone: ${timeZone}`);
  }
}

function validateSchedule(schedule: AutomationSchedule): void {
  if (!schedule || typeof schedule !== "object") {
    throw new Error("A valid automation schedule is required.");
  }
  if (schedule.kind === "once") {
    parseInstant(schedule.at, "schedule.at");
    return;
  }
  if (schedule.kind === "daily") {
    parseLocalTime(schedule.localTime);
    return;
  }
  if (schedule.kind === "weekly") {
    parseLocalTime(schedule.localTime);
    validateWeekdays(schedule.daysOfWeek);
    return;
  }
  throw new Error("Unsupported automation schedule.");
}

function localDateParts(instant: number, timeZone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type)?.value;
    if (!part) throw new Error(`Unable to resolve local ${type} in ${timeZone}.`);
    return Number(part);
  };
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function addCalendarDays(date: LocalDateTime, days: number): LocalDateTime {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

function weekday(date: LocalDateTime): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function sameLocalDateTime(left: LocalDateTime, right: LocalDateTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

/** A missing wall time yields no instant; an ambiguous one yields its first instant. */
function firstInstantForLocalDateTime(target: LocalDateTime, timeZone: string): number | null {
  const wallAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  const offsets = new Set<number>();

  // Sample both sides of the wall time so both offsets are found during a DST fold.
  for (let delta = -36 * HOUR_MS; delta <= 36 * HOUR_MS; delta += 6 * HOUR_MS) {
    const sample = wallAsUtc + delta;
    const local = localDateParts(sample, timeZone);
    const localAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    offsets.add(localAsUtc - sample);
  }

  const matches = [...offsets]
    .map((offset) => wallAsUtc - offset)
    .filter((instant) => sameLocalDateTime(localDateParts(instant, timeZone), target))
    .sort((left, right) => left - right);
  return matches[0] ?? null;
}
