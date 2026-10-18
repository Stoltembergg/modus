import { describe, expect, it } from "vitest";
import {
  SETTINGS_TEXT_EN,
  SETTINGS_TEXT_PT,
  type SettingsTextKey,
  settingsPluralText,
  settingsText,
} from "./settings-text";

const KEYS = Object.keys(SETTINGS_TEXT_EN) as SettingsTextKey[];

/**
 * pt values that are the same as English on purpose (product names, codes,
 * words Brazilian Portuguese borrows as-is). Anything else equal to English
 * is a string someone forgot to translate.
 */
const SAME_IN_PT = new Set<SettingsTextKey>([
  // Product, brand and file names, codes and placeholders-only templates.
  "settings.window.appTitle",
  "settings.window.navGroupWorkspace",
  "settings.window.navGroupInterface",
  "settings.window.navSkills",
  "settings.providers.modelApiGoogleGemini",
  "settings.providerUi.contextTokens",
  "settings.providerUi.tokensPlaceholder",
  "settings.appearance.fontFamilyValue",
  "settings.appearance.agentsOverrideTitle",
  "settings.mcp.pageTitle",
  "settings.mcp.badgeGlobal",
  "settings.mcp.presetFilesystem",
  "settings.mcp.presetFetch",
  "settings.mcp.presetMemory",
  "settings.mcp.fieldUrl",
  "settings.integrations.titleComposio",
  "settings.integrations.modeConsumer",
  "settings.integrations.modePlatform",
  "settings.integrations.diagnosticStatus",
  "settings.integrations.accountRadioAriaLabel",
  "settings.skillsRules.skillsTitle",
  "settings.skillsRules.namePlaceholder",
  "settings.skillsRules.agentsSectionTitle",
  "settings.skillsRules.globs",
  "settings.skillsRules.ruleModeGlob",
  "settings.skillsRules.ruleModeManual",
]);

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
}

describe("settings text", () => {
  it("has the same keys in en and pt", () => {
    expect(Object.keys(SETTINGS_TEXT_PT).sort()).toEqual([...KEYS].sort());
  });

  it("uses the settings.<area>.<name> key format", () => {
    for (const key of KEYS) expect(key).toMatch(/^settings\.[a-zA-Z]+\.[a-zA-Z0-9_.]+$/);
  });

  it("translates every pt string (no empty or English copy left behind)", () => {
    const untranslated = KEYS.filter(
      (key) => !SAME_IN_PT.has(key) && SETTINGS_TEXT_PT[key] === SETTINGS_TEXT_EN[key],
    );
    expect(untranslated).toEqual([]);
    for (const key of KEYS) expect(SETTINGS_TEXT_PT[key].trim()).not.toBe("");
    for (const key of SAME_IN_PT) expect(SETTINGS_TEXT_PT[key]).toBe(SETTINGS_TEXT_EN[key]);
  });

  it("keeps the same {placeholders} in both languages", () => {
    for (const key of KEYS) {
      expect([key, placeholders(SETTINGS_TEXT_PT[key])]).toEqual([
        key,
        placeholders(SETTINGS_TEXT_EN[key]),
      ]);
    }
  });

  it("has both halves of every plural pair", () => {
    for (const key of KEYS) {
      const pair = key.match(/^(.*)_(one|other)$/);
      if (!pair) continue;
      expect(KEYS).toContain(`${pair[1]}_${pair[2] === "one" ? "other" : "one"}`);
    }
  });

  it("resolves the locale like the other catalogs: English unless pt is asked for", () => {
    expect(settingsText("settings.question.submit")).toBe("Submit");
    expect(settingsText("settings.question.submit", "en-US")).toBe("Submit");
    expect(settingsText("settings.question.submit", "pt-BR")).toBe("Enviar");
    expect(settingsText("settings.question.submit", "pt")).toBe("Enviar");
    // No Settings copy in Chinese yet: zh falls back to English.
    expect(settingsText("settings.question.submit", "zh-CN")).toBe("Submit");
  });

  it("fills placeholders and picks the plural form", () => {
    expect(settingsText("settings.question.pageOf", "pt-BR", { index: 2, total: 3 })).toBe(
      "2 de 3",
    );
    expect(settingsPluralText("settings.question.asked", 1)).toBe("Asked 1 question");
    expect(settingsPluralText("settings.question.asked", 3, "pt-BR")).toBe("Fez 3 perguntas");
  });
});

describe("#258 polish", () => {
  it("cites the exact approval button label in the MCP footer hint (EN and PT)", () => {
    // ApprovalPanel's button is "Yes, always allow in this project" (not localized).
    for (const table of [SETTINGS_TEXT_EN, SETTINGS_TEXT_PT]) {
      expect(table["settings.mcp.serversFooterHint"]).toContain(
        "“Yes, always allow in this project”",
      );
    }
  });

  it("keeps the reviewed literal pt-BR phrasings out of the catalog", () => {
    const pt = Object.values(SETTINGS_TEXT_PT).join("\n");
    for (const phrase of [
      "Substituição ativa",
      "Substituição de endpoint",
      "depois Free",
      "De volta do faturamento",
      "Autoaplicado",
    ]) {
      expect(pt).not.toContain(phrase);
    }
  });
});
