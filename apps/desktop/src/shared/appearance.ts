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
/**
 * Visual generation (redesign Phase 1). "classic" is today's look and the
 * default; "new" swaps the design tokens (styles/tokens-new.css) through
 * <html data-ui>. Presentation only: nothing outside styling reads it.
 */
export type LookPreference = "classic" | "new";
export type AppearancePreferences = {
  theme: ThemePreference;
  /** Stored Transparency. Applied as-is only once chosen (see effectiveTransparency). */
  transparency: TransparencyPreference;
  look: LookPreference;
  /**
   * True once the user picked a Transparency mode. Until then each look uses
   * its own default (classic "sidebar", new "full"), resolved at read time so
   * switching looks never rewrites Transparency. Absent means false.
   */
  transparencyChosen?: true;
};
export type AppearanceSetInput = {
  theme?: ThemePreference | undefined;
  transparency?: TransparencyPreference | undefined;
  look?: LookPreference | undefined;
};
export type EffectiveTheme = Exclude<ThemePreference, "system">;

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  theme: "dark",
  transparency: "sidebar",
  look: "classic",
};

/** Transparency each look uses until the user picks one (the new concept is glass end to end). */
export const NEW_LOOK_DEFAULT_TRANSPARENCY: TransparencyPreference = "full";

export function defaultTransparencyFor(look: LookPreference): TransparencyPreference {
  return look === "new"
    ? NEW_LOOK_DEFAULT_TRANSPARENCY
    : DEFAULT_APPEARANCE_PREFERENCES.transparency;
}

/**
 * Transparency that applies. An explicit choice always wins. Files written
 * before the flag existed count as chosen when they hold anything but the
 * classic default, because that was the only way to get another value.
 */
export function effectiveTransparency(
  preferences: Pick<AppearancePreferences, "transparency" | "transparencyChosen"> & {
    look?: LookPreference | undefined;
  },
): TransparencyPreference {
  const chosen =
    preferences.transparencyChosen === true ||
    preferences.transparency !== DEFAULT_APPEARANCE_PREFERENCES.transparency;
  return chosen
    ? preferences.transparency
    : defaultTransparencyFor(preferences.look ?? DEFAULT_APPEARANCE_PREFERENCES.look);
}

/**
 * Merge a set() input into the stored preferences. Changing the look writes
 * only `look`; picking a Transparency stores it and marks it as chosen.
 */
export function applyAppearanceInput(
  preferences: AppearancePreferences,
  input: AppearanceSetInput,
): AppearancePreferences {
  const chosen = preferences.transparencyChosen === true || input.transparency !== undefined;
  return {
    theme: input.theme ?? preferences.theme,
    transparency: input.transparency ?? preferences.transparency,
    look: input.look ?? preferences.look,
    ...(chosen ? { transparencyChosen: true as const } : {}),
  };
}

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

/** Solid window colour in the new look (mirrors --color-canvas in tokens-new.css). */
export const NEW_LOOK_SOLID_WINDOW_BACKGROUND: Record<
  Exclude<EffectiveTheme, "dark-plus">,
  string
> = {
  dark: "#0f1520",
  light: "#f6f8fb",
};

/** Window-control glyph colour in the new look (mirrors --color-fg in tokens-new.css). */
export const NEW_LOOK_WINDOW_SYMBOL_COLOR: Record<Exclude<EffectiveTheme, "dark-plus">, string> = {
  dark: "#e7ebf1",
  light: "#161c27",
};

/** Solid window colour for a resolved appearance (look-aware). */
export function solidWindowBackground(
  state: Pick<AppearanceState, "effectiveTheme" | "look">,
): string {
  if (state.look === "new") {
    return NEW_LOOK_SOLID_WINDOW_BACKGROUND[state.effectiveTheme === "light" ? "light" : "dark"];
  }
  return SOLID_WINDOW_BACKGROUND[state.effectiveTheme];
}

/** Window-control glyph colour for a resolved appearance (look-aware). */
export function windowSymbolColor(state: Pick<AppearanceState, "effectiveTheme" | "look">): string {
  if (state.look === "new") {
    return NEW_LOOK_WINDOW_SYMBOL_COLOR[state.effectiveTheme === "light" ? "light" : "dark"];
  }
  return WINDOW_SYMBOL_COLOR[state.effectiveTheme];
}

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

export function effectiveThemeFor(
  theme: ThemePreference,
  osDark: boolean,
  look: LookPreference = "classic",
): EffectiveTheme {
  if (theme === "system") return osDark ? "dark" : "light";
  // Eye-care Dark is classic-only; the new look shows its dark palette instead.
  if (theme === "dark-plus" && look === "new") return "dark";
  return theme;
}

function glassBlockReason(
  supported: boolean,
  preferences: Pick<AppearancePreferences, "transparency">,
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
  /** `look` may be omitted by callers that predate it; it then reads as "classic". */
  preferences: Omit<AppearancePreferences, "look"> & { look?: LookPreference | undefined };
  os: OsAppearance;
}): AppearanceState {
  const { transparencyChosen: _chosen, ...stored } = preferences;
  const look = stored.look ?? DEFAULT_APPEARANCE_PREFERENCES.look;
  // The state carries the Transparency that applies, so Settings shows it.
  const transparency = effectiveTransparency({ ...preferences, look });
  const effectiveTheme = effectiveThemeFor(stored.theme, os.dark, look);
  const blockedBy = glassBlockReason(window.glass === "native", { transparency }, os);
  const glass = blockedBy === null;
  const material: GlassMaterial = !glass ? "none" : window.chrome === "macos" ? "vibrancy" : "mica";
  const glassMode = glass ? transparency : "off";
  return {
    ...stored,
    transparency,
    look,
    effectiveTheme,
    glassMode,
    glass,
    material,
    blockedBy,
    os,
  };
}
