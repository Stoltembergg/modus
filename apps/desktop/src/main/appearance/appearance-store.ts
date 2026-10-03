import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AppearancePreferences,
  DEFAULT_APPEARANCE_PREFERENCES,
} from "../../shared/appearance";
import { themePreferenceSchema, transparencyPreferenceSchema } from "./appearance-schemas";

export const APPEARANCE_FILE_NAME = "appearance.json";

/** Values written by earlier builds of this file, mapped to their current meaning. */
const LEGACY_TRANSPARENCY: Record<string, AppearancePreferences["transparency"]> = {
  auto: "sidebar",
};

export type AppearanceStore = {
  read(): AppearancePreferences;
  write(preferences: AppearancePreferences): void;
};

/**
 * Validate each field on its own so one stale or invalid field never resets
 * the other: a legacy `auto` becomes `sidebar`, anything invalid falls back to
 * that field's default only.
 */
export function migrateAppearancePreferences(raw: unknown): AppearancePreferences {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const theme = themePreferenceSchema.safeParse(record.theme);
  const legacy =
    typeof record.transparency === "string" ? LEGACY_TRANSPARENCY[record.transparency] : undefined;
  const transparency = transparencyPreferenceSchema.safeParse(legacy ?? record.transparency);
  return {
    theme: theme.success ? theme.data : DEFAULT_APPEARANCE_PREFERENCES.theme,
    transparency: transparency.success
      ? transparency.data
      : DEFAULT_APPEARANCE_PREFERENCES.transparency,
  };
}

/**
 * Appearance preferences as a small JSON file in Electron `userData`. Read
 * synchronously before the window exists so the first frame already has the
 * right material and colours. A file that needed migration is rewritten.
 */
export function createAppearanceStore(userDataDir: string): AppearanceStore {
  const filePath = join(userDataDir, APPEARANCE_FILE_NAME);
  const write = (preferences: AppearancePreferences): void => {
    const tmpPath = `${filePath}.tmp`;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(tmpPath, `${JSON.stringify(preferences)}\n`, "utf8");
      renameSync(tmpPath, filePath);
    } catch (error) {
      console.warn("[modus] Unable to persist appearance preferences.", error);
    }
  };
  return {
    read() {
      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch {
        return { ...DEFAULT_APPEARANCE_PREFERENCES };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = undefined;
      }
      const preferences = migrateAppearancePreferences(raw);
      if (`${JSON.stringify(preferences)}\n` !== text) write(preferences);
      return preferences;
    },
    write,
  };
}
