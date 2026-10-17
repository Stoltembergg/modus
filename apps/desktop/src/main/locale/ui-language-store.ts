import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_UI_LANGUAGE_PREFERENCE,
  isUiLanguagePreference,
  type UiLanguagePreference,
} from "../../shared/ui-language";

export const UI_LANGUAGE_FILE_NAME = "ui-language.json";

export type UiLanguageStore = {
  read(): UiLanguagePreference;
  write(preference: UiLanguagePreference): void;
};

/**
 * The language preference as a small JSON file in Electron `userData`, next to
 * appearance.json. Read synchronously before the window exists, so the first
 * frame and the native menu are already in the chosen language. A missing,
 * unreadable or unknown value reads as the default, English (C6.2).
 */
export function createUiLanguageStore(userDataDir: string): UiLanguageStore {
  const filePath = join(userDataDir, UI_LANGUAGE_FILE_NAME);
  return {
    read() {
      try {
        const raw = JSON.parse(readFileSync(filePath, "utf8")) as { language?: unknown };
        return isUiLanguagePreference(raw?.language)
          ? raw.language
          : DEFAULT_UI_LANGUAGE_PREFERENCE;
      } catch {
        return DEFAULT_UI_LANGUAGE_PREFERENCE;
      }
    },
    write(preference) {
      const tmpPath = `${filePath}.tmp`;
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(tmpPath, `${JSON.stringify({ language: preference })}\n`, "utf8");
        renameSync(tmpPath, filePath);
      } catch (error) {
        console.warn("[modus] Unable to persist the language preference.", error);
      }
    },
  };
}
