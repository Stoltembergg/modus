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
      transparent: true,
    });
  });

  it("uses solid client surfaces and the operating system frame without native glass", () => {
    expect(windowChromeOptionsFor(resolveWindowAppearance("linux", "6.12.0"))).toEqual({
      backgroundColor: "#131314",
      frame: true,
      transparent: false,
    });
  });

  it("retains Windows native controls when Mica falls back to solid surfaces", () => {
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
      backgroundColor: "#131314",
      transparent: false,
    });
  });
});
