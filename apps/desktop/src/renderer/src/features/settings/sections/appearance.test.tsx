// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppearanceState } from "../../../../../shared/appearance";
import { getTheme, setTheme } from "../../../lib/theme";
import { AppearanceSettingsPanel, transparencyNotice } from "./appearance";

const base: AppearanceState = {
  theme: "dark",
  transparency: "sidebar",
  look: "new",
  effectiveTheme: "dark",
  glassMode: "sidebar",
  glass: true,
  material: "vibrancy",
  blockedBy: null,
  os: { dark: true, reducedTransparency: false, highContrast: false },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubAppearance(state: AppearanceState) {
  const set = vi.fn(() => Promise.resolve(state));
  vi.stubGlobal("modus", {
    app: {
      appearance: {
        initial: state,
        get: vi.fn(() => Promise.resolve(state)),
        set,
        onChange: vi.fn(() => () => undefined),
      },
    },
  });
  return set;
}

describe("Appearance settings — Transparency", () => {
  it("offers Full / Sidebar / Off (Sidebar selected by default) and persists the choice", async () => {
    const set = stubAppearance(base);
    await act(async () => {
      render(<AppearanceSettingsPanel />);
    });
    expect(screen.getByRole("button", { name: "Sidebar" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    for (const [label, value] of [
      ["Full", "full"],
      ["Off", "off"],
      ["Sidebar", "sidebar"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(set).toHaveBeenLastCalledWith({ transparency: value });
    }
  });

  it("is disabled where the platform has no native material", async () => {
    stubAppearance({ ...base, glass: false, material: "none", blockedBy: "platform" });
    await act(async () => {
      render(<AppearanceSettingsPanel />);
    });
    expect(screen.getByRole("button", { name: "Off" }).hasAttribute("disabled")).toBe(true);
  });

  it("only notes transparency when the window is kept solid", () => {
    expect(transparencyNotice({ ...base, blockedBy: "os-reduced-transparency" })).toMatch(
      /Reduce transparency/,
    );
    expect(transparencyNotice({ ...base, blockedBy: "os-high-contrast" })).toMatch(/high-contrast/);
    expect(transparencyNotice(null)).toMatch(/not available/);
    expect(transparencyNotice(base)).toBeUndefined();
    expect(
      transparencyNotice({ ...base, theme: "light", effectiveTheme: "light" }),
    ).toBeUndefined();
  });
});

describe("Appearance settings — Color scheme under the new look", () => {
  it("keeps a stored Eye-care Dark when the selected Dark is clicked again", async () => {
    setTheme("dark-plus");
    stubAppearance({ ...base, look: "new" });
    await act(async () => {
      render(<AppearanceSettingsPanel />);
    });
    const dark = screen.getByRole("button", { name: "Dark" });
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(dark);
    expect(getTheme()).toBe("dark-plus");
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(getTheme()).toBe("light");
    setTheme("dark");
  });
});
