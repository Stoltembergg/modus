import type { BrowserWindowConstructorOptions } from "electron";
import {
  type AppearanceState,
  solidWindowBackground,
  windowSymbolColor,
} from "../../shared/appearance";
import type { WindowAppearance } from "../../shared/window-appearance";

export function windowChromeOptionsFor(
  appearance: WindowAppearance,
  state?: Pick<AppearanceState, "glass" | "effectiveTheme" | "look">,
): Pick<
  BrowserWindowConstructorOptions,
  | "backgroundColor"
  | "backgroundMaterial"
  | "frame"
  | "thickFrame"
  | "roundedCorners"
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
    const palette = state ?? { effectiveTheme: "dark", look: "new" };
    const glass = appearance.glass === "native" && state?.glass !== false;
    return {
      backgroundColor: glass ? "#00000000" : solidWindowBackground(palette),
      backgroundMaterial: glass ? "acrylic" : "none",
      frame: false,
      thickFrame: true,
      roundedCorners: true,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: glass ? "#00000000" : solidWindowBackground(palette),
        symbolColor: windowSymbolColor(palette),
        height: 36,
      },
      // Electron disables WS_THICKFRAME and rounded corners for layered
      // transparent windows. DWM supplies translucency for this ordinary HWND.
      transparent: false,
    };
  }

  return {
    backgroundColor: "#131314",
    frame: true,
    transparent: false,
  };
}
