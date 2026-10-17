import { groupRoomIntlLocale } from "../../../shared/group-room-locale";
import { readUiLocale, useUiLocale } from "./uiLocale";

/**
 * `Intl` tag for dates and numbers: the app language (`<html lang>`), keeping
 * the OS region under "System" (en-GB, pt-PT). Pass it explicitly to every
 * `Intl.*` / `toLocale*String` call so formatting follows the chosen language,
 * not the runtime default. No language set (tests, before boot) → en-US.
 */
export function uiIntlLocale(tag: string | null | undefined = readUiLocale()): string {
  return groupRoomIntlLocale(tag) ?? "en-US";
}

/** Same as `uiIntlLocale`, re-rendering when the language changes. */
export function useUiIntlLocale(): string {
  return uiIntlLocale(useUiLocale());
}

export function formatUiNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale: string = uiIntlLocale(),
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatUiDate(
  value: Date | number,
  options?: Intl.DateTimeFormatOptions,
  locale: string = uiIntlLocale(),
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["week", 7 * 24 * 60 * 60_000],
  ["day", 24 * 60 * 60_000],
  ["hour", 60 * 60_000],
  ["minute", 60_000],
];

/**
 * "5 min ago" / "há 5 min" via `Intl.RelativeTimeFormat`. Under a minute is
 * "now" / "agora". `maxUnit` caps the largest unit (the inspector stops at days).
 */
export function formatUiRelativeTime(
  elapsedMs: number,
  {
    locale = uiIntlLocale(),
    style = "narrow",
    maxUnit = "week",
  }: {
    locale?: string;
    style?: Intl.RelativeTimeFormatStyle;
    maxUnit?: "week" | "day";
  } = {},
): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style });
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed < 60_000) return format.format(0, "second");
  const units = maxUnit === "day" ? UNITS.slice(1) : UNITS;
  for (const [unit, size] of units) {
    if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  }
  return format.format(0, "second");
}

/**
 * Compact age for dense lists ("5m", "2h", "3d", "1w" in English; "5 min",
 * "2 h", "3 dias", "1 sem." in pt): `Intl.NumberFormat` unit style, narrow.
 */
export function formatUiCompactAge(elapsedMs: number, locale: string = uiIntlLocale()): string {
  const minutes = Math.max(1, Math.floor(elapsedMs / 60_000));
  const unit = (value: number, name: string) =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(
      value,
    );
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 14) return unit(days, "day");
  return unit(Math.floor(days / 7), "week");
}
