// fg-faint mixed labels: real app builds (before = main 08437103, after = fix/fg-faint-help-empty),
// glass forced on over the CC0 "City rush" photo blurred 24px (same setup as floor-shots2.mjs).
import { readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { _electron as electron } from "playwright";
const OUT = "/workspace/modus-redesign/pr-fgfaint2/shots";
const APPS = { before: "/workspace/modus-fgf-before/apps/desktop", after: "/workspace/modus-fgfaint/apps/desktop" };
const WALL = readFileSync("/tmp/wall-city-rush.b64", "utf8");
const CSS = `.glass-wallpaper{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.glass-wallpaper img{position:absolute;inset:-48px;width:calc(100% + 96px);height:calc(100% + 96px);object-fit:cover;filter:blur(24px)}`;
const only = process.argv[2];
for (const [variant, dir] of Object.entries(APPS)) {
  if (only && only !== variant) continue;
  rmSync(`/tmp/fgf2-ud-${variant}`, { recursive: true, force: true });
  cpSync("/tmp/floor-ud", `/tmp/fgf2-ud-${variant}`, { recursive: true });
  const app = await electron.launch({ executablePath: "/workspace/modus-glass/node_modules/electron/dist/electron", args: [dir, "--no-sandbox", `--user-data-dir=/tmp/fgf2-ud-${variant}`], timeout: 90_000 });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setBounds({ x: 0, y: 0, width: 1440, height: 860 }); });
  await page.waitForTimeout(5000);
  const prep = async () => {
    await page.evaluate(([css, src]) => {
      const d = document.documentElement.dataset; d.nativeGlass = "true"; d.transparency = "full";
      let w = document.querySelector(".glass-wallpaper");
      if (!w) { w = document.createElement("div"); w.className = "glass-wallpaper"; w.innerHTML = "<img alt=''>"; document.body.prepend(w); const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); }
      w.querySelector("img").src = src;
    }, [CSS, WALL]);
    await page.waitForTimeout(700);
  };
  const shot = async (name) => { await prep(); const path = `${OUT}/${variant}-${name}.png`; await page.screenshot({ path }); console.log(variant, name); };
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => { localStorage.setItem("modus.theme", t); localStorage.setItem("modus.sidebar.pinned", "true"); }, theme);
    await page.reload(); await page.waitForTimeout(4000);
    await page.getByRole("button", { name: "New message" }).first().click(); await page.waitForTimeout(1200);
    const box = page.locator("textarea, [contenteditable=true]").first();
    await box.click(); await page.keyboard.type("/"); await page.waitForTimeout(900);
    await shot(`${theme}-slash-menu`);
    await page.keyboard.press("Escape"); await page.keyboard.press("Backspace"); await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Settings" }).first().click(); await page.waitForTimeout(1500);
    for (const [label, name] of [[/^General$/, "settings-general"], [/^Model & Provider$/, "settings-model-provider"], [/^MCP & Integrations$/, "settings-mcp"]]) {
      await page.getByText(label).first().click(); await page.waitForTimeout(1300);
      await page.mouse.move(1300, 800);
      await shot(`${theme}-${name}`);
    }
    const back = page.getByRole("button", { name: /back|close settings/i }).first();
    if (await back.count()) { await back.click(); await page.waitForTimeout(800); }
  }
  await app.close();
}
