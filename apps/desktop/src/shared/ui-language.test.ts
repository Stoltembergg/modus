import { describe, expect, it } from "vitest";
import { matchSystemLanguage, resolveUiLanguage, UI_LANGUAGES } from "./ui-language";

describe("System language mapping (OS locale → shipped language)", () => {
  it.each([
    [["pt-BR"], "pt-BR", "pt-BR"],
    [["pt-PT"], "pt-BR", "pt-PT"], // no pt-PT catalog: pt-BR text, pt-PT dates
    [["pt"], "pt-BR", "pt"],
    [["pt_BR"], "pt-BR", "pt-BR"], // underscore tags from some OSes
    [["en-GB"], "en", "en-GB"],
    [["en-US"], "en", "en-US"],
    [["en"], "en", "en"],
    [["fr-FR"], "en", "en-US"], // unknown → English
    [["de-DE", "ja-JP"], "en", "en-US"],
    [["zh-CN"], "en", "en-US"], // zh is not offered (no Settings / menu copy)
    [[], "en", "en-US"],
    [["", "not a locale!"], "en", "en-US"],
  ])("%j → %s (Intl %s)", (os, language, intlLocale) => {
    const state = resolveUiLanguage("system", os);
    expect(state.language).toBe(language);
    expect(state.intlLocale).toBe(intlLocale);
  });

  it("walks the OS list in order: the first entry that maps to anything decides", () => {
    expect(matchSystemLanguage(["fr-FR", "pt-PT", "en-US"]).language).toBe("pt-BR");
    expect(matchSystemLanguage(["en-GB", "pt-BR"]).language).toBe("en");
  });

  it("an explicit choice ignores the OS and uses that language's own Intl tag", () => {
    expect(resolveUiLanguage("en", ["pt-BR"])).toMatchObject({
      language: "en",
      intlLocale: "en-US",
    });
    expect(resolveUiLanguage("pt-BR", ["en-GB"])).toMatchObject({
      language: "pt-BR",
      intlLocale: "pt-BR",
    });
  });

  it("lists each language by its own native name", () => {
    expect(UI_LANGUAGES.map((language) => language.nativeName)).toEqual([
      "English",
      "Português (Brasil)",
    ]);
  });
});
