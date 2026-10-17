import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiLanguageState } from "../../shared/ui-language";
import {
  createUiLanguageController,
  currentUiLocale,
  setCurrentUiLanguageSource,
  UI_LANGUAGE_ARGUMENT_PREFIX,
  type UiLanguageWindow,
} from "./ui-language-controller";
import { createUiLanguageStore, UI_LANGUAGE_FILE_NAME } from "./ui-language-store";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "modus-ui-language-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  setCurrentUiLanguageSource(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeWindow() {
  const handlers: Record<string, () => void> = {};
  const sent: UiLanguageState[] = [];
  const window: UiLanguageWindow = {
    isDestroyed: () => false,
    on: (event, listener) => {
      handlers[event] = listener;
    },
    once: (event, listener) => {
      handlers[event] = listener;
    },
    webContents: {
      send: (_channel, state) => sent.push(state),
      on: (event, listener) => {
        handlers[event] = listener;
      },
    },
  };
  return { window, handlers, sent };
}

describe("language store (userData/ui-language.json)", () => {
  it("defaults to System when missing, unreadable or unknown", () => {
    const dir = tempDir();
    expect(createUiLanguageStore(dir).read()).toBe("system");
    writeFileSync(join(dir, UI_LANGUAGE_FILE_NAME), "not json");
    expect(createUiLanguageStore(dir).read()).toBe("system");
    writeFileSync(join(dir, UI_LANGUAGE_FILE_NAME), '{"language":"fr-FR"}');
    expect(createUiLanguageStore(dir).read()).toBe("system");
  });

  it("persists across a reload: a new controller on the same userData starts in the chosen language", () => {
    const dir = tempDir();
    const first = createUiLanguageController({
      store: createUiLanguageStore(dir),
      systemLocales: () => ["en-US"],
    });
    first.set("pt-BR");
    expect(JSON.parse(readFileSync(join(dir, UI_LANGUAGE_FILE_NAME), "utf8"))).toEqual({
      language: "pt-BR",
    });
    const reloaded = createUiLanguageController({
      store: createUiLanguageStore(dir),
      systemLocales: () => ["en-US"],
    });
    expect(reloaded.getState()).toMatchObject({ preference: "pt-BR", language: "pt-BR" });
    // The preload reads this flag synchronously, so the first frame is already pt.
    const argument = reloaded.rendererArgument();
    expect(argument.startsWith(UI_LANGUAGE_ARGUMENT_PREFIX)).toBe(true);
    expect(JSON.parse(argument.slice(UI_LANGUAGE_ARGUMENT_PREFIX.length))).toMatchObject({
      intlLocale: "pt-BR",
    });
  });
});

describe("language controller", () => {
  it("System follows the OS locale, re-read when a window regains focus", () => {
    let os = ["pt-PT"];
    const controller = createUiLanguageController({
      store: createUiLanguageStore(tempDir()),
      systemLocales: () => os,
    });
    expect(controller.getState()).toMatchObject({
      preference: "system",
      language: "pt-BR",
      intlLocale: "pt-PT",
    });
    const { window, handlers, sent } = fakeWindow();
    controller.attach(window);
    os = ["en-GB"];
    handlers.focus?.();
    expect(controller.getState()).toMatchObject({ language: "en", intlLocale: "en-GB" });
    expect(sent.at(-1)).toMatchObject({ language: "en" });
  });

  it("switches live: pushes the state to every window and to main listeners (menu rebuild)", () => {
    const controller = createUiLanguageController({
      store: createUiLanguageStore(tempDir()),
      systemLocales: () => ["en-US"],
    });
    const rebuildMenu = vi.fn();
    controller.onChange(rebuildMenu);
    const a = fakeWindow();
    const b = fakeWindow();
    controller.attach(a.window);
    controller.attach(b.window);
    setCurrentUiLanguageSource(() => controller.getState());
    expect(currentUiLocale()).toBe("en-US");

    controller.set("pt-BR");
    expect(rebuildMenu).toHaveBeenCalledTimes(1);
    expect(rebuildMenu).toHaveBeenLastCalledWith(expect.objectContaining({ intlLocale: "pt-BR" }));
    expect(a.sent.at(-1)).toMatchObject({ language: "pt-BR" });
    expect(b.sent.at(-1)).toMatchObject({ language: "pt-BR" });
    expect(currentUiLocale()).toBe("pt-BR");

    // Same value again: nothing to rebuild.
    controller.set("pt-BR");
    expect(rebuildMenu).toHaveBeenCalledTimes(1);
    // A reloaded window gets the current state on load.
    a.handlers["did-finish-load"]?.();
    expect(a.sent.at(-1)).toMatchObject({ language: "pt-BR" });
  });

  it("no controller yet → undefined (English)", () => {
    expect(currentUiLocale()).toBeUndefined();
  });
});
