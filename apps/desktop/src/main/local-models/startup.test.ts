import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fork = vi.fn();
vi.mock("electron", () => ({ utilityProcess: { fork } }));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  fork.mockReset();
});

describe("local models startup", () => {
  it("filter on by default: startup probes in the model process when the platform is available", async () => {
    vi.stubEnv("MODUS_LOCAL_TOOL_FILTER", "");
    const { startLocalModels, getToolFilterController, stopLocalModels } = await import(
      "./startup"
    );
    const { staticToolFilterAvailability } = await import("./tool-filter-controller");
    const dir = mkdtempSync(join(tmpdir(), "modus-startup-test-"));
    try {
      startLocalModels(dir);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (staticToolFilterAvailability().available) {
        expect(fork).toHaveBeenCalledTimes(1);
      } else {
        expect(fork).not.toHaveBeenCalled();
      }
      expect(getToolFilterController(dir).getState().availability).toBeDefined();
    } finally {
      stopLocalModels();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filter turned off by the user: creating the controller spawns nothing and the turn filter is off", async () => {
    vi.stubEnv("MODUS_LOCAL_TOOL_FILTER", "");
    const { startLocalModels, getToolFilterController, stopLocalModels } = await import(
      "./startup"
    );
    const { turnToolFilterEnabled } = await import("./turn-tool-filter");
    const dir = mkdtempSync(join(tmpdir(), "modus-startup-test-"));
    writeFileSync(
      join(dir, "tool-filter.json"),
      `${JSON.stringify({ enabled: false, userSet: true })}\n`,
    );
    try {
      startLocalModels(dir);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fork).not.toHaveBeenCalled();
      expect(getToolFilterController(dir).getState().enabled).toBe(false);
      expect(turnToolFilterEnabled()).toBe(false);
    } finally {
      stopLocalModels();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the worker module sits next to the main bundle", async () => {
    const { workerModulePath } = await import("./startup");
    expect(workerModulePath()).toMatch(/tool-filter-worker\.js$/);
  });
});
