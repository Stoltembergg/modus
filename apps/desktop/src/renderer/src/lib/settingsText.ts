import { useMemo } from "react";
import {
  type SettingsPluralTextBase,
  type SettingsTextKey,
  type SettingsTextVars,
  settingsPluralText,
  settingsText,
} from "../../../shared/settings-text";
import { useUiLocale } from "./uiLocale";

export type SettingsTextFn = {
  (key: SettingsTextKey, vars?: SettingsTextVars): string;
  plural: (base: SettingsPluralTextBase, count: number, vars?: SettingsTextVars) => string;
  locale: string | undefined;
};

/** Same as `useSettingsText`, outside React (plain helpers take a `t` or a `locale`). */
export function settingsTextFor(locale?: string | null): SettingsTextFn {
  const resolved = locale ?? undefined;
  const t = ((key: SettingsTextKey, vars?: SettingsTextVars) =>
    settingsText(key, resolved, vars)) as SettingsTextFn;
  t.plural = (base, count, vars) => settingsPluralText(base, count, resolved, vars);
  t.locale = resolved;
  return t;
}

/** Settings / question card copy bound to `override` or the UI locale (`<html lang>`). */
export function useSettingsText(override?: string | null): SettingsTextFn {
  const uiLocale = useUiLocale();
  const locale = override ?? uiLocale;
  return useMemo(() => settingsTextFor(locale), [locale]);
}
