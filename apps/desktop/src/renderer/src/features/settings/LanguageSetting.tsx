import { useState } from "react";
import {
  UI_LANGUAGES,
  type UiLanguagePreference,
  uiLanguageOption,
} from "../../../../shared/ui-language";
import { useSettingsText } from "../../lib/settingsText";
import { setUiLanguagePreference, useUiLanguageState } from "../../lib/uiLanguage";
import { SelectField } from "./form-controls";
import { SettingsList, SettingsRow } from "./settings-layout";

/**
 * Settings > General > Language. English is the default (C6.2); "System"
 * follows the OS language;
 * each language is listed by its own name ("Português (Brasil)", "English"),
 * never translated into the current UI language. The change is live: main
 * persists it, rebuilds the native menu and pushes the new `<html lang>`.
 */
export function LanguageSetting() {
  const t = useSettingsText();
  const state = useUiLanguageState();
  const [error, setError] = useState<string | undefined>();
  const title = t("settings.general.languageTitle");
  const resolved = state ? uiLanguageOption(state.language).nativeName : undefined;

  const options: { label: string; value: UiLanguagePreference; lang?: string }[] = [
    {
      label:
        state?.preference === "system" && resolved
          ? t("settings.general.languageSystemResolved", { language: resolved })
          : t("settings.general.languageSystem"),
      value: "system",
    },
    ...UI_LANGUAGES.map((language) => ({
      label: language.nativeName,
      value: language.id,
      lang: language.id,
    })),
  ];

  async function choose(next: UiLanguagePreference): Promise<void> {
    setError(undefined);
    try {
      await setUiLanguagePreference(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <SettingsList>
      <SettingsRow
        control={
          <div className="w-56">
            <SelectField
              disabled={!state}
              label={title}
              labelHidden
              onChange={(next) => void choose(next)}
              options={options}
              value={state?.preference ?? "system"}
            />
          </div>
        }
        notice={error}
        noticeTone="danger"
        title={title}
      />
    </SettingsList>
  );
}
