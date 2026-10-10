import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: mocks.execFile };
});

import {
  createPlatformProcessOps,
  parseUnixProcess,
  parseWindowsProcess,
  pidAlive,
} from "./platform-process-ops";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseWindowsProcess", () => {
  it("reads process name and window title from two lines", () => {
    expect(parseWindowsProcess("solers\r\nSolers Engine — 项目管理器\r\n", 22600)).toEqual({
      pid: 22600,
      name: "solers",
      windowTitle: "Solers Engine — 项目管理器",
    });
  });

  it("omits the window title when the process has none", () => {
    expect(parseWindowsProcess("node\r\n\r\n", 100)).toEqual({ pid: 100, name: "node" });
  });

  it("falls back to the pid when output is empty", () => {
    expect(parseWindowsProcess("", 100)).toEqual({ pid: 100, name: "pid 100" });
  });
});

describe("parseUnixProcess", () => {
  it("reduces a full command path to its basename", () => {
    expect(parseUnixProcess("/Applications/Solers.app/Contents/MacOS/solers\n", 42)).toEqual({
      pid: 42,
      name: "solers",
    });
  });

  it("keeps a bare name", () => {
    expect(parseUnixProcess("node\n", 42)).toEqual({ pid: 42, name: "node" });
  });

  it("falls back to the pid when output is empty", () => {
    expect(parseUnixProcess("   \n", 42)).toEqual({ pid: 42, name: "pid 42" });
  });
});

describe("pidAlive", () => {
  it("reports the current process as alive", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("reports an unused pid as not alive", () => {
    // A pid far above any plausible live process on a test machine.
    expect(pidAlive(2_000_000_000)).toBe(false);
  });
});

describe("Windows process-tree termination", () => {
  it("does not confirm tree cleanup when the leader is already absent", async () => {
    const pid = 12_349;
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === pid && signal === 0) {
        throw Object.assign(new Error("leader has exited"), { code: "ESRCH" });
      }
      throw new Error(`unexpected process signal ${String(signal)} for ${target}`);
    });

    await expect(createPlatformProcessOps("win32").killTree(pid)).rejects.toMatchObject({
      name: "ProcessTreeTerminationError",
      message: expect.stringContaining("could not be confirmed"),
    });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("bounds taskkill and reports when the leader remains alive", async () => {
    const pid = 12_347;
    const taskkillTimeout = Object.assign(new Error("taskkill timed out"), {
      killed: true,
    });
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === pid && signal === 0) return true;
      throw new Error(`unexpected process signal ${String(signal)} for ${target}`);
    });
    mocks.execFile.mockImplementation((_command, _args, options, callback) => {
      expect(options).toMatchObject({ timeout: 2_000, windowsHide: true });
      callback(taskkillTimeout);
    });

    await expect(createPlatformProcessOps("win32").killTree(pid)).rejects.toBe(taskkillTimeout);
    expect(mocks.execFile).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      expect.objectContaining({ timeout: 2_000 }),
      expect.any(Function),
    );
  });

  it("does not treat taskkill timeout as confirmed when the leader exits", async () => {
    const pid = 12_348;
    const taskkillTimeout = Object.assign(new Error("taskkill timed out"), {
      killed: true,
    });
    let leaderAlive = true;
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === pid && signal === 0) {
        if (leaderAlive) return true;
        throw Object.assign(new Error("leader has exited"), { code: "ESRCH" });
      }
      throw new Error(`unexpected process signal ${String(signal)} for ${target}`);
    });
    mocks.execFile.mockImplementation((_command, _args, options, callback) => {
      expect(options).toMatchObject({ timeout: 2_000, windowsHide: true });
      leaderAlive = false;
      callback(taskkillTimeout);
    });

    await expect(createPlatformProcessOps("win32").killTree(pid)).rejects.toBe(taskkillTimeout);
  });
});

describe("Unix process-tree termination confirmation", () => {
  it("does not resolve until the process group disappears after SIGKILL", async () => {
    vi.useFakeTimers();
    const pid = 12_345;
    let groupAlive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (signal === 0) {
        if (groupAlive && (target === pid || target === -pid)) return true;
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      if (target === -pid && signal === "SIGTERM") return true;
      if (target === -pid && signal === "SIGKILL") {
        setTimeout(() => {
          groupAlive = false;
        }, 100);
        return true;
      }
      throw new Error(`unexpected process signal ${String(signal)} for ${target}`);
    });

    const { createPlatformProcessOps } = await import("./platform-process-ops");
    const termination = createPlatformProcessOps("linux").killTree(pid);
    let settled = false;
    void termination.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");

    await vi.advanceTimersByTimeAsync(100);
    await expect(termination).resolves.toBeUndefined();
    expect(groupAlive).toBe(false);
  });

  it("rejects when process-tree termination cannot be confirmed", async () => {
    vi.useFakeTimers();
    const pid = 12_346;
    const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (signal === 0) return true;
      if (target === -pid && (signal === "SIGTERM" || signal === "SIGKILL")) return true;
      throw new Error(`unexpected process signal ${String(signal)} for ${target}`);
    });

    const { createPlatformProcessOps } = await import("./platform-process-ops");
    const termination = createPlatformProcessOps("linux").killTree(pid);
    const completion = termination.then(
      () => new Error("termination unexpectedly resolved"),
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2_300);
    await expect(completion).resolves.toMatchObject({
      message: expect.stringMatching(/termination.*confirmed/i),
    });
    expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
  });
});
