import { describe, expect, it } from "vitest";
import {
  type AppearancePreferences,
  applyAppearanceInput,
  effectiveThemeFor,
  effectiveTransparency,
  NEW_LOOK_SOLID_WINDOW_BACKGROUND,
  NEW_LOOK_WINDOW_SYMBOL_COLOR,
  type OsAppearance,
  resolveAppearance,
  solidWindowBackground,
  themeSourceFor,
  windowSymbolColor,
} from "./appearance";
import { resolveWindowAppearance } from "./window-appearance";

const MAC = resolveWindowAppearance("darwin", "15.0.0");
const WIN11 = resolveWindowAppearance("win32", "10.0.22631");
const WIN10 = resolveWindowAppearance("win32", "10.0.19045");
const LINUX = resolveWindowAppearance("linux", "6.12.0");
const OS: OsAppearance = { dark: true, reducedTransparency: false, highContrast: false };
const prefs = (p: Partial<AppearancePreferences> = {}): AppearancePreferences => ({
  theme: "dark",
  transparency: "sidebar",
  look: "new",
  ...p,
});

describe("resolveAppearance (D2 state matrix)", () => {
  it("gives every theme the same glass in Sidebar and Full on hosts with a native material", () => {
    for (const theme of ["dark", "dark-plus", "light"] as const) {
      for (const transparency of ["sidebar", "full"] as const) {
        expect(
          resolveAppearance({
            window: MAC,
            preferences: prefs({ theme, transparency, transparencyChosen: true }),
            os: OS,
          }),
        ).toMatchObject({
          glass: true,
          glassMode: transparency,
          material: "vibrancy",
          blockedBy: null,
          effectiveTheme: theme === "dark-plus" ? "dark" : theme,
        });
        expect(
          resolveAppearance({
            window: WIN11,
            preferences: prefs({ theme, transparency, transparencyChosen: true }),
            os: OS,
          }),
        ).toMatchObject({ glass: true, glassMode: transparency, material: "mica" });
      }
    }
  });

  it("resolves the system theme from the OS without changing the glass decision", () => {
    for (const dark of [true, false]) {
      expect(
        resolveAppearance({
          window: MAC,
          preferences: prefs({ theme: "system" }),
          os: { ...OS, dark },
        }),
      ).toMatchObject({ glass: true, effectiveTheme: dark ? "dark" : "light" });
    }
  });

  it("turns glass off when the user picks Off", () => {
    expect(
      resolveAppearance({ window: MAC, preferences: prefs({ transparency: "off" }), os: OS }),
    ).toMatchObject({ glass: false, glassMode: "off", material: "none", blockedBy: "user" });
  });

  it("lets OS accessibility force Off over Full and Sidebar, in every theme", () => {
    for (const theme of ["dark", "dark-plus", "light"] as const) {
      for (const transparency of ["sidebar", "full"] as const) {
        const preferences = prefs({ theme, transparency });
        expect(
          resolveAppearance({ window: MAC, preferences, os: { ...OS, reducedTransparency: true } }),
        ).toMatchObject({ glass: false, glassMode: "off", blockedBy: "os-reduced-transparency" });
        expect(
          resolveAppearance({ window: WIN11, preferences, os: { ...OS, highContrast: true } }),
        ).toMatchObject({ glass: false, glassMode: "off", blockedBy: "os-high-contrast" });
      }
    }
  });

  it("is always solid without a native material (Win10, Linux, declined Mica)", () => {
    for (const window of [WIN10, LINUX, { ...WIN11, glass: "solid" as const }]) {
      expect(resolveAppearance({ window, preferences: prefs(), os: OS })).toMatchObject({
        glass: false,
        material: "none",
        blockedBy: "platform",
      });
    }
  });

  it("maps the theme preference onto nativeTheme.themeSource", () => {
    expect(themeSourceFor("system")).toBe("system");
    expect(themeSourceFor("light")).toBe("light");
    expect(themeSourceFor("dark")).toBe("dark");
    expect(themeSourceFor("dark-plus")).toBe("dark");
  });

  it("migrates a stored classic look to new without rewriting Transparency", () => {
    const legacy = {
      theme: "dark",
      transparency: "sidebar",
      look: "classic",
    } as unknown as Parameters<typeof applyAppearanceInput>[0];
    const next = applyAppearanceInput(legacy, { theme: "light" });
    expect(next).toEqual({ theme: "light", transparency: "sidebar", look: "new" });
    // Unchosen Sidebar was the classic default: the new look applies Full.
    expect(effectiveTransparency(next)).toBe("full");
    const state = resolveAppearance({ window: MAC, preferences: legacy, os: OS });
    expect(state.look).toBe("new");
    expect(state.glassMode).toBe("full");
  });

  it("keeps an explicit Transparency", () => {
    const base = { theme: "dark", transparency: "sidebar", look: "new" } as const;
    const picked = applyAppearanceInput(base, { transparency: "sidebar" });
    expect(picked).toEqual({ ...base, transparencyChosen: true });
    expect(effectiveTransparency(picked)).toBe("sidebar");
    expect(effectiveTransparency({ transparency: "off", look: "new" })).toBe("off");
    expect(effectiveTransparency({ transparency: "full", look: "new" })).toBe("full");
  });

  it("shows a stored Eye-care Dark as Dark", () => {
    expect(effectiveThemeFor("dark-plus", true)).toBe("dark");
    expect(effectiveThemeFor("dark-plus", false)).toBe("dark");
    const state = resolveAppearance({
      window: MAC,
      preferences: prefs({ theme: "dark-plus" }),
      os: OS,
    });
    expect(state.effectiveTheme).toBe("dark");
  });

  it("uses the new-look window colours", () => {
    expect(solidWindowBackground({ look: "new", effectiveTheme: "dark" })).toBe(
      NEW_LOOK_SOLID_WINDOW_BACKGROUND.dark,
    );
    expect(solidWindowBackground({ look: "new", effectiveTheme: "light" })).toBe(
      NEW_LOOK_SOLID_WINDOW_BACKGROUND.light,
    );
    expect(windowSymbolColor({ look: "new", effectiveTheme: "dark" })).toBe(
      NEW_LOOK_WINDOW_SYMBOL_COLOR.dark,
    );
    expect(windowSymbolColor({ look: "new", effectiveTheme: "light" })).toBe(
      NEW_LOOK_WINDOW_SYMBOL_COLOR.light,
    );
  });
});
