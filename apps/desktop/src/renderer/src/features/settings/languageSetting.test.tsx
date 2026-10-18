// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_TEXT_PT } from "../../../../shared/settings-text";
import {
  resolveUiLanguage,
  type UiLanguagePreference,
  type UiLanguageState,
} from "../../../../shared/ui-language";
import { useShellText } from "../../lib/shellText";
import { initUiLanguage, resetUiLanguageForTests } from "../../lib/uiLanguage";
import { LanguageSetting } from "./LanguageSetting";

/**
 * A fake main process: holds the preference "on disk", resolves System
 * against a fake OS list and pushes every change, like ui-language-controller.
 */
function fakeMain(osLocales: string[], stored: UiLanguagePreference = "system") {
  let preference = stored;
  const listeners = new Set<(state: UiLanguageState) => void>();
  const state = () => resolveUiLanguage(preference, osLocales);
  const bridge = {
    initial: state(),
    get: vi.fn(async () => state()),
    set: vi.fn(async (next: UiLanguagePreference) => {
      preference = next;
      for (const listener of listeners) listener(state());
      return state();
    }),
    onChange: (handler: (state: UiLanguageState) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: partial preload bridge for the test
  (window as any).modus = { app: { uiLanguage: bridge } };
  return {
    bridge,
    stored: () => preference,
    push: (next: UiLanguagePreference) => {
      preference = next;
      for (const listener of listeners) listener(state());
    },
  };
}

function ShellProbe() {
  const t = useShellText();
  return <p data-testid="shell">{t("shell.projects")}</p>;
}

beforeEach(() => {
  document.documentElement.lang = "en";
});
afterEach(() => {
  cleanup();
  resetUiLanguageForTests();
  // biome-ignore lint/suspicious/noExplicitAny: test cleanup
  delete (window as any).modus;
  document.documentElement.lang = "en";
});

describe("Settings > General > Language", () => {
  it("System follows the OS locale (pt-PT → Portuguese) before the first render", () => {
    fakeMain(["pt-PT"]);
    initUiLanguage();
    expect(document.documentElement.lang).toBe("pt-PT");
    render(<LanguageSetting />);
    expect(screen.getByRole("combobox", { name: "Idioma" })).toBeTruthy();
    // Minimal Settings: the row is the label and the select, no help line.
    expect(screen.queryByText(/^Muda na hora/)).toBeNull();
    expect(screen.getByText("Sistema (Português (Brasil))")).toBeTruthy();
  });

  it("an unknown OS language means English", () => {
    fakeMain(["fr-FR"]);
    initUiLanguage();
    render(<LanguageSetting />);
    expect(screen.getByRole("combobox", { name: "Language" })).toBeTruthy();
    expect(screen.getByText("System (English)")).toBeTruthy();
  });

  it("lists every language by its native name, whatever the current UI language", async () => {
    fakeMain(["en-US"], "pt-BR");
    initUiLanguage();
    const user = userEvent.setup();
    render(<LanguageSetting />);
    await user.click(screen.getByRole("combobox", { name: "Idioma" }));
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["Sistema", "English", "Português (Brasil)"]);
    expect(
      screen.getByRole("option", { name: "English" }).querySelector("[lang]")?.getAttribute("lang"),
    ).toBe("en");
  });

  it("switches live, without a remount, and persists the choice", async () => {
    const main = fakeMain(["en-US"]);
    initUiLanguage();
    render(
      <>
        <LanguageSetting />
        <ShellProbe />
      </>,
    );
    const user = userEvent.setup();
    const before = screen.getByTestId("shell");
    expect(before.textContent).toBe("Projects");
    await user.click(screen.getByRole("combobox", { name: "Language" }));
    await user.click(screen.getByRole("option", { name: "Português (Brasil)" }));
    expect(main.bridge.set).toHaveBeenCalledWith("pt-BR");
    expect(main.stored()).toBe("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");
    expect(screen.getByRole("combobox", { name: "Idioma" })).toBeTruthy();
    // Same DOM node, new text: the app shell re-rendered in place.
    expect(screen.getByTestId("shell")).toBe(before);
    expect(before.textContent).toBe("Projetos");

    // A change pushed by main (another window, OS change under System) applies too.
    await act(async () => main.push("en"));
    expect(before.textContent).toBe("Projects");
  });

  it("reload: a fresh renderer starts in the stored language", () => {
    fakeMain(["en-US"], "pt-BR");
    initUiLanguage();
    render(<ShellProbe />);
    expect(screen.getByTestId("shell").textContent).toBe("Projetos");
  });

  it("a key missing from pt falls back to English alone, the rest of the row stays pt", () => {
    const key = "settings.general.languageSystemResolved" as const;
    const saved = SETTINGS_TEXT_PT[key];
    delete (SETTINGS_TEXT_PT as Partial<typeof SETTINGS_TEXT_PT>)[key];
    try {
      fakeMain(["pt-BR"]);
      initUiLanguage();
      render(<LanguageSetting />);
      expect(screen.getByRole("combobox", { name: "Idioma" })).toBeTruthy();
      expect(screen.getByText("System (Português (Brasil))")).toBeTruthy();
      expect(screen.queryByText("Sistema (Português (Brasil))")).toBeNull();
    } finally {
      SETTINGS_TEXT_PT[key] = saved;
    }
  });
});
