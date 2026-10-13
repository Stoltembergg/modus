import { BrowserWindow } from "electron";

/** Static, no preload, no IPC (plan §2.4): painted before the synchronous migration blocks main. */
export const MIGRATION_SPLASH_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>html,body{margin:0;height:100%;background:#111214;color:#e8e8ea;font:14px -apple-system,system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px}
.s{width:22px;height:22px;border:2px solid #444;border-top-color:#e8e8ea;border-radius:50%;animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(360deg)}} p{margin:0;color:#9a9aa2;font-size:12px}</style></head>
<body><div class="s"></div><div>Moving your groups to Projects…</div><p>This happens once. Your data is backed up first.</p></body></html>`;

export async function showMigrationSplash(): Promise<BrowserWindow> {
  const splash = new BrowserWindow({
    width: 380,
    height: 170,
    resizable: false,
    frame: false,
    show: false,
    backgroundColor: "#111214",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const shown = new Promise<void>((resolve) => splash.once("ready-to-show", () => resolve()));
  await splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(MIGRATION_SPLASH_HTML)}`);
  await shown;
  splash.show();
  // Let the compositor paint one frame before the synchronous migration blocks the main thread.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return splash;
}
