import { afterEach, describe, expect, it, vi } from "vitest";

const fork = vi.fn();
vi.mock("electron", () => ({ utilityProcess: { fork } }));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  fork.mockReset();
});

describe("local models startup", () => {
  it("filter off (default): creating the controller spawns nothing and the turn filter is off", async () => {
    vi.stubEnv("MODUS_LOCAL_TOOL_FILTER", "");
    const { startLocalModels, getToolFilterController, stopLocalModels } = await import(
      "./startup"
    );
    const { turnToolFilterEnabled } = await import("./turn-tool-filter");
    const dir = `/tmp/modus-startup-test-${process.pid}`;
    startLocalModels(dir);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fork).not.toHaveBeenCalled();
    expect(getToolFilterController(dir).getState().enabled).toBe(false);
    expect(turnToolFilterEnabled()).toBe(false);
    stopLocalModels();
  });

  it("the worker module sits next to the main bundle", async () => {
    const { workerModulePath } = await import("./startup");
    expect(workerModulePath()).toMatch(/tool-filter-worker\.js$/);
  });
});
