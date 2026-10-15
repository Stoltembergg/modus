import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReaSettingsStore } from "./rea-settings";

const directories: string[] = [];
function home() {
  const directory = mkdtempSync(join(tmpdir(), "rea-settings-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("REA user settings", () => {
  it("defaults a missing file and missing enabled field to enabled", () => {
    const directory = home();
    const settings = new ReaSettingsStore(directory);
    expect(settings.get()).toEqual({ enabled: true, settingsError: false });
    mkdirSync(join(directory, ".modus"), { recursive: true });
    writeFileSync(settings.filePath, "{}", "utf8");
    expect(settings.get()).toEqual({ enabled: true, settingsError: false });
  });

  it("persists explicit disable atomically and ignores workspace configuration", () => {
    const directory = home();
    const settings = new ReaSettingsStore(directory);
    settings.setEnabled(false);
    expect(settings.get()).toEqual({ enabled: false, settingsError: false });
    mkdirSync(join(directory, "project", ".modus"), { recursive: true });
    writeFileSync(join(directory, "project", ".modus", "rea.json"), '{"enabled":true}', "utf8");
    expect(settings.get()).toEqual({ enabled: false, settingsError: false });
    expect(settings.filePath).toBe(join(directory, ".modus", "rea.json"));
  });

  it("fails closed with a sanitized error for malformed or invalid settings", () => {
    const directory = home();
    const settings = new ReaSettingsStore(directory);
    settings.setEnabled(false);
    writeFileSync(settings.filePath, '{"enabled":"secret"}', "utf8");
    expect(settings.get()).toEqual({
      enabled: false,
      settingsError: true,
      error: "REA settings could not be read. Check the user-level Modus settings file.",
    });
    writeFileSync(settings.filePath, "{broken", "utf8");
    expect(settings.get().enabled).toBe(false);
    expect(settings.get().error).not.toContain(directory);
  });
});
