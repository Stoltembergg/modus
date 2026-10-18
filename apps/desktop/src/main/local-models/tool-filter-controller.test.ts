import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalModelError } from "./errors";
import { manifestBytes } from "./manifest";
import {
  createToolFilterController,
  staticToolFilterAvailability,
  TOOL_FILTER_FILE_NAME,
  type ToolFilterControllerDeps,
  VC_RUNTIME_DLLS,
} from "./tool-filter-controller";
import type { ModelProcess } from "./tool-filter-host";
import type { EnsureFiles } from "./tool-ranker";
import type { MainToWorker, WorkerToMain } from "./worker-protocol";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function fakeWorker(probeFails = false) {
  let onMessage: (message: WorkerToMain) => void = () => undefined;
  const posted: MainToWorker["type"][] = [];
  const proc: ModelProcess = {
    pid: 7,
    postMessage(message) {
      posted.push(message.type);
      const reply: WorkerToMain =
        message.type === "probe" && probeFails
          ? {
              type: "error",
              id: message.id,
              code: "load-failed",
              message: "VCRUNTIME140.dll not found",
            }
          : message.type === "select"
            ? {
                type: "select",
                id: message.id,
                status: "ok",
                names: ["web_search"],
                inProcessMs: 3,
                rssBytes: 1,
              }
            : { type: "ok", id: message.id, rssBytes: 650e6, loadMs: 1800 };
      queueMicrotask(() => onMessage(reply));
    },
    onMessage: (handler) => {
      onMessage = handler;
    },
    onExit: () => undefined,
    kill: () => undefined,
  };
  return { proc, posted };
}

function controller(overrides: Partial<ToolFilterControllerDeps> & { probeFails?: boolean } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), "modus-tool-filter-"));
  dirs.push(userDataDir);
  const worker = fakeWorker(overrides.probeFails);
  const spawn = vi.fn(() => worker.proc);
  const ensureFiles = vi.fn<EnsureFiles>(async () => undefined);
  const c = createToolFilterController({
    userDataDir,
    spawn,
    availability: () => ({ available: true }),
    platform: "linux",
    forced: () => false,
    ensureFiles,
    log: () => undefined,
    ...overrides,
  });
  return { c, spawn, ensureFiles, worker, userDataDir };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("staticToolFilterAvailability", () => {
  it("Intel Mac: unavailable (no onnxruntime-node darwin/x64 binary)", () => {
    expect(staticToolFilterAvailability({ platform: "darwin", arch: "x64" })).toEqual({
      available: false,
      reason: "intel-mac",
    });
  });

  it("Apple silicon, Linux x64/arm64: available", () => {
    expect(staticToolFilterAvailability({ platform: "darwin", arch: "arm64" })).toEqual({
      available: true,
    });
    expect(staticToolFilterAvailability({ platform: "linux", arch: "x64" })).toEqual({
      available: true,
    });
    expect(staticToolFilterAvailability({ platform: "linux", arch: "arm64" })).toEqual({
      available: true,
    });
  });

  it("Windows without the VC++ runtime DLLs: unavailable, names what is missing", () => {
    const result = staticToolFilterAvailability({
      platform: "win32",
      arch: "x64",
      systemRoot: "C:\\Windows",
      fileExists: (path) => !path.endsWith("msvcp140_1.dll"),
    });
    expect(result).toEqual({
      available: false,
      reason: "vc-runtime-missing",
      detail: "msvcp140_1.dll",
    });
  });

  it("Windows with every VC++ runtime DLL: available", () => {
    const checked: string[] = [];
    const result = staticToolFilterAvailability({
      platform: "win32",
      arch: "x64",
      systemRoot: "C:\\Windows",
      fileExists: (path) => {
        checked.push(path);
        return true;
      },
    });
    expect(result).toEqual({ available: true });
    expect(checked).toEqual(VC_RUNTIME_DLLS.map((dll) => `C:\\Windows\\System32\\${dll}`));
  });

  it("other platforms: unsupported", () => {
    expect(staticToolFilterAvailability({ platform: "freebsd", arch: "x64" })).toMatchObject({
      available: false,
      reason: "unsupported-platform",
    });
  });
});

