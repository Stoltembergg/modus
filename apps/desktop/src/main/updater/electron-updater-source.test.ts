import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  configureElectronUpdater,
  createElectronUpdaterInstaller,
  createElectronUpdaterSource,
  type ElectronUpdaterLike,
  toReleaseFiles,
} from "./electron-updater-source";
import { RELEASES_URL } from "./update-policy";

type CheckResult = Awaited<ReturnType<ElectronUpdaterLike["checkForUpdates"]>>;

/** Fake of the electron-updater AppUpdater surface, including its channel side effect. */
class FakeUpdater extends EventEmitter {
  private _channel: string | null = null;
  allowDowngrade = false;
  allowPrerelease = true;
  autoDownload = true;
  autoInstallOnAppQuit = true;
  disableWebInstaller = false;
  logger: ElectronUpdaterLike["logger"] = console;
  checkForUpdates = vi.fn(async (): Promise<CheckResult> => null);
  downloadUpdate = vi.fn(async () => {
    this.emit("download-progress", { percent: 12.5 });
    this.emit("download-progress", { percent: 100 });
    return [];
  });
  quitAndInstall = vi.fn();

  get channel() {
    return this._channel;
  }
  set channel(value: string | null) {
    // Mirrors AppUpdater: setting a channel enables downgrades.
    this._channel = value;
    this.allowDowngrade = true;
  }
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
const asLike = (fake: FakeUpdater) => fake as unknown as ElectronUpdaterLike;

describe("configureElectronUpdater", () => {
  it("pins the stable channel without downgrades or automatic downloads", () => {
    const fake = new FakeUpdater();
    configureElectronUpdater(asLike(fake), { platform: "win32", installInPlace: true, logger });
    expect(fake.channel).toBe("latest");
    expect(fake.allowDowngrade).toBe(false);
    expect(fake.allowPrerelease).toBe(false);
    expect(fake.autoDownload).toBe(false);
    expect(fake.disableWebInstaller).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);
    expect(fake.logger).not.toBe(console);
  });

  it("never auto-installs on macOS or page-only installs", () => {
    const mac = new FakeUpdater();
    configureElectronUpdater(asLike(mac), { platform: "darwin", installInPlace: true, logger });
    expect(mac.autoInstallOnAppQuit).toBe(false);
    const deb = new FakeUpdater();
    configureElectronUpdater(asLike(deb), { platform: "linux", installInPlace: false, logger });
    expect(deb.autoInstallOnAppQuit).toBe(false);
  });

  it("handles error events so a failed check cannot throw from the emitter", () => {
    const fake = new FakeUpdater();
    configureElectronUpdater(asLike(fake), { platform: "linux", installInPlace: true, logger });
    expect(() => fake.emit("error", new Error("No published versions on GitHub"))).not.toThrow();
  });
});

describe("createElectronUpdaterSource", () => {
  const info = (version: string) => ({
    version,
    files: [
      { url: `Modus-${version}-win-x64-setup.exe`, sha512: "abc", size: 10 },
      { url: "https://evil.example/Modus.exe", sha512: "abc", size: 10 },
    ],
  });

  it("returns newer stable releases with files resolved to the official release", async () => {
    const fake = new FakeUpdater();
    fake.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: info("1.1.0") });
    const result = await createElectronUpdaterSource(asLike(fake), "1.0.0").check();
    expect(result).toEqual({
      version: "1.1.0",
      files: [
        {
          url: `${RELEASES_URL}/download/v1.1.0/Modus-1.1.0-win-x64-setup.exe`,
          sha512: "abc",
          size: 10,
        },
      ],
    });
  });

  it("returns null for no update, older, same or pre-release versions", async () => {
    const fake = new FakeUpdater();
    const source = createElectronUpdaterSource(asLike(fake), "1.0.0");
    expect(await source.check()).toBeNull();
    fake.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: info("1.0.0") });
    expect(await source.check()).toBeNull();
    for (const version of ["0.9.0", "1.0.0", "1.1.0-beta.1"]) {
      fake.checkForUpdates.mockResolvedValue({
        isUpdateAvailable: true,
        updateInfo: info(version),
      });
      expect(await source.check()).toBeNull();
    }
  });

  it("propagates check errors to the controller", async () => {
    const fake = new FakeUpdater();
    fake.checkForUpdates.mockRejectedValue(new Error("No published versions on GitHub"));
    await expect(createElectronUpdaterSource(asLike(fake), "1.0.0").check()).rejects.toThrow(
      "No published versions",
    );
  });

  it("drops files outside the official release", () => {
    expect(
      toReleaseFiles("1.1.0", [
        { url: "../x.exe", sha512: "a" },
        { url: "https://github.com/other/modus/releases/download/v1.1.0/x.exe", sha512: "a" },
        {
          url: `${RELEASES_URL}/download/v1.0.0/x.exe`,
          sha512: "a",
        },
      ]),
    ).toEqual([]);
  });
});

describe("createElectronUpdaterInstaller", () => {
  const candidate = {
    version: "1.1.0",
    files: [
      {
        url: `${RELEASES_URL}/download/v1.1.0/Modus.AppImage`,
        sha512: "abc",
        size: 10,
      },
    ],
  };

  it("reports download progress and installs silently with relaunch", async () => {
    const fake = new FakeUpdater();
    const installer = createElectronUpdaterInstaller(asLike(fake));
    const progress: number[] = [];
    await installer.download(candidate, (percent) => progress.push(percent));
    expect(progress).toEqual([12.5, 100]);
    expect(fake.listenerCount("download-progress")).toBe(0);
    await installer.install(candidate);
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("refuses to download without an official asset", async () => {
    const fake = new FakeUpdater();
    const installer = createElectronUpdaterInstaller(asLike(fake));
    await expect(installer.download({ version: "1.1.0", files: [] }, () => {})).rejects.toThrow(
      "No official release asset",
    );
    expect(fake.downloadUpdate).not.toHaveBeenCalled();
  });
});
