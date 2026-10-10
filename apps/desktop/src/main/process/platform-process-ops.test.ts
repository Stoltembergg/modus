import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUnixProcess, parseWindowsProcess, pidAlive } from "./platform-process-ops";

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
