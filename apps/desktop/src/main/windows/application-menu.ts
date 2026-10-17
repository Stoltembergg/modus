import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { type MainTextKey, mainText } from "../../shared/main-text";

/**
 * Native application menu (macOS menu bar / Windows Alt menu), in the app
 * language. Every item carries an explicit label from `main-text.ts`: Electron
 * role defaults are English on Windows / Linux. `installApplicationMenu` is
 * called again on each language change, so the menu switches without a restart.
 * In-window File/Edit/View/Help stubs are decorative and must not appear on macOS.
 */
export function buildApplicationMenuTemplate({
  locale,
  platform = process.platform,
  appName = "Modus",
}: {
  locale?: string | undefined;
  platform?: NodeJS.Platform;
  appName?: string;
} = {}): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const t = (key: MainTextKey) => mainText(key, locale, { app: appName });
  const item = (role: NonNullable<MenuItemConstructorOptions["role"]>, key: MainTextKey) => ({
    role,
    label: t(key),
  });
  const separator = { type: "separator" as const };

  return [
    ...(isMac
      ? [
          {
            label: appName,
            submenu: [
              item("about", "main.menu.about"),
              separator,
              item("services", "main.menu.services"),
              separator,
              item("hide", "main.menu.hide"),
              item("hideOthers", "main.menu.hideOthers"),
              item("unhide", "main.menu.unhide"),
              separator,
              item("quit", "main.menu.quit"),
            ],
          },
        ]
      : []),
    {
      label: t("main.menu.file"),
      submenu: [isMac ? item("close", "main.menu.close") : item("quit", "main.menu.quit")],
    },
    {
      label: t("main.menu.edit"),
      submenu: [
        item("undo", "main.menu.undo"),
        item("redo", "main.menu.redo"),
        separator,
        item("cut", "main.menu.cut"),
        item("copy", "main.menu.copy"),
        item("paste", "main.menu.paste"),
        ...(isMac
          ? [
              item("pasteAndMatchStyle", "main.menu.pasteAndMatchStyle"),
              item("delete", "main.menu.delete"),
              item("selectAll", "main.menu.selectAll"),
            ]
          : [
              item("delete", "main.menu.delete"),
              separator,
              item("selectAll", "main.menu.selectAll"),
            ]),
      ],
    },
    {
      label: t("main.menu.view"),
      submenu: [
        item("reload", "main.menu.reload"),
        item("forceReload", "main.menu.forceReload"),
        item("toggleDevTools", "main.menu.toggleDevTools"),
        separator,
        item("resetZoom", "main.menu.resetZoom"),
        item("zoomIn", "main.menu.zoomIn"),
        item("zoomOut", "main.menu.zoomOut"),
        separator,
        item("togglefullscreen", "main.menu.toggleFullScreen"),
      ],
    },
    {
      label: t("main.menu.window"),
      submenu: [
        item("minimize", "main.menu.minimize"),
        item("zoom", "main.menu.zoom"),
        ...(isMac
          ? [separator, item("front", "main.menu.front")]
          : [item("close", "main.menu.close")]),
      ],
    },
    {
      role: "help",
      label: t("main.menu.help"),
      submenu: [],
    },
  ];
}

export function installApplicationMenu(locale?: string): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildApplicationMenuTemplate({ locale, appName: app.name })),
  );
}
