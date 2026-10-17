// RERANK-03 PR 2: Settings → General → Local tool filter states.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO ?? "/workspace/modus-lm";
const OUT = process.env.OUT ?? "/workspace/tf-screens";
const PORT = 5307;
const MB = 1e6;
const total = 415_329_394;
const base = {
  enabled: false,
  availability: { available: true },
  download: { phase: "idle" },
  model: "stopped",
  downloadBytes: total,
  partialBytes: 0,
};
const SHOTS = [
  { file: "01-off.png", state: base },
  { file: "02-download-prompt.png", state: base, click: true },
  { file: "03-download-prompt-resume.png", state: { ...base, partialBytes: 120 * MB }, click: true },
  { file: "04-downloading-progress.png", state: { ...base, enabled: true, download: { phase: "downloading", receivedBytes: 162 * MB, totalBytes: total } } },
  { file: "05-verifying.png", state: { ...base, enabled: true, download: { phase: "verifying", totalBytes: total } } },
  { file: "06-on-ready.png", state: { ...base, enabled: true, download: { phase: "ready" }, model: "ready" } },
  { file: "07-on-stopped-idle.png", state: { ...base, enabled: true, download: { phase: "ready" }, model: "stopped" } },
  { file: "08-unavailable-intel-mac.png", state: { ...base, availability: { available: false, reason: "intel-mac" } } },
  { file: "09-unavailable-vc-runtime.png", state: { ...base, availability: { available: false, reason: "vc-runtime-missing", detail: "vcruntime140_1.dll" } } },
  { file: "10-download-failed-retry.png", state: { ...base, enabled: true, download: { phase: "failed", error: "download-failed", message: "offline" } } },
  { file: "11-hash-mismatch.png", state: { ...base, enabled: true, download: { phase: "failed", error: "hash-mismatch", message: "sha256" } } },
  { file: "12-pt-BR-downloading.png", locale: "pt-BR", state: { ...base, enabled: true, download: { phase: "downloading", receivedBytes: 162 * MB, totalBytes: total } } },
  { file: "13-pt-BR-download-prompt.png", locale: "pt-BR", state: base, click: true },
];

function startVite() {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(REPO, "node_modules/.bin/vite"), ["--config", path.join(here, "vite.config.mjs")], {
      cwd: here,
      env: { ...process.env, HARNESS_REPO: REPO, HARNESS_LABEL: "tf", HARNESS_PORT: String(PORT), FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const onData = (buf) => {
      log += buf.toString();
      if (log.includes(`127.0.0.1:${PORT}`)) resolve(child);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`vite exited ${code}\n${log}`)));
    setTimeout(() => reject(new Error(`vite timeout\n${log}`)), 60_000);
  });
}

mkdirSync(OUT, { recursive: true });
const server = await startVite();
const browser = await chromium.launch();
try {
  for (const shot of SHOTS) {
    const locale = shot.locale ?? "en-US";
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: "dark", reducedMotion: "reduce", locale, timezoneId: "UTC" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.addInitScript({ path: path.join(here, "modus-shared-mock.js") });
    await page.addInitScript(({ state, locale }) => {
      const app = window.modus.app;
      const never = () => new Promise(() => undefined);
      app.appearance = { initial: null, get: never, set: never, onChange: () => () => undefined };
      app.isNativeGlassAvailable ??= () => false;
      app.onNativeGlassChange ??= () => () => undefined;
      window.modus.permission.getAskMissingTarget = async () => true;
      window.modus.permission.setAskMissingTarget = async (v) => v;
      app.toolFilter = {
        get: async () => state,
        enable: async () => state,
        disable: async () => state,
        cancelDownload: async () => state,
        onChange: () => () => undefined,
      };
      if (locale !== "en-US") {
        const lang = { preference: "pt-BR", language: "pt-BR", intlLocale: "pt-BR", systemLocales: ["pt-BR"] };
        app.uiLanguage = { initial: lang, get: async () => lang, set: async () => lang, onChange: () => () => undefined };
      }
    }, { state: shot.state, locale });
    await page.goto(`http://127.0.0.1:${PORT}/?section=general`, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
    await page.waitForSelector("main h2");
    if (locale !== "en-US") {
      await page.evaluate(() => document.documentElement.setAttribute("lang", "pt-BR"));
      await page.waitForTimeout(300);
    }
    const row = page.locator("section", { has: page.locator("h3", { hasText: /Local tool filter|Filtro local/ }) });
    await row.scrollIntoViewIfNeeded();
    if (shot.click) await row.getByRole("switch").click();
    await page.mouse.move(1279, 799);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, shot.file) });
    console.log(shot.file, errors.length ? errors : "ok");
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
}
