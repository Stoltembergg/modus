// Settings sidebar footer: before = v0.1.11 (f27fd9de), after = fix/settings-sidebar-attribution.
// Real electron-vite builds; glass forced on over the CC0 "City rush" photo blurred 24px (as in #257/#263/#264).
import { readFileSync, cpSync, rmSync } from "node:fs";
import { _electron as electron } from "playwright";
const OUT = "/workspace/modus-redesign/pr-attr/shots";
const APPS = { before: "/workspace/modus-fgf-before/apps/desktop", after: "/workspace/modus-fgfaint/apps/desktop" };
const WALL = readFileSync("/tmp/wall-city-rush.b64", "utf8");
const CSS = `.glass-wallpaper{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.glass-wallpaper img{position:absolute;inset:-48px;width:calc(100% + 96px);height:calc(100% + 96px);object-fit:cover;filter:blur(24px)}`;
for (const [variant, dir] of Object.entries(APPS)) {
  const ud = `/tmp/attr-ud-${variant}`;
  rmSync(ud, { recursive: true, force: true });
  cpSync("/tmp/floor-ud", ud, { recursive: true });
  const app = await electron.launch({ executablePath: "/workspace/modus-glass/node_modules/electron/dist/electron", args: [dir, "--no-sandbox", `--user-data-dir=${ud}`], timeout: 90_000 });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setBounds({ x: 0, y: 0, width: 1440, height: 860 }); });
  await page.waitForTimeout(5000);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => { localStorage.setItem("modus.theme", t); localStorage.setItem("modus.sidebar.pinned", "true"); }, theme);
    await page.reload(); await page.waitForTimeout(4000);
    await page.getByRole("button", { name: "Settings" }).first().click(); await page.waitForTimeout(1500);
    await page.getByText(/^General$/).first().click(); await page.waitForTimeout(1200);
    await page.evaluate(([css, src]) => {
      const d = document.documentElement.dataset; d.nativeGlass = "true"; d.transparency = "full";
      const w = document.createElement("div"); w.className = "glass-wallpaper"; w.innerHTML = "<img alt=''>"; document.body.prepend(w);
      const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); w.querySelector("img").src = src;
    }, [CSS, WALL]);
    await page.mouse.move(1300, 800); await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${variant}-${theme}-settings.png` });
    // Crop: the Settings sidebar (aside) from its search box down to the footer.
    const aside = page.locator("aside").filter({ hasText: "Modus Desktop" }).first();
    const bb = await aside.boundingBox();
    const clip = { x: bb.x, y: Math.max(bb.y, bb.y + bb.height - 420), width: bb.width, height: Math.min(420, bb.height) };
    await page.screenshot({ path: `${OUT}/${variant}-${theme}-sidebar-footer.png`, clip });
    console.log(variant, theme, JSON.stringify(bb));
    const back = page.getByRole("button", { name: /back|close settings/i }).first();
    if (await back.count()) { await back.click(); await page.waitForTimeout(800); }
  }
  await app.close();
}
