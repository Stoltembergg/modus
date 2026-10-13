import { useEffect, useState } from "react";
import ShapeGrid from "./ShapeGrid";

/** Hover tint: the Modus logo purple at low opacity. */
export const HOME_GRID_HOVER = "rgba(134, 63, 245, 0.18)";

function hexToRgba(hex: string, alpha: number): string | null {
  const m = hex.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(m.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Grid line colour from the theme's --color-fg token, kept faint. */
export function homeGridLineColor(root: HTMLElement = document.documentElement): string {
  const fg = getComputedStyle(root).getPropertyValue("--color-fg");
  return hexToRgba(fg, 0.06) ?? "rgba(128, 128, 128, 0.06)";
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}

/** Re-read the line colour whenever <html data-theme> changes. */
function useThemeLineColor(): string {
  const [color, setColor] = useState(() =>
    typeof document === "undefined" ? "rgba(128, 128, 128, 0.06)" : homeGridLineColor(),
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setColor(homeGridLineColor(root)));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-ui"] });
    return () => observer.disconnect();
  }, []);
  return color;
}

/**
 * Animated grid behind the home composer. ShapeGrid already honours
 * prefers-reduced-motion and stops while off-screen; this also pauses it
 * while the window is hidden.
 */
export function HomeBackground() {
  const hidden = useDocumentHidden();
  const lineColor = useThemeLineColor();
  return (
    <div
      aria-hidden="true"
      className="pointer-events-auto absolute inset-0 z-0"
      data-testid="home-background"
    >
      <ShapeGrid
        clickCascade={false}
        direction="diagonal"
        hoverColor={HOME_GRID_HOVER}
        hoverFillColor={HOME_GRID_HOVER}
        lineColor={lineColor}
        paused={hidden}
        shape="square"
        speed={0.3}
      />
    </div>
  );
}
