import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  app: { isPackaged: false },
  webContentsHandlers: new Map<string, (...args: unknown[]) => void>(),
  windowHandlers: new Map<string, ((...args: unknown[]) => void)[]>(),
  registerDraftOwner: vi.fn(() => Symbol("owner")),
  invalidateDraftOwner: vi.fn(),
  webContentsId: 42,
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  lastWindow: undefined as unknown,
  lastOptions: undefined as unknown,
  appearance: {
    attach: vi.fn(),
    rendererArgument: vi.fn(() => "--modus-appearance={}"),
  },
}));

vi.mock("electron", () => ({
  app: electronState.app,
  BrowserWindow: class {
    webContents = {
      id: electronState.webContentsId,
      mainFrame: { url: "" },
      on: (name: string, handler: (...args: unknown[]) => void) =>
        electronState.webContentsHandlers.set(name, handler),
      once: (name: string, handler: (...args: unknown[]) => void) =>
        electronState.webContentsHandlers.set(name, handler),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
    };
    on = (name: string, handler: (...args: unknown[]) => void) => {
      const handlers = electronState.windowHandlers.get(name) ?? [];
      handlers.push(handler);
      electronState.windowHandlers.set(name, handlers);
    };
    once = (name: string, handler: (...args: unknown[]) => void) => {
      const handlers = electronState.windowHandlers.get(name) ?? [];
      handlers.push(handler);
      electronState.windowHandlers.set(name, handlers);
    };
    isDestroyed = () => false;
    isMaximized = () => false;
    loadURL = electronState.loadURL;
    loadFile = electronState.loadFile;

    constructor(options: unknown) {
      electronState.lastWindow = this;
      electronState.lastOptions = options;
    }
  },
  screen: {
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1400, height: 900 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock("../agent/harness/hyperplan-draft-store", () => ({
  registerHyperPlanDraftOwner: electronState.registerDraftOwner,
  invalidateHyperPlanDraftOwner: electronState.invalidateDraftOwner,
}));

describe("main window renderer target and redirects", () => {
  const originalRendererUrl = process.env.ELECTRON_RENDERER_URL;
  const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;

  beforeEach(() => {
    electronState.app.isPackaged = false;
    electronState.webContentsHandlers.clear();
    electronState.windowHandlers.clear();
    electronState.loadURL.mockReset();
    electronState.loadFile.mockReset();
    electronState.registerDraftOwner.mockReset().mockImplementation(() => Symbol("owner"));
    electronState.invalidateDraftOwner.mockReset();
    electronState.webContentsId = 42;
    electronState.lastWindow = undefined;
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "C:/modus/resources",
    });
  });

  afterEach(() => {
    if (originalRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = originalRendererUrl;
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: originalResourcesPath,
    });
  });

  async function createWindow(rendererUrl?: string) {
    if (rendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = rendererUrl;
    vi.resetModules();
    const { createMainWindow } = await import("./main-window");
    createMainWindow({
      startupTimeline: { mark: vi.fn() } as unknown as Parameters<
        typeof createMainWindow
      >[0]["startupTimeline"],
      appearance: electronState.appearance,
    });
    return electronState.lastWindow;
  }

  it("hands the window to the appearance controller and passes its first-paint state", async () => {
    electronState.appearance.attach.mockReset();
    const window = await createWindow();

    expect(electronState.appearance.attach).toHaveBeenCalledWith(window, {
      nativeGlassAvailable: expect.any(Boolean),
    });
    expect(electronState.lastOptions).toMatchObject({
      webPreferences: { additionalArguments: ["--modus-appearance={}"], sandbox: true },
    });
  });

  it("ignores an attacker-provided renderer URL when packaged", async () => {
    electronState.app.isPackaged = true;
    await createWindow("http://attacker.invalid:9000/");

    expect(electronState.loadURL).not.toHaveBeenCalled();
    expect(electronState.loadFile).toHaveBeenCalledWith(
      expect.stringContaining(join("renderer", "index.html")),
    );
  });

  it("uses an explicitly configured loopback development URL with its port", async () => {
    await createWindow("http://127.0.0.1:4280/");

    expect(electronState.loadURL).toHaveBeenCalledWith("http://127.0.0.1:4280/");
    expect(electronState.loadFile).not.toHaveBeenCalled();
  });

  it.each([
    "https://attacker.invalid/",
    "http://localhost.attacker.invalid:5173/",
    "file:///tmp/renderer.html",
  ])("uses the local renderer instead of invalid development URL %s", async (url) => {
    await createWindow(url);

    expect(electronState.loadURL).not.toHaveBeenCalled();
    expect(electronState.loadFile).toHaveBeenCalledTimes(1);
  });

  it("blocks redirects outside the trusted target while allowing same-origin and hash redirects", async () => {
    await createWindow("http://localhost:5173/");
    const onWillRedirect = electronState.webContentsHandlers.get("will-redirect");
    expect(onWillRedirect).toBeTypeOf("function");

    const blocked = { preventDefault: vi.fn() };
    onWillRedirect?.(blocked, "https://attacker.invalid/redirect");
    expect(blocked.preventDefault).toHaveBeenCalledOnce();

    const sameOrigin = { preventDefault: vi.fn() };
    onWillRedirect?.(sameOrigin, "http://localhost:5173/next");
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();

    const hashNavigation = { preventDefault: vi.fn() };
    onWillRedirect?.(hashNavigation, "http://localhost:5173/#settings");
    expect(hashNavigation.preventDefault).not.toHaveBeenCalled();
  });

  it("blocks non-renderer file redirects but allows the packaged renderer hash URL", async () => {
    electronState.app.isPackaged = true;
    await createWindow("http://attacker.invalid/");
    const rendererFile = pathToFileURL(
      fileURLToPath(new URL("../renderer/index.html", import.meta.url)),
    ).href;
    const onWillRedirect = electronState.webContentsHandlers.get("will-redirect");

    const blocked = { preventDefault: vi.fn() };
    onWillRedirect?.(blocked, "file:///tmp/attacker.html");
    expect(blocked.preventDefault).toHaveBeenCalledOnce();

    const hashNavigation = { preventDefault: vi.fn() };
    onWillRedirect?.(hashNavigation, `${rendererFile}#settings`);
    expect(hashNavigation.preventDefault).not.toHaveBeenCalled();
  });

  it("clears owner drafts once across explicit window close and webContents destruction", async () => {
    await createWindow();

    for (const handler of electronState.windowHandlers.get("closed") ?? []) handler();
    electronState.webContentsHandlers.get("destroyed")?.();

    expect(electronState.registerDraftOwner).toHaveBeenCalledExactlyOnceWith(42);
    expect(electronState.invalidateDraftOwner).toHaveBeenCalledExactlyOnceWith(
      42,
      expect.any(Symbol),
    );
  });

  it("clears owner drafts when webContents is destroyed without window close", async () => {
    await createWindow();

    electronState.webContentsHandlers.get("destroyed")?.();

    expect(electronState.invalidateDraftOwner).toHaveBeenCalledExactlyOnceWith(
      42,
      expect.any(Symbol),
    );
  });
});
