import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  killTree: vi.fn<() => Promise<void>>(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mocks.spawn };
});

vi.mock("../process/platform-process-ops", () => ({
  createPlatformProcessOps: () => ({ killTree: mocks.killTree }),
}));

import { spawn } from "node:child_process";
import { runCodeGraphCli } from "./fast-codebase-service";

const CHILD_PID = 73_101;

type FakeChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = CHILD_PID;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    child.emit("close", 0);
    return true;
  });
  child.unref = vi.fn();
  return child;
}

describe("Fast Codebase CLI process lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.spawn.mockReturnValue(createFakeChild() as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("waits for bounded process-tree cancellation before rejecting", async () => {
    const controller = new AbortController();
    let confirmTermination!: () => void;
    mocks.killTree.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          confirmTermination = resolve;
        }),
    );

    const result = runCodeGraphCli(["query", "fixture"], {
      cwd: "/synthetic/workspace",
      signal: controller.signal,
    });
    const completion = result.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      controller.abort();
      await Promise.resolve();

      expect(mocks.killTree).toHaveBeenCalledWith(CHILD_PID);
      expect(settled).toBe(false);
    } finally {
      confirmTermination?.();
    }

    expect((await completion).error).toMatchObject({ name: "AbortError" });
  });

  it("waits for bounded process-tree termination before reporting timeout", async () => {
    let confirmTermination!: () => void;
    mocks.killTree.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          confirmTermination = resolve;
        }),
    );

    const result = runCodeGraphCli(["query", "fixture"], {
      cwd: "/synthetic/workspace",
      timeoutMs: 50,
    });
    const completion = result.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(50);

      expect(mocks.killTree).toHaveBeenCalledWith(CHILD_PID);
      expect(settled).toBe(false);
    } finally {
      confirmTermination?.();
    }

    expect((await completion).error).toMatchObject({
      message: expect.stringContaining("Fast Codebase timed out after 0s."),
    });
  });

  it("reports unconfirmed cleanup rather than hiding a process-tree termination failure", async () => {
    const cleanupError = new Error("synthetic termination was not confirmed");
    mocks.killTree.mockRejectedValue(cleanupError);

    const result = runCodeGraphCli(["query", "fixture"], {
      cwd: "/synthetic/workspace",
      timeoutMs: 50,
    });
    const completion = result.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    await vi.advanceTimersByTimeAsync(50);

    expect((await completion).error).toMatchObject({
      name: "ProcessTreeTerminationError",
      cause: cleanupError,
    });
  });

  it("does not let a child error hide an unconfirmed cancellation cleanup", async () => {
    const cleanupError = new Error("synthetic termination was not confirmed");
    let failTermination!: (error: Error) => void;
    mocks.killTree.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          failTermination = reject;
        }),
    );
    const child = createFakeChild();
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess);
    const controller = new AbortController();
    const result = runCodeGraphCli(["query", "fixture"], {
      cwd: "/synthetic/workspace",
      signal: controller.signal,
    });
    const completion = result.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    let settled = false;
    void completion.then(() => {
      settled = true;
    });

    try {
      controller.abort();
      await Promise.resolve();
      child.emit("error", new Error("synthetic child error"));
      await Promise.resolve();

      expect(settled).toBe(false);
    } finally {
      failTermination(cleanupError);
    }

    expect((await completion).error).toMatchObject({
      name: "ProcessTreeTerminationError",
      cause: cleanupError,
    });
  });

  it("starts the Unix child in a dedicated process group for tree termination", async () => {
    const child = createFakeChild();
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess);
    const controller = new AbortController();
    const result = runCodeGraphCli(["query", "fixture"], {
      cwd: "/synthetic/workspace",
      signal: controller.signal,
    });
    const completion = result.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    controller.abort();
    await completion;

    const options = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(options?.detached).toBe(process.platform !== "win32");
  });
});
