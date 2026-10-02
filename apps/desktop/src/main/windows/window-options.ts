import type { BrowserWindowConstructorOptions } from "electron";
import type { WindowAppearance } from "../../shared/window-appearance";

export function windowChromeOptionsFor(
  appearance: WindowAppearance,
): Pick<
  BrowserWindowConstructorOptions,
  | "backgroundColor"
  | "frame"
  | "thickFrame"
  | "titleBarOverlay"
  | "titleBarStyle"
  | "trafficLightPosition"
  | "transparent"
  | "vibrancy"
  | "visualEffectState"
> {
  if (appearance.chrome === "macos") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 10 },
      backgroundColor: appearance.glass === "native" ? "#00000000" : "#131314",
      transparent: appearance.glass === "native",
      ...(appearance.glass === "native"
        ? { vibrancy: "sidebar" as const, visualEffectState: "followWindow" as const }
        : {}),
    };
  }

  if (appearance.chrome === "windows-overlay") {
    return {
      backgroundColor: appearance.glass === "native" ? "#00000000" : "#131314",
      frame: false,
      thickFrame: true,
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 36 },
      transparent: appearance.glass === "native",
    };
  }

  return {
    backgroundColor: "#131314",
    frame: true,
    transparent: false,
  };
}
