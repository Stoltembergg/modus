// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThemeMode } from "./theme";

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("system theme", () => {
  it("uses the operating system palette and follows preference changes", async () => {
    let prefersLight = false;
    const changeListeners = new Set<(event: Event) => void>();
    const mediaQuery = {
      get matches() {
        return prefersLight;
      },
      media: "(prefers-color-scheme: light)",
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        changeListeners.add((event) => {
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        });
      },
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as MediaQueryList;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mediaQuery),
    );

    const theme = await import("./theme");
    theme.initTheme();
    theme.setTheme("system" as ThemeMode);

    expect(theme.getTheme()).toBe("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    prefersLight = true;
    for (const listener of changeListeners) listener(new Event("change"));

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("modus.theme")).toBe("system");
  });
});
