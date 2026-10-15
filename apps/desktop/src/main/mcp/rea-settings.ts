import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ReaSettings = {
  enabled: boolean;
  settingsError: boolean;
  error?: string;
};

const SETTINGS_ERROR = "REA settings could not be read. Check the user-level Modus settings file.";

export class ReaSettingsStore {
  readonly filePath: string;

  constructor(homeDirectory = homedir()) {
    this.filePath = join(homeDirectory, ".modus", "rea.json");
  }

  get(): ReaSettings {
    let content: string;
    try {
      content = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { enabled: true, settingsError: false };
      }
      return { enabled: false, settingsError: true, error: SETTINGS_ERROR };
    }
    try {
      const value: unknown = JSON.parse(content);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
      const enabled = (value as { enabled?: unknown }).enabled;
      if (enabled === undefined) return { enabled: true, settingsError: false };
      if (typeof enabled !== "boolean") throw new Error();
      return { enabled, settingsError: false };
    } catch {
      return { enabled: false, settingsError: true, error: SETTINGS_ERROR };
    }
  }

  setEnabled(enabled: boolean): ReaSettings {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify({ enabled }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporaryPath, this.filePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    return { enabled, settingsError: false };
  }
}

const userSettings = new ReaSettingsStore();

export function getReaSettings(): ReaSettings {
  return userSettings.get();
}

export function setReaEnabled(enabled: boolean): ReaSettings {
  return userSettings.setEnabled(enabled);
}
