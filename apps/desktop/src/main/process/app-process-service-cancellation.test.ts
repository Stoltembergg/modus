import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  killTree: vi.fn<(...args: [number]) => Promise<void>>(),
  describe: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mocks.spawn };
});

vi.mock("./platform-process-ops", () => ({
  createPlatformProcessOps: () => ({
    isAlive: vi.fn().mockReturnValue(true),
    describe: mocks.describe,
    killTree: mocks.killTree,
  }),
}));

vi.mock("./managed-process-bus", () => ({ publishManagedProcessChange: vi.fn() }));

const { killApp, launchApp } = await import("./app-process-service");

function setExitCode(child: ChildProcess, exitCode: number | null): void {
  Object.defineProperty(child, "exitCode", { configurable: true, value: exitCode, writable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("app-process-service cancellation cleanup", () => {
  it("reports when process termination could not be confirmed after cancellation", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: 42 });
    setExitCode(child, null);
    child.unref = vi.fn();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const terminationError = new Error("synthetic process termination failure");
    mocks.killTree.mockRejectedValueOnce(terminationError);

    const controller = new AbortController();
    const launch = launchApp({
      path: process.execPath,
      cwd: process.cwd(),
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(launch).rejects.toMatchObject({
      name: "AbortError",
      cleanupConfirmed: false,
      cause: terminationError,
    });
    expect(mocks.killTree).toHaveBeenCalledWith(42);
  });

  it("refuses to signal a pid after its tracked process leader has exited", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: 43 });
    setExitCode(child, null);
    child.unref = vi.fn();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    mocks.describe.mockResolvedValue({ pid: 43, name: "fixture" });

    const launch = launchApp({ path: process.execPath, cwd: process.cwd() });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1_000);
    const app = await launch;
    setExitCode(child, 0);

    await expect(killApp(app.id)).rejects.toMatchObject({
      name: "ProcessIdentityUnavailableError",
    });
    expect(mocks.killTree).not.toHaveBeenCalled();
  });

  it("does not signal a reused pid when cancellation follows leader exit", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: 44 });
    setExitCode(child, null);
    child.unref = vi.fn();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    mocks.killTree.mockResolvedValue(undefined);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    const controller = new AbortController();
    const launch = launchApp({
      path: process.execPath,
      cwd: process.cwd(),
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    setExitCode(child, 0);
    controller.abort();

    await expect(launch).rejects.toMatchObject({
      name: "AbortError",
      cleanupConfirmed: false,
      cause: { name: "ProcessIdentityUnavailableError" },
    });
    expect(mocks.killTree).not.toHaveBeenCalled();
  });
});
