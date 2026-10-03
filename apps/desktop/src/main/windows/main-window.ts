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
import type { AppearanceController } from "../appearance/appearance-controller";
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
  appearance,
}: {
  startupTimeline: StartupTimeline;
  appearance: Pick<AppearanceController, "attach" | "rendererArgument">;
}): BrowserWindowType {
  const preloadPath = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(1180, workArea.width);
  const height = Math.min(760, workArea.height);

  const host = resolveWindowAppearance(process.platform, process.getSystemVersion?.() ?? "");
  let nativeGlassAvailable = host.glass === "native";
  const createWindow = (glass: "native" | "solid"): BrowserWindowType =>
    new BrowserWindow({
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
      minWidth: Math.min(1120, width),
      minHeight: Math.min(720, height),
      title: "Modus",
      ...(host.chrome === "macos" ? {} : { icon: appIconPath }),
      show: true,
      ...windowChromeOptionsFor({ ...host, glass }),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        additionalArguments: [appearance.rendererArgument()],
      },
    });

  let window: BrowserWindowType;
  try {
    window = createWindow(host.glass);
  } catch (error) {
    if (!nativeGlassAvailable) throw error;
    nativeGlassAvailable = false;
    window = createWindow("solid");
  }
  // Material, colours and the glass-off sequencing live in the appearance controller.
  appearance.attach(window, { nativeGlassAvailable });
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
