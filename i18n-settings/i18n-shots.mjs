import { cpSync, rmSync } from "node:fs";
import { _electron as electron } from "playwright";
const OUT = "/workspace/i18n-shots/out";
const DIR = "/workspace/modus-i18n/apps/desktop";
const only = process.argv[2];
rmSync("/tmp/i18n-ud", { recursive: true, force: true });
cpSync("/tmp/floor-ud", "/tmp/i18n-ud", { recursive: true });
const app = await electron.launch({ executablePath: "/workspace/modus-glass/node_modules/electron/dist/electron", args: [DIR, "--no-sandbox", "--user-data-dir=/tmp/i18n-ud"], timeout: 90_000 });
const page = await app.firstWindow();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setBounds({ x: 0, y: 0, width: 1440, height: 900 }); });
await page.waitForTimeout(5000);
// Through the real selector path: main persists it, rebuilds the menu and pushes <html lang>.
const setLang = async (lang) => { await page.evaluate((l) => window.modus.app.uiLanguage.set(l), lang); await page.waitForTimeout(700); };
const shot = async (name, hover = [1430, 890]) => { await page.mouse.move(...hover); await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log("shot", name); };
const T = { en: { settings: "Settings", newMsg: /^(New message|Nova mensagem)$/, general: "General", model: "Model & Provider", appearance: "Appearance", mcp: "MCP & Integrations", account: "Account" },
            pt: { settings: "Configurações", newMsg: /^(New message|Nova mensagem)$/, general: "Geral", model: "Modelo e provedor", appearance: "Aparência", mcp: "MCP e integrações", account: "Conta" } };
for (const theme of ["dark", "light"]) {
  await page.evaluate((t) => localStorage.setItem("modus.theme", t), theme);
  await page.reload(); await page.waitForTimeout(4000);
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setBounds({ x: 0, y: 0, width: 1440, height: 900 }); });
  await page.waitForTimeout(1000);
  console.log("viewport", await page.evaluate(() => [innerWidth, innerHeight]));
  for (const lang of ["en", "pt"]) {
    if (only && only !== `${theme}-${lang}`) continue;
    await setLang(lang === "pt" ? "pt-BR" : "en");
    console.log("lang", await page.evaluate(() => document.documentElement.lang));
    const L = T[lang];
    // clarification card
    await page.getByRole("button", { name: L.newMsg }).first().click(); await page.waitForTimeout(1200);
    const box = page.locator("[contenteditable=true], textarea").first();
    await box.click(); await page.keyboard.type("Fix it"); await page.keyboard.press("Enter");
    try { await page.getByRole("region", { name: lang === "pt" ? "Pergunta" : "Question" }).waitFor({ timeout: 15000 }); } catch { console.log("no card", theme, lang); }
    await page.waitForTimeout(800);
    await shot(`${theme}-${lang}-clarification-card`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(800);
    // settings
    await page.getByRole("button", { name: L.settings }).first().click(); await page.waitForTimeout(1500);
    for (const [key, label] of [["general", L.general], ["model-provider", L.model], ["appearance", L.appearance], ["mcp", L.mcp], ["account", L.account]]) {
      await page.mouse.move(8, 300); await page.waitForTimeout(700);
      await page.getByRole("button", { name: label, exact: true }).first().click(); await page.waitForTimeout(1300);
      await shot(`${theme}-${lang}-settings-${key}`, [8, 450]); await page.mouse.move(120, 450); await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/${theme}-${lang}-settings-${key}.png` });
      if (key === "general") {
        await page.getByRole("combobox", { name: lang === "pt" ? "Idioma" : "Language" }).click(); await page.waitForTimeout(700);
        await page.screenshot({ path: `${OUT}/${theme}-${lang}-language-selector.png` }); console.log("shot selector");
        await page.keyboard.press("Escape"); await page.waitForTimeout(500);
      }
    }
    await page.keyboard.press("Escape"); await page.waitForTimeout(1000);
    const back = page.locator("aside button").first(); if (await page.locator("aside input[placeholder]").count()) { await back.click(); await page.waitForTimeout(800); }
  }
}
console.log("menu", await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label)));
await setLang("system");
console.log("menu after system", await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label)));
await app.close();
