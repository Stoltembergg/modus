// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
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
    look: "new",
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

  it("has no Look switch and no Eye-care Dark option", () => {
    stubAppearance();
    render(<AppearanceSettingsPanel />);
    expect(screen.queryByText("Look")).toBeNull();
    expect(screen.queryByRole("button", { name: /Classic/i })).toBeNull();
    expect(screen.queryByText("Eye-care Dark")).toBeNull();
  });

  it("shows a stored Eye-care Dark as Dark", () => {
    stubAppearance({ theme: "dark-plus" });
    vi.stubGlobal("localStorage", { getItem: () => "dark-plus", setItem: () => {} });
    render(<AppearanceSettingsPanel />);
    expect(screen.getByRole("button", { name: /^Dark$/ }).getAttribute("aria-pressed")).not.toBe(
      "false",
    );
  });
});
