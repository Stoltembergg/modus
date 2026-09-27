import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../../shared/contracts";
import {
  createUpdateController,
  type PlatformInstaller,
  type UpdateCandidate,
  type UpdateSource,
} from "./update-controller";
import { UPDATE_CHECK_INTERVAL_MS, UPDATE_INITIAL_DELAY_MS } from "./update-scheduler";

/** Deb-style installer: updates are only offered as the release page. */
const pageOnlyInstaller: PlatformInstaller = {
  actionFor: async () => "download-page",
  download: async () => {
    throw new Error("page only");
  },
  install: async () => {
    throw new Error("page only");
  },
};

const ASSET = "https://github.com/stoltembergg-png/modus/releases/download";

function candidate(version: string): UpdateCandidate {
  return {
    version,
    files: [
      { url: `${ASSET}/v${version}/Modus-${version}-win-x64-setup.exe`, sha512: "x", size: 1 },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function codeError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function setup(options: { installer?: PlatformInstaller; check?: UpdateSource["check"] } = {}) {
  const source = { check: vi.fn(options.check ?? (async () => null as UpdateCandidate | null)) };
  const installer = options.installer
    ? {
        actionFor: vi.fn(options.installer.actionFor),
        download: vi.fn(options.installer.download),
        install: vi.fn(options.installer.install),
      }
    : {
        actionFor: vi.fn(async () => "install" as const),
        download: vi.fn(async (_c: UpdateCandidate, onProgress: (percent: number) => void) => {
          onProgress(40);
          onProgress(100);
        }),
        install: vi.fn(async () => undefined),
      };
  const agents = { hasActiveTurns: vi.fn(() => false) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const openExternal = vi.fn(async (_url: string) => undefined);
  const beforeInstallRestart = vi.fn(async () => undefined);
  const controller = createUpdateController({
    currentVersion: "1.0.0",
    source,
    installer,
    agents,
    logger,
    openExternal,
    beforeInstallRestart,
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    now: () => Date.now(),
  });
  const states: UpdateState[] = [];
  controller.subscribe((state) => states.push(state));
  return {
    controller,
    source,
    installer,
    agents,
    logger,
    openExternal,
    beforeInstallRestart,
    states,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("update scheduling", () => {
  it("checks once after the startup delay and then every 5 minutes", async () => {
    const { controller, source } = setup();
    controller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS - 1);
    expect(source.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(source.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(source.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(source.check).toHaveBeenCalledTimes(5);
    controller.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(source.check).toHaveBeenCalledTimes(5);
  });

  it("never runs overlapping checks", async () => {
    const pending = deferred<UpdateCandidate | null>();
    const { controller, source } = setup({ check: () => pending.promise });
    controller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS);
    void controller.checkNow();
    void controller.checkNow();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 4);
    expect(source.check).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toEqual({ status: "checking" });
    pending.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState()).toEqual({ status: "idle" });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(source.check).toHaveBeenCalledTimes(2);
  });

  it("does not check while downloading or once the update is ready", async () => {
    const download = deferred<void>();
    const { controller, source, installer, agents } = setup({
      check: async () => candidate("1.1.0"),
    });
    installer.download.mockImplementation(() => download.promise);
    controller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS);
    expect(controller.getState()).toMatchObject({ status: "available", version: "1.1.0" });
    void controller.install();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState()).toMatchObject({ status: "downloading" });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(source.check).toHaveBeenCalledTimes(1);

    agents.hasActiveTurns.mockReturnValue(true);
    download.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState()).toEqual({ status: "waiting-for-agents", version: "1.1.0" });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(source.check).toHaveBeenCalledTimes(1);
  });

  it("ignores releases that are not newer than the running version", async () => {
    const { controller, states } = setup({ check: async () => candidate("0.9.0") });
    await controller.checkNow();
    expect(controller.getState()).toEqual({ status: "idle" });
    expect(states.some((state) => state.status === "available")).toBe(false);
  });
});

describe("background check failures", () => {
  it("stay silent before the first release exists", async () => {
    const errors = [
      codeError("No published versions on GitHub", "ERR_UPDATER_NO_PUBLISHED_VERSIONS"),
      new Error("No releases in the GitHub Atom feed"),
      codeError(
        "Cannot find latest.yml in the latest release artifacts",
        "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
      ),
      codeError("HttpError: 404 Not Found", "HTTP_ERROR_404"),
      codeError("net::ERR_INTERNET_DISCONNECTED", "ERR_INTERNET_DISCONNECTED"),
    ];
    let call = 0;
    const { controller, source, logger, states } = setup({
      check: async () => {
        throw errors[call++ % errors.length];
      },
    });
    controller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS + UPDATE_CHECK_INTERVAL_MS * 11);
    expect(source.check).toHaveBeenCalledTimes(12);
    expect(controller.getState()).toEqual({ status: "idle" });
    expect(states.every((state) => state.status === "idle" || state.status === "checking")).toBe(
      true,
    );
    expect(logger.warn).not.toHaveBeenCalled();
    // Rate-limited: one info line per hour, the rest at debug.
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]?.[0]).toContain("ERR_UPDATER_NO_PUBLISHED_VERSIONS");
    expect(logger.debug).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info.mock.calls[1]?.[0]).toContain("11 similar since last log");
  });

  it("keeps an offered update visible when a later background check fails", async () => {
    let fail = false;
    const { controller } = setup({
      check: async () => {
        if (fail) throw new Error("offline");
        return candidate("1.1.0");
      },
    });
    await controller.checkNow();
    fail = true;
    await controller.checkNow();
    expect(controller.getState()).toEqual({
      status: "available",
      version: "1.1.0",
      action: "install",
    });
  });
});

