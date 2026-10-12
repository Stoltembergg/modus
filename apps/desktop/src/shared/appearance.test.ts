import { describe, expect, it } from "vitest";
import {
  type AppearancePreferences,
  applyAppearanceInput,
  effectiveThemeFor,
  NEW_LOOK_SOLID_WINDOW_BACKGROUND,
  NEW_LOOK_WINDOW_SYMBOL_COLOR,
  type OsAppearance,
  resolveAppearance,
  SOLID_WINDOW_BACKGROUND,
  solidWindowBackground,
  themeSourceFor,
  WINDOW_SYMBOL_COLOR,
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
  look: "classic",
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

  it("applies appearance input with look transitions and preserves defaults appropriately", () => {
    // classic->new with sidebar becomes full
    expect(
      applyAppearanceInput(
        { theme: "dark", transparency: "sidebar", look: "classic" },
        { look: "new" },
      ),
    ).toEqual({ theme: "dark", transparency: "full", look: "new" });

    // classic->new with off stays off
    expect(
      applyAppearanceInput(
        { theme: "dark", transparency: "off", look: "classic" },
        { look: "new" },
      ),
    ).toEqual({ theme: "dark", transparency: "off", look: "new" });

    // classic->new with explicit transparency in same input keeps it
    expect(
      applyAppearanceInput(
        { theme: "dark", transparency: "sidebar", look: "classic" },
        { look: "new", transparency: "sidebar" },
      ),
    ).toEqual({ theme: "dark", transparency: "sidebar", look: "new" });

    // new->classic keeps full
    expect(
      applyAppearanceInput(
        { theme: "dark", transparency: "full", look: "new" },
        { look: "classic" },
      ),
    ).toEqual({ theme: "dark", transparency: "full", look: "classic" });

    // theme-only input keeps look
    expect(
      applyAppearanceInput(
        { theme: "dark", transparency: "full", look: "new" },
        { theme: "light" },
      ),
    ).toEqual({ theme: "light", transparency: "full", look: "new" });
  });

  it("resolves effective theme according to look", () => {
    expect(effectiveThemeFor("dark-plus", true, "new")).toBe("dark");
    expect(effectiveThemeFor("dark-plus", false, "new")).toBe("dark");
    expect(effectiveThemeFor("dark-plus", true, "classic")).toBe("dark-plus");
    expect(effectiveThemeFor("dark-plus", false, "classic")).toBe("dark-plus");
  });

  it("carries look through resolveAppearance", () => {
    const classicState = resolveAppearance({
      window: MAC,
      preferences: prefs({ look: "classic" }),
      os: OS,
    });
    expect(classicState.look).toBe("classic");

    const newState = resolveAppearance({
      window: MAC,
      preferences: prefs({ look: "new" }),
      os: OS,
    });
    expect(newState.look).toBe("new");

    const darkPlusNew = resolveAppearance({
      window: MAC,
      preferences: prefs({ theme: "dark-plus", look: "new" }),
      os: OS,
    });
    expect(darkPlusNew.effectiveTheme).toBe("dark");
    expect(darkPlusNew.look).toBe("new");
  });

  it("computes solidWindowBackground and windowSymbolColor for classic and new looks", () => {
    // classic
    expect(solidWindowBackground({ look: "classic", effectiveTheme: "dark" })).toBe(
      SOLID_WINDOW_BACKGROUND.dark,
    );
    expect(solidWindowBackground({ look: "classic", effectiveTheme: "dark-plus" })).toBe(
      SOLID_WINDOW_BACKGROUND["dark-plus"],
    );
    expect(solidWindowBackground({ look: "classic", effectiveTheme: "light" })).toBe(
      SOLID_WINDOW_BACKGROUND.light,
    );

    expect(windowSymbolColor({ look: "classic", effectiveTheme: "dark" })).toBe(
      WINDOW_SYMBOL_COLOR.dark,
    );
    expect(windowSymbolColor({ look: "classic", effectiveTheme: "dark-plus" })).toBe(
      WINDOW_SYMBOL_COLOR["dark-plus"],
    );
    expect(windowSymbolColor({ look: "classic", effectiveTheme: "light" })).toBe(
      WINDOW_SYMBOL_COLOR.light,
    );

    // new
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
