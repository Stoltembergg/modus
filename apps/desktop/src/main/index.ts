import { app, BrowserWindow, type BrowserWindow as BrowserWindowType } from "electron";
import { startRemoteModelCatalog, stopRemoteModelCatalog } from "./agent/model-service";
import { resolveBrowserLocale } from "./browser/browser-locale";
import { IPC_CHANNELS } from "./ipc/channels";
import { registerAppIpc } from "./ipc/register-app-ipc";
import { disposeAllMcp } from "./mcp/mcp-service";
import { createStartupTimeline } from "./startup/startup-timeline";
import { shutdownTerminals } from "./terminal/terminal-service";
import { startUpdateServiceInBackground, stopUpdateService } from "./updater/update-service";
import { installApplicationMenu } from "./windows/application-menu";
import { createMainWindow } from "./windows/main-window";

// Chromium UI strings / Intl follow the OS language for the embedded browser
// and any WebContents that inherit the process locale. Must run before ready.
try {
  app.commandLine.appendSwitch("lang", resolveBrowserLocale());
} catch {
  // Locale helpers need Electron; ignore in non-Electron unit contexts.
}

let mainWindow: BrowserWindowType | null = null;
let ipcRegistered = false;
const startupTimeline = createStartupTimeline();

startupTimeline.mark("main.entry");

function ensureAppIpcRegistered(): void {
  if (ipcRegistered) {
    return;
  }

  registerAppIpc({ startupTimeline });
  ipcRegistered = true;
}

function openMainWindow(): void {
  ensureAppIpcRegistered();

  mainWindow = createMainWindow({ startupTimeline });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.focus();
  });

  app
    .whenReady()
    .then(() => {
      startupTimeline.mark("main.electron-ready");
      installApplicationMenu();
      startRemoteModelCatalog(() => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(IPC_CHANNELS.modelCatalogChanged);
        }
      });
      openMainWindow();
      // No-op in dev, beta builds and unsupported platforms; first check runs after a delay.
      startUpdateServiceInBackground();

      // Register after ready so the first launch does not race activate → boot.
      // Recreate the window only — IPC stays registered for the process lifetime.
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          openMainWindow();
        }
      });
    })
    .catch((error: unknown) => {
      console.error("Failed to boot Modus desktop.", error);
      app.exit(1);
    });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // Close MCP transports on quit so stdio servers never outlive the app.
  // Also runs for update installs: quitAndInstall and the mac installer both go through app.quit().
  app.on("before-quit", () => {
    stopUpdateService();
    stopRemoteModelCatalog();
    shutdownTerminals();
    void disposeAllMcp();
  });
}
