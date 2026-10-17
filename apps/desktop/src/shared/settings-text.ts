/**
 * Settings screens and the question / clarification card copy, in en and pt.
 * Same pattern as `shell-text.ts`: each area fragment under `settings-text/`
 * has an en table that defines its keys and a pt table typed against it, and
 * the parity test checks them. The locale resolves like the other catalogs
 * (`resolveGroupRoomLocale`): no locale means English (C6.2). zh has no
 * Settings copy yet and falls back to English.
 */
import { type GroupRoomLocale, resolveGroupRoomLocale } from "./group-room-locale";
import { ACCOUNT_TEXT_EN, ACCOUNT_TEXT_PT } from "./settings-text/account";
import { APPEARANCE_TEXT_EN, APPEARANCE_TEXT_PT } from "./settings-text/appearance";
import { CUSTOM_PROVIDER_TEXT_EN, CUSTOM_PROVIDER_TEXT_PT } from "./settings-text/custom-provider";
import { GENERAL_TEXT_EN, GENERAL_TEXT_PT } from "./settings-text/general";
import { INTEGRATIONS_TEXT_EN, INTEGRATIONS_TEXT_PT } from "./settings-text/integrations";
import { MCP_TEXT_EN, MCP_TEXT_PT } from "./settings-text/mcp";
import { PROVIDER_UI_TEXT_EN, PROVIDER_UI_TEXT_PT } from "./settings-text/provider-ui";
import { PROVIDERS_TEXT_EN, PROVIDERS_TEXT_PT } from "./settings-text/providers";
import { QUESTION_TEXT_EN, QUESTION_TEXT_PT } from "./settings-text/question";
import { SKILLS_RULES_TEXT_EN, SKILLS_RULES_TEXT_PT } from "./settings-text/skills-rules";
import { WINDOW_TEXT_EN, WINDOW_TEXT_PT } from "./settings-text/window";

export const SETTINGS_TEXT_EN = {
  ...WINDOW_TEXT_EN,
  ...GENERAL_TEXT_EN,
  ...ACCOUNT_TEXT_EN,
  ...PROVIDERS_TEXT_EN,
  ...CUSTOM_PROVIDER_TEXT_EN,
  ...PROVIDER_UI_TEXT_EN,
  ...APPEARANCE_TEXT_EN,
  ...MCP_TEXT_EN,
  ...INTEGRATIONS_TEXT_EN,
  ...SKILLS_RULES_TEXT_EN,
  ...QUESTION_TEXT_EN,
} as const;

export type SettingsTextKey = keyof typeof SETTINGS_TEXT_EN;

export const SETTINGS_TEXT_PT: Record<SettingsTextKey, string> = {
  ...WINDOW_TEXT_PT,
  ...GENERAL_TEXT_PT,
  ...ACCOUNT_TEXT_PT,
  ...PROVIDERS_TEXT_PT,
  ...CUSTOM_PROVIDER_TEXT_PT,
  ...PROVIDER_UI_TEXT_PT,
  ...APPEARANCE_TEXT_PT,
  ...MCP_TEXT_PT,
  ...INTEGRATIONS_TEXT_PT,
  ...SKILLS_RULES_TEXT_PT,
  ...QUESTION_TEXT_PT,
};

const SETTINGS_TEXT: Record<GroupRoomLocale, Record<SettingsTextKey, string>> = {
  en: SETTINGS_TEXT_EN,
  pt: SETTINGS_TEXT_PT,
  zh: SETTINGS_TEXT_EN,
};

export type SettingsTextVars = Readonly<Record<string, string | number>>;

/** Keys that come as a `_one` / `_other` pair. */
export type SettingsPluralTextBase = {
  [K in SettingsTextKey]: K extends `${infer B}_one` ? B : never;
}[SettingsTextKey];

function fillSettingsText(template: string, vars?: SettingsTextVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function settingsText(
  key: SettingsTextKey,
  locale?: string | null,
  vars?: SettingsTextVars,
): string {
  return fillSettingsText(SETTINGS_TEXT[resolveGroupRoomLocale(locale)][key], vars);
}

/** Plural copy: `{base}_one` when count is 1, else `{base}_other`; `{count}` is filled. */
export function settingsPluralText(
  base: SettingsPluralTextBase,
  count: number,
  locale?: string | null,
  vars?: SettingsTextVars,
): string {
  const key = `${base}_${count === 1 ? "one" : "other"}` as SettingsTextKey;
  return settingsText(key, locale, { count, ...vars });
}