describe("tool filter controller", () => {
  it("ON by default: a fresh install (no preference file) probes, downloads and loads in the background at startup", async () => {
    const { c, spawn, ensureFiles, worker, userDataDir } = controller();
    expect(c.getState().enabled).toBe(true);
    c.start();
    await settle();
    await settle();
    expect(spawn).toHaveBeenCalled();
    expect(worker.posted.slice(0, 2)).toEqual(["probe", "load"]);
    expect(ensureFiles).toHaveBeenCalledTimes(1);
    expect(c.getState()).toMatchObject({
      enabled: true,
      availability: { available: true },
      download: { phase: "ready" },
      model: "ready",
      downloadBytes: manifestBytes(),
    });
    expect(c.turnFilter.enabled()).toBe(true);
    // The default is not a stored choice: nothing is written until the user flips the switch.
    expect(() => readFileSync(join(userDataDir, TOOL_FILTER_FILE_NAME))).toThrow();
    c.dispose();
  });

  it("an unreadable preference file reads as the default (ON)", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "modus-tool-filter-"));
    dirs.push(userDataDir);
    writeFileSync(join(userDataDir, TOOL_FILTER_FILE_NAME), "{not json");
    const { c, ensureFiles } = controller({ userDataDir });
    c.start();
    await settle();
    await settle();
    expect(c.getState().enabled).toBe(true);
    expect(ensureFiles).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it("a legacy `enabled: false` without `userSet` reads as the default (ON) and starts the download", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "modus-tool-filter-"));
    dirs.push(userDataDir);
    writeFileSync(
      join(userDataDir, TOOL_FILTER_FILE_NAME),
      `${JSON.stringify({ enabled: false })}\n`,
    );
    const { c, ensureFiles } = controller({ userDataDir });
    c.start();
    await settle();
    await settle();
    expect(c.getState()).toMatchObject({ enabled: true, model: "ready" });
    expect(ensureFiles).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it("a user-chosen `enabled: false` (`userSet: true`) stays off: nothing spawned, nothing downloaded", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "modus-tool-filter-"));
    dirs.push(userDataDir);
    writeFileSync(
      join(userDataDir, TOOL_FILTER_FILE_NAME),
      `${JSON.stringify({ enabled: false, userSet: true })}\n`,
    );
    const { c, spawn, ensureFiles } = controller({ userDataDir });
    c.start();
    await settle();
    expect(c.getState()).toMatchObject({
      enabled: false,
      download: { phase: "idle" },
      model: "stopped",
    });
    expect(c.turnFilter.enabled()).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(ensureFiles).not.toHaveBeenCalled();
  });

  it("a user-chosen `enabled: true` (`userSet: true`) is on", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "modus-tool-filter-"));
    dirs.push(userDataDir);
    writeFileSync(
      join(userDataDir, TOOL_FILTER_FILE_NAME),
      `${JSON.stringify({ enabled: true, userSet: true })}\n`,
    );
    const { c, ensureFiles } = controller({ userDataDir });
    c.start();
    await settle();
    await settle();
    expect(c.getState()).toMatchObject({ enabled: true, model: "ready" });
    expect(ensureFiles).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it.each([
    ["Intel Mac", { available: false, reason: "intel-mac" }],
    ["Windows without VC++", { available: false, reason: "vc-runtime-missing" }],
    ["unsupported platform", { available: false, reason: "unsupported-platform" }],
  ] as const)("%s: the default stays silently inactive at startup (no spawn, no download)", async (_name, availability) => {
    const { c, spawn, ensureFiles, userDataDir } = controller({ availability: () => availability });
    expect(() => c.start()).not.toThrow();
    await settle();
    expect(c.getState()).toMatchObject({ enabled: false, availability });
    expect(c.turnFilter.enabled()).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(ensureFiles).not.toHaveBeenCalled();
    expect(
      await c.turnFilter.select({ query: "q", tools: [{ name: "a", doc: "a" }], k: 1 }),
    ).toMatchObject({ tools: ["a"], filtered: false, fallback: "disabled" });
    expect(() => readFileSync(join(userDataDir, TOOL_FILTER_FILE_NAME))).toThrow();
  });

  it("a failed load probe at startup is not persisted: nothing downloads and the next launch checks again", async () => {
    const { c, ensureFiles, userDataDir } = controller({ probeFails: true });
    c.start();
    await settle();
    await settle();
    expect(c.getState()).toMatchObject({
      enabled: false,
      availability: { available: false, reason: "runtime-load-failed" },
    });
    expect(ensureFiles).not.toHaveBeenCalled();
    expect(() => readFileSync(join(userDataDir, TOOL_FILTER_FILE_NAME))).toThrow();
    const next = createToolFilterController({
      userDataDir,
      spawn: () => fakeWorker().proc,
      availability: () => ({ available: true }),
      forced: () => false,
      ensureFiles: async () => undefined,
      log: () => undefined,
    });
    expect(next.getState().enabled).toBe(true);
    next.dispose();
  });

  it.each([
    ["offline", new LocalModelError("download-failed", "getaddrinfo ENOTFOUND")],
    [
      "low disk space",
      new LocalModelError(
        "download-failed",
        "Failed to download model.onnx: ENOSPC: no space left on device",
      ),
    ],
    [
      "raw ENOSPC creating the folder",
      Object.assign(new Error("ENOSPC: no space left on device, mkdir"), { code: "ENOSPC" }),
    ],
  ])("background download failure (%s) is silent: all tools are sent and it retries later by itself", async (_name, error) => {
    let calls = 0;
    const ensureFiles = vi.fn<EnsureFiles>(async () => {
      calls++;
      if (calls === 1) throw error;
    });
    const { c } = controller({ ensureFiles, retryDelaysMs: [20] });
    c.start();
    await settle();
    await settle();
    // No error in the state the Settings row reads: nothing red, no retry button.
    expect(c.getState()).toMatchObject({
      enabled: true,
      download: { phase: "idle" },
      model: "stopped",
    });
    expect(c.ranker.status()).toMatchObject({ state: "failed", retryAt: expect.any(Number) });
    expect(
      await c.turnFilter.select({
        query: "q",
        tools: [
          { name: "a", doc: "a" },
          { name: "b", doc: "b" },
        ],
        k: 1,
      }),
    ).toMatchObject({ tools: ["a", "b"], filtered: false });
    await vi.waitFor(() => expect(ensureFiles).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await settle();
    await settle();
    expect(ensureFiles).toHaveBeenCalledTimes(2);
    expect(c.getState()).toMatchObject({
      enabled: true,
      download: { phase: "ready" },
      model: "ready",
    });
    c.dispose();
  });

  it("enable: persists, probes in the model process, downloads, loads; disable stops the process", async () => {
    const { c, worker, ensureFiles, userDataDir } = controller();
    const states: string[] = [];
    c.subscribe((state) => states.push(`${state.download.phase}/${state.model}`));
    await c.enable();
    await settle();
    await settle();
    expect(JSON.parse(readFileSync(join(userDataDir, TOOL_FILTER_FILE_NAME), "utf8"))).toEqual({
      enabled: true,
      userSet: true,
    });
    expect(worker.posted.slice(0, 2)).toEqual(["probe", "load"]);
    expect(ensureFiles).toHaveBeenCalledTimes(1);
    expect(c.getState()).toMatchObject({
      enabled: true,
      download: { phase: "ready" },
      model: "ready",
    });
    expect(states).toContain("ready/starting");
    expect(c.turnFilter.enabled()).toBe(true);
    expect(
      await c.turnFilter.select({ query: "web", tools: [{ name: "web_search", doc: "w" }], k: 1 }),
    ).toMatchObject({
      filtered: true,
    });
    await c.disable();
    expect(c.getState()).toMatchObject({ enabled: false, model: "stopped" });
    expect(c.host.running()).toBe(false);
    expect(JSON.parse(readFileSync(join(userDataDir, TOOL_FILTER_FILE_NAME), "utf8"))).toEqual({
      enabled: false,
      userSet: true,
    });
  });

  it("the preference survives a restart", async () => {
    const first = controller();
    await first.c.enable();
    const second = createToolFilterController({
      userDataDir: first.userDataDir,
      spawn: () => fakeWorker().proc,
      availability: () => ({ available: true }),
      forced: () => false,
      ensureFiles: async () => undefined,
      log: () => undefined,
    });
    expect(second.getState().enabled).toBe(true);
    first.c.dispose();
    second.dispose();
  });

  it("Intel Mac: enable is refused, the state says why, nothing is spawned", async () => {
    const { c, spawn } = controller({
      availability: () => ({ available: false, reason: "intel-mac" }),
    });
    const state = await c.enable();
    expect(state).toMatchObject({
      enabled: false,
      availability: { available: false, reason: "intel-mac" },
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(c.turnFilter.enabled()).toBe(false);
  });

  it("Windows without VC++ (static DLL check): refused with vc-runtime-missing", async () => {
    const { c, spawn } = controller({
      availability: () =>
        staticToolFilterAvailability({ platform: "win32", arch: "x64", fileExists: () => false }),
    });
    expect(c.getState().availability).toMatchObject({
      available: false,
      reason: "vc-runtime-missing",
    });
    expect((await c.enable()).enabled).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("Windows, real probe fails to load onnxruntime: toggle reverts and becomes vc-runtime-missing; nothing downloads", async () => {
    const { c, ensureFiles } = controller({ platform: "win32", probeFails: true });
    const state = await c.enable();
    expect(state).toMatchObject({
      enabled: false,
      availability: {
        available: false,
        reason: "vc-runtime-missing",
        detail: "VCRUNTIME140.dll not found",
      },
    });
    expect(ensureFiles).not.toHaveBeenCalled();
    expect(c.host.running()).toBe(false);
  });

  it("other OS, probe fails: runtime-load-failed", async () => {
    const { c } = controller({ probeFails: true });
    expect((await c.enable()).availability).toMatchObject({
      available: false,
      reason: "runtime-load-failed",
    });
  });

  it("download progress is reported; cancel turns the filter off and keeps the partial", async () => {
    let release: () => void = () => undefined;
    const ensureFiles = vi.fn<EnsureFiles>(
      (_dir, _url, { signal, onProgress }) =>
        new Promise((resolve, reject) => {
          onProgress(100e6, manifestBytes());
          release = resolve;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const { c } = controller({ ensureFiles });
    await c.enable();
    await settle();
    expect(c.getState()).toMatchObject({
      enabled: true,
      download: { phase: "downloading", receivedBytes: 100e6, totalBytes: manifestBytes() },
    });
    // While downloading, turns send every tool.
    expect(
      await c.turnFilter.select({ query: "q", tools: [{ name: "a", doc: "a" }], k: 1 }),
    ).toMatchObject({
      filtered: false,
      fallback: "not-ready",
    });
    await c.cancelDownload();
    await settle();
    expect(c.getState()).toMatchObject({ enabled: false, download: { phase: "idle" } });
    release();
  });

  it("download-failed stays silent while it retries by itself; hash-mismatch is failed and terminal", async () => {
    const offline = controller({
      ensureFiles: vi.fn<EnsureFiles>(async () => {
        throw new LocalModelError("download-failed", "getaddrinfo ENOTFOUND");
      }),
    });
    await offline.c.enable();
    await settle();
    expect(offline.c.getState().download).toEqual({ phase: "idle" });
    expect(offline.c.ranker.status()).toMatchObject({
      state: "failed",
      retryAt: expect.any(Number),
    });
    offline.c.dispose();

    const tamperedFiles = vi.fn<EnsureFiles>(async () => {
      throw new LocalModelError("hash-mismatch", "sha256 differs");
    });
    const tampered = controller({ ensureFiles: tamperedFiles });
    await tampered.c.enable();
    await settle();
    expect(tampered.c.getState().download).toMatchObject({
      phase: "failed",
      error: "hash-mismatch",
    });
    expect(tampered.c.ranker.status()).not.toHaveProperty("retryAt");
    await tampered.c.turnFilter.select({ query: "q", tools: [{ name: "a", doc: "a" }], k: 1 });
    await settle();
    expect(tamperedFiles).toHaveBeenCalledTimes(1);
    // Turning it on again ("Retry now") starts over.
    await tampered.c.enable();
    await settle();
    expect(tamperedFiles).toHaveBeenCalledTimes(2);
    tampered.c.dispose();
  });

  it("the developer flag forces it on without persisting", async () => {
    const { c, userDataDir } = controller({ forced: () => true });
    c.start();
    await settle();
    await settle();
    expect(c.turnFilter.enabled()).toBe(true);
    expect(c.getState().enabled).toBe(true);
    expect(() => readFileSync(join(userDataDir, TOOL_FILTER_FILE_NAME))).toThrow();
    c.dispose();
  });
});
