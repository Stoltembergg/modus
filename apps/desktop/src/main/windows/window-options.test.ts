import { describe, expect, it } from "vitest";
import { resolveWindowAppearance } from "../../shared/window-appearance";
import { windowChromeOptionsFor } from "./window-options";

describe("windowChromeOptionsFor", () => {
  it("keeps macOS traffic lights native and opts into sidebar vibrancy", () => {
    expect(windowChromeOptionsFor(resolveWindowAppearance("darwin", "15.0.0"))).toMatchObject({
      titleBarStyle: "hiddenInset",
      transparent: true,
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
    });
  });

  it("keeps native macOS controls with a solid window fallback", () => {
    expect(
      windowChromeOptionsFor({
        chrome: "macos",
        glass: "solid",
      }),
    ).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 10 },
      backgroundColor: "#131314",
      transparent: false,
    });
  });

  it("uses the native Windows controls overlay instead of drawing caption buttons", () => {
    expect(windowChromeOptionsFor(resolveWindowAppearance("win32", "10.0.22621"))).toMatchObject({
      frame: false,
      thickFrame: true,
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 36 },
      transparent: false,
      roundedCorners: true,
      backgroundMaterial: "acrylic",
    });
  });

  it("sets visible caption colors before first paint in each Windows theme", () => {
    const host = resolveWindowAppearance("win32", "10.0.22621");
    expect(
      windowChromeOptionsFor(host, { glass: true, effectiveTheme: "dark", look: "new" }),
    ).toMatchObject({
      titleBarOverlay: { color: "#00000000", symbolColor: "#f2f4f8", height: 36 },
    });
    expect(
      windowChromeOptionsFor(host, { glass: true, effectiveTheme: "light", look: "new" }),
    ).toMatchObject({
      titleBarOverlay: { color: "#00000000", symbolColor: "#161c27", height: 36 },
    });
    expect(
      windowChromeOptionsFor(host, { glass: false, effectiveTheme: "light", look: "new" }),
    ).toMatchObject({
      backgroundColor: "#f6f8fb",
      backgroundMaterial: "none",
      titleBarOverlay: { color: "#f6f8fb", symbolColor: "#161c27", height: 36 },
      transparent: false,
      roundedCorners: true,
    });
  });

  it("uses solid client surfaces and the operating system frame without native glass", () => {
    expect(windowChromeOptionsFor(resolveWindowAppearance("linux", "6.12.0"))).toEqual({
      backgroundColor: "#131314",
      frame: true,
      transparent: false,
    });
  });

  it("retains Windows native controls and corners when Acrylic falls back to solid surfaces", () => {
    expect(
      windowChromeOptionsFor({
        chrome: "windows-overlay",
        glass: "solid",
      }),
    ).toMatchObject({
      frame: false,
      thickFrame: true,
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 36 },
      backgroundColor: "#0f1520",
      backgroundMaterial: "none",
      roundedCorners: true,
      transparent: false,
    });
  });
});
