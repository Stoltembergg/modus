import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { name: "Modus" }, Menu: {} }));

const { buildApplicationMenuTemplate } = await import("./application-menu");

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    ...(item.label ? [item.label] : []),
    ...(Array.isArray(item.submenu) ? labels(item.submenu) : []),
  ]);
}

describe("native application menu language", () => {
  it("is English by default, with an explicit label on every item", () => {
    const template = buildApplicationMenuTemplate({ platform: "win32" });
    expect(template.map((item) => item.label)).toEqual(["File", "Edit", "View", "Window", "Help"]);
    const items = template.flatMap((item) => (Array.isArray(item.submenu) ? item.submenu : []));
    for (const item of items) if (item.type !== "separator") expect(item.label).toBeTruthy();
  });

  it("is rebuilt in Portuguese (Windows and macOS)", () => {
    const win = labels(buildApplicationMenuTemplate({ locale: "pt-BR", platform: "win32" }));
    expect(win).toEqual(
      expect.arrayContaining([
        "Arquivo",
        "Editar",
        "Visualizar",
        "Janela",
        "Ajuda",
        "Copiar",
        "Colar",
      ]),
    );
    expect(win).toContain("Encerrar Modus");
    const mac = labels(
      buildApplicationMenuTemplate({ locale: "pt-BR", platform: "darwin", appName: "Modus" }),
    );
    expect(mac).toEqual(expect.arrayContaining(["Modus", "Sobre o Modus", "Ocultar Modus"]));
    expect(mac).not.toContain("Edit");
  });
});
