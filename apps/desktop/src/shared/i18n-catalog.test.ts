import { afterEach, describe, expect, it } from "vitest";
import { lookupCatalogText } from "./i18n-catalog";
import { mainText } from "./main-text";
import {
  SETTINGS_TEXT_EN,
  SETTINGS_TEXT_PT,
  type SettingsTextKey,
  settingsText,
} from "./settings-text";

const MISSING: SettingsTextKey = "settings.general.languageDesc";
const original = SETTINGS_TEXT_PT[MISSING];
afterEach(() => {
  SETTINGS_TEXT_PT[MISSING] = original;
});

describe("per-key English fallback", () => {
  it("falls back for the missing key only", () => {
    const en = { a: "Alpha", b: "Beta" } as const;
    const pt: Partial<Record<keyof typeof en, string>> = { a: "Alfa" };
    expect(lookupCatalogText(en, pt, "a")).toBe("Alfa");
    expect(lookupCatalogText(en, pt, "b")).toBe("Beta");
    expect(lookupCatalogText(en, { a: "" }, "a")).toBe("Alpha"); // empty counts as missing
    expect(lookupCatalogText(en, undefined, "a")).toBe("Alpha");
  });

  it("one key deleted from the real pt Settings table: that key is English, every other stays pt", () => {
    delete (SETTINGS_TEXT_PT as Partial<Record<SettingsTextKey, string>>)[MISSING];
    expect(settingsText(MISSING, "pt-BR")).toBe(SETTINGS_TEXT_EN[MISSING]);
    const keys = Object.keys(SETTINGS_TEXT_EN) as SettingsTextKey[];
    const english = keys.filter(
      (key) =>
        settingsText(key, "pt-BR") === SETTINGS_TEXT_EN[key] &&
        SETTINGS_TEXT_PT[key] !== SETTINGS_TEXT_EN[key],
    );
    expect(english).toEqual([MISSING]);
    expect(settingsText("settings.general.languageTitle", "pt-BR")).toBe("Idioma");
  });

  it("main-process copy uses the same rule", () => {
    expect(mainText("main.menu.edit", "pt-BR")).toBe("Editar");
    expect(mainText("main.menu.quit", "pt-BR", { app: "Modus" })).toBe("Encerrar Modus");
    expect(mainText("main.menu.quit", undefined, { app: "Modus" })).toBe("Quit Modus");
  });
});
