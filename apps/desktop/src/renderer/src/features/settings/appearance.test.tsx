// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppearanceState } from "../../../../shared/appearance";
import { AppearanceSettingsPanel } from "./sections/appearance";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubAppearance(overrides: Partial<AppearanceState> = {}) {
  const set = vi.fn().mockResolvedValue({});
  const initial: AppearanceState = {
    theme: "dark",
    transparency: "sidebar",
    look: "classic",
    effectiveTheme: "dark",
    glassMode: "sidebar",
    glass: true,
    material: "vibrancy",
    blockedBy: null,
    os: { dark: true, reducedTransparency: false, highContrast: false },
    ...overrides,
  };
  vi.stubGlobal("modus", {
    app: {
      appearance: {
        initial,
        get: vi.fn().mockResolvedValue(initial),
        set,
        onChange: vi.fn(() => () => {}),
      },
    },
  });
  return { set, initial };
}

describe("Appearance settings", () => {
  it("offers a System theme option alongside the explicit palettes", () => {
    const markup = renderToStaticMarkup(<AppearanceSettingsPanel />);

    expect(markup).toContain(">System</button>");
    expect(markup).toContain(">Light</button>");
    expect(markup).toContain(">Dark</button>");
  });

  it("renders Look row with Classic and New options, and clicking New calls appearance.set", () => {
    const { set } = stubAppearance({ look: "classic" });
    render(<AppearanceSettingsPanel />);

    const classicButton = screen.getByRole("button", { name: /Classic/i });
    const newButton = screen.getByRole("button", { name: /New/i });

    expect(classicButton).toBeDefined();
    expect(newButton).toBeDefined();

    fireEvent.click(newButton);
    expect(set).toHaveBeenCalledWith({ look: "new" });
  });

  it("presents Eye-care Dark with classic look and removes it with new look", () => {
    stubAppearance({ look: "classic" });
    const { unmount } = render(<AppearanceSettingsPanel />);
    expect(screen.queryByText("Eye-care Dark")).not.toBeNull();
    unmount();

    stubAppearance({ look: "new" });
    render(<AppearanceSettingsPanel />);
    expect(screen.queryByText("Eye-care Dark")).toBeNull();
  });
});
