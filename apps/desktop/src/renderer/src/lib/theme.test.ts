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

describe("theme sync with the main process (D2)", () => {
  function stubModus(initialTheme: string | null) {
    const set = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal("modus", {
      app: { appearance: { initial: initialTheme ? { theme: initialTheme } : null, set } },
    });
    return set;
  }

  it("pushes every theme change so nativeTheme and the window material follow", async () => {
    const set = stubModus("dark");
    const theme = await import("./theme");
    theme.initTheme();
    expect(set).not.toHaveBeenCalled();
    theme.setTheme("light");
    expect(set).toHaveBeenCalledWith({ theme: "light" });
  });

  it("migrates a localStorage theme the main process does not know yet", async () => {
    window.localStorage.setItem("modus.theme", "dark-plus");
    const set = stubModus(null);
    const theme = await import("./theme");
    theme.initTheme();
    expect(set).toHaveBeenCalledWith({ theme: "dark-plus" });
  });
});
