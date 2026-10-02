/**
 * Shared density ladder — one size set for chrome glyphs across the app.
 * Prefer these over one-off 11/13/15/17/21 values so surfaces feel planned.
 *
 *   xs 12  — chevrons, tiny dismiss
 *   sm 14  — row actions, menu items, inline status
 *   md 16  — toolbar / composer primary controls
 *   lg 18  — browser chrome
 *   rail 20 — primary navigation; sized for clear vector rendering
 */
export const ICON = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  rail: 20,
} as const;

export const ICON_STROKE = {
  xs: 2,
  sm: 1.8,
  md: 1.7,
  lg: 1.6,
  rail: 1.65,
} as const;
