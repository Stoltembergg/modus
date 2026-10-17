// v0.1.11 glass floor: real app builds (before = main 3d796844 renderer, after = fix/glass-opacity-floor)
// with glass forced on over a REAL wallpaper, blurred 24px, no OS material layer (the gate model).
import { readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { _electron as electron } from "playwright";
const OUT = "/workspace/modus-redesign/glass-floor/shots";
const APPS = { before: "/workspace/modus-glass/apps/desktop", after: "/workspace/modus-glass-floor/apps/desktop" };
const WALLS = Object.fromEntries(["sequoia-light", "bloom-dark"].map((w) => [w, readFileSync(`/tmp/wall-${w}.b64`, "utf8")]));
const CSS = `.glass-wallpaper{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.glass-wallpaper img{position:absolute;inset:-48px;width:calc(100% + 96px);height:calc(100% + 96px);object-fit:cover;filter:blur(24px)}`;
const PLAN = { dark: ["sequoia-light", "bloom-dark"], light: ["bloom-dark", "sequoia-light"] };
const samples = [];
for (const [variant, dir] of Object.entries(APPS)) {
  rmSync(`/tmp/floor-ud-${variant}`, { recursive: true, force: true });
  cpSync("/tmp/floor-ud", `/tmp/floor-ud-${variant}`, { recursive: true });
  const app = await electron.launch({ executablePath: "/workspace/modus-glass/node_modules/electron/dist/electron", args: [dir, "--no-sandbox", `--user-data-dir=/tmp/floor-ud-${variant}`], timeout: 90_000 });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setBounds({ x: 0, y: 0, width: 1440, height: 860 }); });
  await page.waitForTimeout(5000);
  let wall = "";
  const prep = async () => {
    await page.evaluate(([css, src]) => {
      const d = document.documentElement.dataset; d.nativeGlass = "true"; d.transparency = "full";
      let w = document.querySelector(".glass-wallpaper");
      if (!w) { w = document.createElement("div"); w.className = "glass-wallpaper"; w.innerHTML = "<img alt=''>"; document.body.prepend(w); const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); }
      w.querySelector("img").src = src;
    }, [CSS, WALLS[wall]]);
    await page.waitForTimeout(700);
  };
  // Text probes: computed colour + a background point just right of the element (no glyphs there).
  const probe = () => page.evaluate(() => {
    const r = getComputedStyle(document.documentElement);
    const pick = (re) => [...document.querySelectorAll("p,span,div,label")].find((e) => e.children.length === 0 && re.test(e.textContent || "") && e.getBoundingClientRect().width > 0);
    const out = { ui: document.documentElement.dataset.ui, theme: document.documentElement.dataset.theme, chrome: r.getPropertyValue("--glass-alpha-chrome").trim(), overlay: r.getPropertyValue("--glass-alpha-overlay").trim(), probes: [] };
    for (const re of [/Shown in the model picker|One endpoint, any protocol/, /^Model & Provider$|^Model$/, /Why does the billing webhook retry twice\?/, /^Appearance$/, /Ask anything|Message|What should/]) {
      const e = pick(re); if (!e) continue; const b = e.getBoundingClientRect();
      out.probes.push({ text: (e.textContent || "").slice(0, 40), color: getComputedStyle(e).color, x: Math.round(b.right + 14), y: Math.round(b.top + b.height / 2), box: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)] });
    }
    return out;
  });
  const shot = async (name) => { await prep(); const p = await probe(); const path = `${OUT}/${variant}-${name}.png`; await page.screenshot({ path }); samples.push({ variant, name, path, ...p }); console.log(variant, name, p.chrome, p.overlay, p.probes.length); };
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => localStorage.setItem("modus.theme", t), theme);
    await page.reload(); await page.waitForTimeout(4000);
    for (const w of PLAN[theme]) {
      wall = w; const tag = `${theme}-over-${w}`;
      await page.getByRole("button", { name: "New message" }).first().click(); await page.waitForTimeout(1200);
      await page.mouse.move(900, 700);
      await shot(`${tag}-home-composer`);
      await page.mouse.move(20, 300); await page.waitForTimeout(900);
      const chat = page.getByText("Why does the billing webhook retry twice?").first();
      if (await chat.count()) { await chat.click(); await page.waitForTimeout(1500); }
      await page.mouse.move(900, 400); await page.waitForTimeout(900);
      await shot(`${tag}-chat`);
      await page.getByRole("button", { name: "Settings" }).first().click(); await page.waitForTimeout(1500);
      await page.mouse.move(1300, 800);
      await shot(`${tag}-settings`);
      await page.getByText(/^Model/).first().click(); await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "Connect custom provider" }).click(); await page.waitForTimeout(1200);
      await shot(`${tag}-settings-custom-provider`);
      await page.keyboard.press("Escape"); await page.waitForTimeout(600);
      await page.keyboard.press("Escape"); await page.waitForTimeout(800);
      const back = page.getByRole("button", { name: /back|close settings/i }).first();
      if (await page.locator(".settings-content").count() && await back.count()) { await back.click(); await page.waitForTimeout(800); }
    }
  }
  await app.close();
}
writeFileSync(`${OUT}/samples.json`, JSON.stringify(samples, null, 1));
