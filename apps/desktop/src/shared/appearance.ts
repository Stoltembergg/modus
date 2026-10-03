import type { WindowAppearance } from "./window-appearance";

/**
 * D2 appearance model shared by main, preload and renderer.
 *
 * The user picks a theme and a Transparency mode; the OS contributes its
 * appearance and accessibility settings. Modes, identical in every theme
 * (dark, dark-plus and light):
 * - "sidebar" (default): the window material (macOS vibrancy / Win11 Mica)
 *   shows only through the left chrome (rail + context sidebar);
 * - "full": canvas and overlays are translucent too;
 * - "off": every surface is solid and the window material is off.
 * OS accessibility (reduce transparency, high contrast, forced colors) always
 * forces "off": there is deliberately no "force on".
 */
export type ThemePreference = "dark" | "light" | "dark-plus" | "system";
export type TransparencyPreference = "full" | "sidebar" | "off";
export type AppearancePreferences = {
  theme: ThemePreference;
  transparency: TransparencyPreference;
};
export type AppearanceSetInput = {
  theme?: ThemePreference | undefined;
  transparency?: TransparencyPreference | undefined;
};
export type EffectiveTheme = Exclude<ThemePreference, "system">;

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  theme: "dark",
  transparency: "sidebar",
};

export type OsAppearance = {
  /** nativeTheme.shouldUseDarkColors with themeSource = "system". */
  dark: boolean;
  reducedTransparency: boolean;
  /** High contrast / increased contrast / forced colors. */
  highContrast: boolean;
};

export type GlassMaterial = "vibrancy" | "mica" | "none";
export type GlassBlockReason = "platform" | "user" | "os-reduced-transparency" | "os-high-contrast";

export type AppearanceState = AppearancePreferences & {
  effectiveTheme: EffectiveTheme;
  /** Transparency actually applied ("off" whenever `blockedBy` is set). */
  glassMode: TransparencyPreference;
  /** Window material on: glassMode is "full" or "sidebar". */
  glass: boolean;
  material: GlassMaterial;
  blockedBy: GlassBlockReason | null;
  os: OsAppearance;
};

/** Solid window colour per palette (mirrors --color-canvas in app.css). */
export const SOLID_WINDOW_BACKGROUND: Record<EffectiveTheme, string> = {
  dark: "#131314",
  "dark-plus": "#1e1e1e",
  light: "#ffffff",
};

/** Window-control glyph colour per palette (mirrors --color-fg in app.css). */
export const WINDOW_SYMBOL_COLOR: Record<EffectiveTheme, string> = {
  dark: "#d8d8d7",
  "dark-plus": "#cccccc",
  light: "#222222",
};

/** nativeTheme.themeSource that keeps OS materials and prefers-color-scheme on the app palette. */
export function themeSourceFor(theme: ThemePreference): "system" | "light" | "dark" {
  if (theme === "system") return "system";
  return theme === "light" ? "light" : "dark";
}

export function effectiveThemeFor(theme: ThemePreference, osDark: boolean): EffectiveTheme {
  if (theme === "system") return osDark ? "dark" : "light";
  return theme;
}

function glassBlockReason(
  supported: boolean,
  preferences: AppearancePreferences,
  os: OsAppearance,
): GlassBlockReason | null {
  if (!supported) return "platform";
  if (os.reducedTransparency) return "os-reduced-transparency";
  if (os.highContrast) return "os-high-contrast";
  if (preferences.transparency === "off") return "user";
  return null;
}

export function resolveAppearance({
  window,
  preferences,
  os,
}: {
  /** Host capability; `glass: "solid"` also covers a native effect the OS declined. */
  window: WindowAppearance;
  preferences: AppearancePreferences;
  os: OsAppearance;
}): AppearanceState {
  const effectiveTheme = effectiveThemeFor(preferences.theme, os.dark);
  const blockedBy = glassBlockReason(window.glass === "native", preferences, os);
  const glass = blockedBy === null;
  const material: GlassMaterial = !glass ? "none" : window.chrome === "macos" ? "vibrancy" : "mica";
  const glassMode = glass ? preferences.transparency : "off";
  return { ...preferences, effectiveTheme, glassMode, glass, material, blockedBy, os };
}
