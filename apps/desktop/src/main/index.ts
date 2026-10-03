import { app, BrowserWindow, type BrowserWindow as BrowserWindowType } from "electron";
import {
  shutdownProviderAuthOperations,
  startRemoteModelCatalog,
  stopRemoteModelCatalog,
} from "./agent/model-service";
import {
  deepLinkCallbackHub,
  initializeAuthService,
  shutdownAuthService,
} from "./auth/auth-service-instance";
import { getBillingService, shutdownBillingService } from "./billing/billing-service-instance";
import { resolveBrowserLocale } from "./browser/browser-locale";
import {
  initializeComposioService,
  shutdownComposioService,
} from "./composio/composio-service-instance";
import {
  createDeepLinkRouter,
  findDeepLinkInArgv,
  registerModusProtocol,
} from "./deep-link/deep-link";
import { disposeGroupRuntime } from "./groups/group-runtime-service";
import { IPC_CHANNELS } from "./ipc/channels";
import { registerAppIpc } from "./ipc/register-app-ipc";
import { disposeAllMcp } from "./mcp/mcp-service";
import { createStartupTimeline } from "./startup/startup-timeline";
import { shutdownTerminals } from "./terminal/terminal-service";
import {
  saveRestoreSnapshotOnQuit,
  startUpdateServiceInBackground,
  stopUpdateService,
  takeRestoreSnapshotAtStartup,
} from "./updater/update-service";
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
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

function drainShutdown(tasks: Promise<unknown>[]): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS);
    timeout.unref?.();
    void Promise.allSettled(tasks).then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

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

function focusMainWindow(): void {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
}

// modus://auth/callback (deep-link OAuth transport) and modus://billing/return (Stripe).
// Links that arrive before the window exists are queued until markReady().
const deepLinks = createDeepLinkRouter({
  onAuthCallback: (link) => {
    deepLinkCallbackHub.deliver(link);
  },
  onBillingReturn: (link) => {
    void getBillingService()
      .handleReturn(link.status)
      .catch(() => undefined);
  },
  focus: focusMainWindow,
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  try {
    registerModusProtocol(app, process);
  } catch {
    // Registration is best effort (e.g. sandboxed Linux without xdg-mime).
  }

  // macOS delivers modus:// links here (also before ready on a cold start).
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deepLinks.handle(url);
  });

  // Windows / Linux: a second launch carries the link in argv; this instance keeps the lock.
  app.on("second-instance", (_event, argv) => {
    focusMainWindow();
    const link = findDeepLinkInArgv(argv);
    if (link) deepLinks.handle(link);
  });

  // Cold start on Windows / Linux with the link as an argument.
  const launchLink = findDeepLinkInArgv(process.argv);
  if (launchLink) deepLinks.handle(launchLink);

  app
    .whenReady()
    .then(() => {
      startupTimeline.mark("main.electron-ready");
      installApplicationMenu();
      // Before the window asks for it and before the update service cleans its dir.
      takeRestoreSnapshotAtStartup();
      startRemoteModelCatalog(() => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(IPC_CHANNELS.modelCatalogChanged);
        }
      });
      openMainWindow();
      // Restore the profile after the first renderer exists; do not block agent startup on Composio.
      void initializeComposioService().catch(() => undefined);
      // Restore the Supabase session (encrypted refresh token) without blocking the window.
      void initializeAuthService().catch(() => undefined);
      deepLinks.markReady();
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

  // Electron does not await async event listeners: hold the first quit until
  // auth callbacks and other owned resources have had a bounded drain.
  let shutdownStarted = false;
  let allowQuitAfterShutdown = false;
  app.on("before-quit", (event) => {
    if (allowQuitAfterShutdown) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    // Sync, before anything stops: the renderer already pushed its state (no IPC here).
    saveRestoreSnapshotOnQuit();
    // Close MCP transports on quit so stdio servers never outlive the app.
    // Also runs for update installs: quitAndInstall and the mac installer both go through app.quit().
    stopUpdateService();
    stopRemoteModelCatalog();
    shutdownTerminals();
    // Stop the group queue's retry timer and its agent-runtime subscriptions.
    disposeGroupRuntime();
    shutdownBillingService();
    void drainShutdown([
      shutdownProviderAuthOperations(),
      shutdownAuthService(),
      (async () => {
        try {
          await shutdownComposioService();
        } finally {
          await disposeAllMcp();
        }
      })(),
    ]).then(() => {
      allowQuitAfterShutdown = true;
      app.quit();
    });
  });
}
