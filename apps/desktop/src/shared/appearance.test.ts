import { describe, expect, it } from "vitest";
import {
  type AppearancePreferences,
  type OsAppearance,
  resolveAppearance,
  themeSourceFor,
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
  ...p,
});

describe("resolveAppearance (D2 state matrix)", () => {
  it("gives every theme the same glass in Sidebar and Full on hosts with a native material", () => {
    for (const theme of ["dark", "dark-plus", "light"] as const) {
      for (const transparency of ["sidebar", "full"] as const) {
        expect(
          resolveAppearance({ window: MAC, preferences: prefs({ theme, transparency }), os: OS }),
        ).toMatchObject({
          glass: true,
          glassMode: transparency,
          material: "vibrancy",
          blockedBy: null,
          effectiveTheme: theme,
        });
        expect(
          resolveAppearance({ window: WIN11, preferences: prefs({ theme, transparency }), os: OS }),
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
});
