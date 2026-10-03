import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AppearancePreferences,
  DEFAULT_APPEARANCE_PREFERENCES,
} from "../../shared/appearance";
import { appearancePreferencesSchema } from "./appearance-schemas";

export const APPEARANCE_FILE_NAME = "appearance.json";

export type AppearanceStore = {
  read(): AppearancePreferences;
  write(preferences: AppearancePreferences): void;
};

/**
 * Appearance preferences as a small JSON file in Electron `userData`. Read
 * synchronously before the window exists so the first frame already has the
 * right material and colours; a missing or invalid file yields the defaults.
 */
export function createAppearanceStore(userDataDir: string): AppearanceStore {
  const filePath = join(userDataDir, APPEARANCE_FILE_NAME);
  return {
    read() {
      try {
        const parsed = appearancePreferencesSchema.safeParse(
          JSON.parse(readFileSync(filePath, "utf8")),
        );
        return parsed.success ? parsed.data : { ...DEFAULT_APPEARANCE_PREFERENCES };
      } catch {
        return { ...DEFAULT_APPEARANCE_PREFERENCES };
      }
    },
    write(preferences) {
      const tmpPath = `${filePath}.tmp`;
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(tmpPath, `${JSON.stringify(preferences)}\n`, "utf8");
        renameSync(tmpPath, filePath);
      } catch (error) {
        console.warn("[modus] Unable to persist appearance preferences.", error);
      }
    },
  };
}
