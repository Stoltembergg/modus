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
  transparency: "auto",
  ...p,
});

describe("resolveAppearance (D2 state matrix)", () => {
  it("keeps glass for dark and dark-plus on hosts with a native material", () => {
    for (const theme of ["dark", "dark-plus"] as const) {
      expect(
        resolveAppearance({ window: MAC, preferences: prefs({ theme }), os: OS }),
      ).toMatchObject({
        glass: true,
        material: "vibrancy",
        blockedBy: null,
        effectiveTheme: theme,
      });
      expect(
        resolveAppearance({ window: WIN11, preferences: prefs({ theme }), os: OS }),
      ).toMatchObject({ glass: true, material: "mica" });
    }
  });

  it("never gives glass to the light theme, explicit or through the system theme", () => {
    for (const window of [MAC, WIN11]) {
      expect(
        resolveAppearance({ window, preferences: prefs({ theme: "light" }), os: OS }),
      ).toMatchObject({ glass: false, material: "none", blockedBy: "light-theme" });
      expect(
        resolveAppearance({
          window,
          preferences: prefs({ theme: "system" }),
          os: { ...OS, dark: false },
        }),
      ).toMatchObject({ glass: false, effectiveTheme: "light", blockedBy: "light-theme" });
    }
    expect(
      resolveAppearance({ window: MAC, preferences: prefs({ theme: "system" }), os: OS }),
    ).toMatchObject({ glass: true, effectiveTheme: "dark" });
  });

  it("turns glass off when the user picks Off", () => {
    expect(
      resolveAppearance({ window: MAC, preferences: prefs({ transparency: "off" }), os: OS }),
    ).toMatchObject({ glass: false, material: "none", blockedBy: "user" });
  });

  it("lets OS accessibility win over an Automatic preference", () => {
    expect(
      resolveAppearance({
        window: MAC,
        preferences: prefs(),
        os: { ...OS, reducedTransparency: true },
      }),
    ).toMatchObject({ glass: false, blockedBy: "os-reduced-transparency" });
    expect(
      resolveAppearance({ window: WIN11, preferences: prefs(), os: { ...OS, highContrast: true } }),
    ).toMatchObject({ glass: false, blockedBy: "os-high-contrast" });
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
