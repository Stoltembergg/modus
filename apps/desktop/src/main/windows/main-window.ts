import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  type BrowserWindow as BrowserWindowType,
  screen,
  shell,
} from "electron";
import { resolveWindowAppearance } from "../../shared/window-appearance";
import {
  invalidateHyperPlanDraftOwner,
  registerHyperPlanDraftOwner,
} from "../agent/harness/hyperplan-draft-store";
import { IPC_CHANNELS } from "../ipc/channels";
import { isTrustedRendererUrl, registerTrustedSender } from "../ipc/trusted-sender";
import type { StartupTimeline } from "../startup/startup-timeline";
import { windowChromeOptionsFor } from "./window-options";

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const EXTERNAL_PROTOCOLS = new Set(["https:", "http:"]);
const appIconPath = app.isPackaged
  ? join(process.resourcesPath, "icon.png")
  : join(currentDir, "../../resources/icon.png");

function isExternalUrlAllowed(rawUrl: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

function resolveRendererTarget(
  packaged: boolean,
  configuredUrl: string | undefined,
  packagedUrl: string,
): {
  url: string;
  isDevServer: boolean;
} {
  if (!packaged && configuredUrl) {
    try {
      const url = new URL(configuredUrl);
      const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        loopbackHosts.has(url.hostname) &&
        !url.username &&
        !url.password
      ) {
        return { url: url.href, isDevServer: true };
      }
    } catch {
      // Invalid development configuration falls back to the packaged renderer.
    }
  }
  return { url: packagedUrl, isDevServer: false };
}

export function createMainWindow({
  startupTimeline,
}: {
  startupTimeline: StartupTimeline;
}): BrowserWindowType {
  const preloadPath = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(1180, workArea.width);
  const height = Math.min(760, workArea.height);

  const appearance = resolveWindowAppearance(process.platform, process.getSystemVersion());
  let nativeGlassAvailable = appearance.glass === "native";
  const createWindow = (glass: "native" | "solid"): BrowserWindowType =>
    new BrowserWindow({
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
      minWidth: Math.min(1120, width),
      minHeight: Math.min(720, height),
      title: "Modus",
      ...(appearance.chrome === "macos" ? {} : { icon: appIconPath }),
      show: true,
      ...windowChromeOptionsFor({ ...appearance, glass }),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

  let window: BrowserWindowType;
  try {
    window = createWindow(appearance.glass);
  } catch (error) {
    if (!nativeGlassAvailable) throw error;
    nativeGlassAvailable = false;
    window = createWindow("solid");
  }
  if (appearance.chrome === "windows-overlay" && nativeGlassAvailable) {
    try {
      window.setBackgroundMaterial("mica");
    } catch {
      // OS build detection normally guarantees support; keep startup usable if
      // DWM declines the effect and paint the same solid fallback as Linux.
      try {
        window.setBackgroundMaterial("none");
      } catch {
        // The fallback color and renderer surfaces remain available without DWM.
      }
      nativeGlassAvailable = false;
      window.setBackgroundColor("#131314");
    }
  }
  if (appearance.glass === "native") {
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.windowGlassEvent, nativeGlassAvailable);
      }
    });
  }
  const ownerEpoch = registerHyperPlanDraftOwner(window.webContents.id);
  startupTimeline.mark("main.window-created");

  // 把 maximize/unmaximize 状态推送给 renderer，用于切换 max/restore 按钮图标
  const sendState = (): void => {
    if (window.isDestroyed()) {
      return;
    }
    window.webContents.send(IPC_CHANNELS.windowStateEvent, {
      maximized: window.isMaximized(),
    });
  };
  window.on("maximize", sendState);
  window.on("unmaximize", sendState);

  window.webContents.once("dom-ready", () => {
    startupTimeline.mark("main.dom-ready");
  });

  window.once("ready-to-show", () => {
    startupTimeline.mark("main.ready-to-show");
    sendState();
  });

  const packagedRendererPath = join(currentDir, "../renderer/index.html");
  const packagedRendererUrl = pathToFileURL(packagedRendererPath).href;
  const { url: rendererUrl, isDevServer } = resolveRendererTarget(
    app.isPackaged,
    process.env.ELECTRON_RENDERER_URL,
    packagedRendererUrl,
  );
  const unregisterTrustedSender = registerTrustedSender(window.webContents, rendererUrl);
  window.once("closed", unregisterTrustedSender);

  let ownerDraftsCleared = false;
  const clearOwnerDrafts = (): void => {
    if (ownerDraftsCleared) return;
    ownerDraftsCleared = true;
    try {
      invalidateHyperPlanDraftOwner(window.webContents.id, ownerEpoch);
    } catch {
      console.warn("[modus] HyperPlan owner draft cleanup failed.");
    }
  };
  window.once("closed", clearOwnerDrafts);
  window.webContents.once("destroyed", clearOwnerDrafts);

  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(rendererUrl, url)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedRendererUrl(rendererUrl, url)) {
      event.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrlAllowed(url)) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });

  if (isDevServer) {
    window.webContents.on("console-message", (event) => {
      console.log(`[renderer:${event.level}] ${event.message}`);
    });
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      console.error("[renderer:did-fail-load]", errorCode, errorDescription, validatedUrl);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      console.error("[renderer:gone]", details);
    });
  }

  if (isDevServer) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(packagedRendererPath);
  }

  return window;
}