describe("install flow", () => {
  it("downloads with progress, becomes ready and restarts through the hook", async () => {
    const { controller, installer, beforeInstallRestart, states } = setup({
      check: async () => candidate("1.1.0"),
    });
    await controller.checkNow();
    expect(installer.download).not.toHaveBeenCalled(); // autoDownload is off
    await controller.install();
    expect(states.map((state) => state.status)).toEqual([
      "checking",
      "available",
      "downloading",
      "downloading",
      "downloading",
      "ready",
      "installing",
    ]);
    expect(states.filter((state) => state.status === "downloading").map((s) => s.percent)).toEqual([
      0, 40, 100,
    ]);
    expect(installer.install).toHaveBeenCalledWith(candidate("1.1.0"));
    expect(beforeInstallRestart.mock.invocationCallOrder[0]).toBeLessThan(
      installer.install.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("defers the restart while agents run and restarts once they finish", async () => {
    const { controller, installer, agents, beforeInstallRestart } = setup({
      check: async () => candidate("1.1.0"),
    });
    agents.hasActiveTurns.mockReturnValue(true);
    await controller.checkNow();
    void controller.install();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState()).toEqual({ status: "waiting-for-agents", version: "1.1.0" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(installer.install).not.toHaveBeenCalled();
    expect(beforeInstallRestart).not.toHaveBeenCalled();
    agents.hasActiveTurns.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.getState()).toEqual({ status: "installing", version: "1.1.0" });
    expect(beforeInstallRestart).toHaveBeenCalledTimes(1);
    expect(installer.install).toHaveBeenCalledTimes(1);
  });

  it("shows a retryable failure when the download fails, and retry downloads again", async () => {
    const { controller, installer } = setup({ check: async () => candidate("1.1.0") });
    installer.download.mockRejectedValueOnce(new Error("socket hang up"));
    await controller.checkNow();
    await controller.install();
    expect(controller.getState()).toEqual({
      status: "failed",
      version: "1.1.0",
      retryable: true,
      action: "install",
    });
    expect(installer.install).not.toHaveBeenCalled();
    await controller.retry();
    expect(installer.download).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toEqual({ status: "installing", version: "1.1.0" });
  });

  it("offers the release page when the install hits a permission error", async () => {
    const { controller, installer, openExternal } = setup({
      check: async () => candidate("1.1.0"),
    });
    installer.install.mockRejectedValueOnce(codeError("EACCES: permission denied", "EACCES"));
    await controller.checkNow();
    await controller.install();
    expect(controller.getState()).toEqual({
      status: "failed",
      version: "1.1.0",
      retryable: true,
      action: "download-page",
    });
    await controller.retry();
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/stoltembergg-png/modus/releases/tag/v1.1.0",
    );
    expect(installer.download).toHaveBeenCalledTimes(1);
  });

  it("reports a failure if the app is still running long after install", async () => {
    const { controller } = setup({ check: async () => candidate("1.1.0") });
    await controller.checkNow();
    await controller.install();
    expect(controller.getState().status).toBe("installing");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.getState()).toMatchObject({ status: "failed", retryable: true });
  });

  it("opens the release page instead of installing on deb installs", async () => {
    const { controller, installer, openExternal } = setup({
      installer: pageOnlyInstaller,
      check: async () => candidate("1.1.0"),
    });
    await controller.checkNow();
    expect(controller.getState()).toEqual({
      status: "available",
      version: "1.1.0",
      action: "download-page",
    });
    await controller.install();
    expect(installer.download).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/stoltembergg-png/modus/releases/tag/v1.1.0",
    );
    await controller.openReleasePage();
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
});

describe("dismiss", () => {
  it("hides a version until a newer one appears", async () => {
    let latest = "1.1.0";
    const { controller } = setup({ check: async () => candidate(latest) });
    await controller.checkNow();
    controller.dismiss();
    expect(controller.getState()).toEqual({ status: "idle" });
    await controller.checkNow();
    expect(controller.getState()).toEqual({ status: "idle" });
    latest = "1.2.0";
    await controller.checkNow();
    expect(controller.getState()).toEqual({
      status: "available",
      version: "1.2.0",
      action: "install",
    });
  });

  it("cannot dismiss an update that is already installing", async () => {
    const { controller, agents } = setup({ check: async () => candidate("1.1.0") });
    agents.hasActiveTurns.mockReturnValue(true);
    await controller.checkNow();
    void controller.install();
    await vi.advanceTimersByTimeAsync(0);
    controller.dismiss();
    expect(controller.getState()).toEqual({ status: "waiting-for-agents", version: "1.1.0" });
    controller.stop();
  });
});
