import { useSyncExternalStore } from "react";

/**
 * App color theme. Dark is the original, hand-tuned palette; Light and
 * Dark+ override the same semantic tokens without changing component code.
 *
 * The active theme is a single `data-theme` attribute on <html>; all visuals
 * come from CSS custom properties overridden under `:root[data-theme]`
 * in app.css, so switching is instant and component code never changes.
 */
export type ThemeMode = "dark" | "light" | "dark-plus" | "system";
export type EffectiveThemeMode = Exclude<ThemeMode, "system">;

const STORAGE_KEY = "modus.theme";
const DEFAULT_THEME: ThemeMode = "dark";

function readStored(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "dark-plus" || value === "system"
      ? value
      : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

let current: ThemeMode = readStored();
let systemColorScheme: MediaQueryList | null = null;
let systemColorSchemeListenerAttached = false;
const listeners = new Set<() => void>();

function getSystemColorScheme(): MediaQueryList | null {
  if (systemColorScheme) return systemColorScheme;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  systemColorScheme = window.matchMedia("(prefers-color-scheme: light)");
  return systemColorScheme;
}

export function resolveThemePreference(
  preference: ThemeMode,
  systemPrefersLight = getSystemColorScheme()?.matches ?? false,
): EffectiveThemeMode {
  if (preference === "system") return systemPrefersLight ? "light" : "dark";
  return preference;
}

/** Reflect the effective palette onto <html data-theme>. Safe to call repeatedly. */
export function applyTheme(preference: ThemeMode): void {
  document.documentElement.setAttribute("data-theme", resolveThemePreference(preference));
}

function handleSystemColorSchemeChange(): void {
  if (current !== "system") return;
  applyTheme(current);
  for (const listener of listeners) listener();
}

/** Call once before first render so the correct palette paints with no flash. */
export function initTheme(): void {
  const media = getSystemColorScheme();
  if (media && !systemColorSchemeListenerAttached) {
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleSystemColorSchemeChange);
    } else {
      media.addListener(handleSystemColorSchemeChange);
    }
    systemColorSchemeListenerAttached = true;
  }
  applyTheme(current);
}

/** User-selected preference; "system" remains distinct from the resolved palette. */
export function getTheme(): ThemeMode {
  return current;
}

export function getEffectiveTheme(): EffectiveThemeMode {
  return resolveThemePreference(current);
}

export function setTheme(mode: ThemeMode): void {
  if (mode === current) {
    return;
  }
  current = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore persistence failures (private mode etc.)
  }
  applyTheme(mode);
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive [theme, setTheme] for components (e.g. the Appearance toggle). */
export function useTheme(): readonly [ThemeMode, (mode: ThemeMode) => void] {
  const theme = useSyncExternalStore(subscribe, getTheme, getTheme);
  return [theme, setTheme];
}

/** Reactive resolved palette for components that need to select theme-specific assets. */
export function useEffectiveTheme(): EffectiveThemeMode {
  return useSyncExternalStore(subscribe, getEffectiveTheme, getEffectiveTheme);
}
