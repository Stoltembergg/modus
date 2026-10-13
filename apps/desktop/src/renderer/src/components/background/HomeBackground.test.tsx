// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const gridProps: Array<Record<string, unknown>> = [];
vi.mock("./ShapeGrid", () => ({
  default: (props: Record<string, unknown>) => {
    gridProps.push(props);
    return null;
  },
}));

const { HOME_GRID_HOVER, HomeBackground, homeGridLineColor } = await import("./HomeBackground");

afterEach(() => {
  cleanup();
  gridProps.length = 0;
  document.documentElement.style.removeProperty("--color-fg");
});

describe("HomeBackground", () => {
  it("takes the line colour from --color-fg at low opacity and hovers in the logo purple", () => {
    document.documentElement.style.setProperty("--color-fg", "#e7ebf1");
    expect(homeGridLineColor()).toBe("rgba(231, 235, 241, 0.06)");
    render(<HomeBackground />);
    expect(screen.getByTestId("home-background").getAttribute("aria-hidden")).toBe("true");
    const last = gridProps.at(-1);
    expect(last?.lineColor).toBe("rgba(231, 235, 241, 0.06)");
    expect(last?.hoverColor).toBe(HOME_GRID_HOVER);
    expect(last?.fade).toBe(0);
    expect(HOME_GRID_HOVER).toContain("134, 63, 245");
  });

  it("pauses while the window is hidden", () => {
    render(<HomeBackground />);
    expect(gridProps.at(-1)?.paused).toBe(false);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(gridProps.at(-1)?.paused).toBe(true);
    hidden.mockRestore();
  });
});
