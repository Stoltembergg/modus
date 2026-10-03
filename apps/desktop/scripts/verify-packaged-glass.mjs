#!/usr/bin/env node
/**
 * D2 packaged-glass check. Runs against the electron-vite build output (`out/`,
 * the same tree that lands in app.asar) so a regression that only shows up in
 * the packaged app is caught before anyone installs it.
 *
 *  1. Main bundle (static): macOS windows are created transparent, with
 *     `vibrancy: "sidebar"` and a #00000000 background, the controller calls
 *     `setVibrancy("sidebar")`, and `prefersReducedTransparency` only blocks
 *     glass when it is literally `true`.
 *  2. Renderer (headless Chrome): the BUILT index.html (its inline first-frame
 *     script and styles) plus the BUILT CSS, with a stubbed preload and the real
 *     app DOM chain (html > body > #root > .app-shell > fade wrapper >
 *     .app-layout-row > rail / sidebar / main). With glass on, <html> and every
 *     shell ancestor must be transparent and the rail + sidebar must let the
 *     window material through; with glass off everything must be opaque.
 *
 * Usage: node scripts/verify-packaged-glass.mjs [outDir]   (default: ./out)
 * Exit code 1 lists every failure. Chrome: $CHROME_PATH, google-chrome,
 * google-chrome-stable, chromium, or the default macOS / Windows install.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Absolute installs on the GitHub macOS / Windows runners. */
const INSTALLED_CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const onPath = ["google-chrome", "google-chrome-stable", "chromium"].find(
    (bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0,
  );
  return onPath ?? INSTALLED_CHROME.find((bin) => existsSync(bin));
}

/** Static checks over out/main/index.js and out/preload/index.cjs. */
export function checkMainBundle(outDir) {
  const failures = [];
  const main = readFileSync(join(outDir, "main/index.js"), "utf8");
  const preload = readFileSync(join(outDir, "preload/index.cjs"), "utf8");
  const expect = (ok, message) => {
    if (!ok) failures.push(`main: ${message}`);
  };

  expect(
    /platform === "darwin"\) return \{ chrome: "macos", glass: "native" \}/.test(main),
    'resolveWindowAppearance must give macOS { chrome: "macos", glass: "native" }',
  );
  const options = main.match(/function windowChromeOptionsFor\([\s\S]*?\n\}/)?.[0] ?? "";
  const mac = options.match(/chrome === "macos"\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  expect(mac !== "", "windowChromeOptionsFor has no macOS branch");
  expect(/vibrancy: "sidebar"/.test(mac), 'macOS window options lack vibrancy: "sidebar"');
  expect(
    /transparent: \w+\.glass === "native"/.test(mac),
    "macOS window is not transparent with glass",
  );
  expect(
    /backgroundColor: \w+\.glass === "native" \? "#00000000"/.test(mac),
    "macOS window background is not #00000000 with glass",
  );
  expect(
    /\.setVibrancy\(glass \? "sidebar" : null\)/.test(main),
    'controller never calls setVibrancy("sidebar")',
  );
  expect(
    /prefersReducedTransparency === true/.test(main),
    "prefersReducedTransparency must only block glass when it is true (undefined = not reduced)",
  );
  expect(/--modus-appearance=/.test(preload), "preload does not read the first-paint argument");

  // The material must be a value this Electron accepts.
  try {
    const require = createRequire(join(resolve(outDir), "../package.json"));
    const dts = readFileSync(
      join(require.resolve("electron/package.json"), "../electron.d.ts"),
      "utf8",
    );
    const union = dts.match(/vibrancy\?: \(([^)]*)\)/)?.[1] ?? "";
    expect(
      union.includes("'sidebar'"),
      `"sidebar" is not a vibrancy value of this Electron (${union})`,
    );
  } catch {
    // electron types unavailable (e.g. extracted asar elsewhere): skip this check.
  }
  return failures;
}

const SCENE = `<div class="app-shell app-root flex h-screen min-h-0 flex-col" data-shell-layer="app-shell">
<div class="flex min-h-0 min-w-0 flex-1 flex-col">
<div class="app-layout-row surface-app flex min-h-0 min-w-0 flex-1">
<nav class="app-rail" data-probe="rail"></nav>
<aside class="app-context-sidebar relative flex shrink-0 flex-col overflow-hidden bg-panel" data-probe="sidebar"><div class="app-context-sidebar-body flex h-full flex-col bg-panel"></div></aside>
<main class="surface-main relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-b-lg border border-hairline-strong border-t-0" data-probe="main"></main>
</div></div></div>`;

/** Runs in the page: alpha of each probe and of it composited over every ancestor. */
const MEASURE = `(() => {
  const alphaOf = (color) => {
    const slash = color.match(/\\/\\s*([\\d.]+%?)\\s*\\)$/);
    if (slash) return slash[1].endsWith("%") ? parseFloat(slash[1]) / 100 : Number(slash[1]);
    const rgba = color.match(/^rgba\\([^)]*,\\s*([\\d.]+)\\)$/);
    if (rgba) return Number(rgba[1]);
    return color === "transparent" ? 0 : 1;
  };
  const effective = (el) => {
    let through = 1;
    for (let n = el; n; n = n.parentElement) through *= 1 - alphaOf(getComputedStyle(n).backgroundColor);
    return 1 - through;
  };
  const q = (s) => document.querySelector(s);
  return JSON.stringify({
    nativeGlass: document.documentElement.dataset.nativeGlass,
    stylesheets: document.styleSheets.length,
    html: alphaOf(getComputedStyle(document.documentElement).backgroundColor),
    body: alphaOf(getComputedStyle(document.body).backgroundColor),
    root: alphaOf(getComputedStyle(q("#root")).backgroundColor),
    shell: alphaOf(getComputedStyle(q(".app-shell")).backgroundColor),
    rail: effective(q('[data-probe="rail"]')),
    sidebar: effective(q('[data-probe="sidebar"]')),
    main: effective(q('[data-probe="main"]')),
  });
})()`;

/**
 * `os` pins the accessibility media queries Chrome would otherwise read from
 * the host. The GitHub macOS runner reports Reduce transparency / more contrast,
 * which (correctly) turns the CSS solid fallback on; glass scenarios must
 * measure a desktop with those settings off, and the `os` scenarios prove the
 * fallback itself.
 */
export const SCENARIOS = [
  { theme: "dark", glass: true, mode: "sidebar" },
  { theme: "dark-plus", glass: true, mode: "sidebar" },
  { theme: "light", glass: true, mode: "sidebar" },
  { theme: "dark", glass: true, mode: "full" },
  { theme: "dark", glass: false, mode: "off" },
  { theme: "light", glass: false, mode: "off" },
  { theme: "dark", glass: true, mode: "sidebar", os: "reduced-transparency" },
  { theme: "dark", glass: true, mode: "full", os: "more-contrast" },
  { theme: "light", glass: true, mode: "full", os: "forced-colors" },
];

/** CDP media features for a scenario: everything off unless `os` turns one on. */
export function mediaFor(os) {
  return [
    {
      name: "prefers-reduced-transparency",
      value: os === "reduced-transparency" ? "reduce" : "no-preference",
    },
    { name: "prefers-contrast", value: os === "more-contrast" ? "more" : "no-preference" },
    { name: "forced-colors", value: os === "forced-colors" ? "active" : "none" },
  ];
}

/** What the host OS reports before any emulation (logged for diagnosis). */
const HOST_MEDIA = `JSON.stringify({
  reducedTransparency: matchMedia("(prefers-reduced-transparency: reduce)").matches,
  moreContrast: matchMedia("(prefers-contrast: more)").matches,
  forcedColors: matchMedia("(forced-colors: active)").matches,
  colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  backdropFilter: CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)"),
})`;

function pageFor(indexHtml, { theme, glass, mode }) {
  const initial = { glass, glassMode: glass ? mode : "off", transparency: mode, theme };
  const stub = `<script>
localStorage.setItem("modus.theme", ${JSON.stringify(theme)});
window.modus = { app: { platform: "darwin", windowChrome: "macos", nativeGlass: true,
  isNativeGlassAvailable: () => ${glass}, onNativeGlassChange: () => () => {},
  appearance: { initial: ${JSON.stringify(initial)} } } };
</script>`;
  return indexHtml
    .replace(/<script type="module"[^>]*><\/script>/g, "") // the app itself needs the real preload
    .replace(/ crossorigin/g, "") // file:// has no CORS; Electron loads it privileged
    .replace(/<head>/, `<head>${stub}`)
    .replace(/<div id="root">[\s\S]*?<\/div>\s*<\/body>/, `<div id="root">${SCENE}</div></body>`);
}

/** Loads each scenario page in headless Chrome over CDP and returns the measurements. */
export async function measureScenarios(
  rendererDir,
  chrome,
  scenarios = SCENARIOS,
  { pinMedia = true } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "modus-packaged-glass-"));
  const site = join(dir, "renderer");
  cpSync(rendererDir, site, { recursive: true });
  const indexHtml = readFileSync(join(site, "index.html"), "utf8");
  const browser = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--allow-file-access-from-files",
      `--user-data-dir=${join(dir, "profile")}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    const endpoint = await new Promise((resolveEndpoint, reject) => {
      let log = "";
      browser.stderr.on("data", (chunk) => {
        log += chunk.toString();
        const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) resolveEndpoint(match[1]);
      });
      browser.once("exit", () => reject(new Error(`Chrome exited: ${log}`)));
    });
    const targets = await (
      await fetch(endpoint.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "/json/list"))
    ).json();
    const socket = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((ok) => socket.addEventListener("open", ok));
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    const send = (method, params = {}) =>
      new Promise((ok) => {
        nextId += 1;
        pending.set(nextId, ok);
        socket.send(JSON.stringify({ id: nextId, method, params }));
      });
    const evaluate = async (expression) =>
      (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;

    await send("Page.enable");
    const host = JSON.parse(await evaluate(HOST_MEDIA));
    const results = [];
    for (const [index, scenario] of scenarios.entries()) {
      const file = join(site, `glass-probe-${index}.html`);
      writeFileSync(file, pageFor(indexHtml, scenario));
      if (pinMedia) await send("Emulation.setEmulatedMedia", { features: mediaFor(scenario.os) });
      await send("Page.navigate", { url: pathToFileURL(file).href });
      for (let tries = 0; tries < 100; tries += 1) {
        if ((await evaluate('document.readyState === "complete"')) === true) break;
        await new Promise((ok) => setTimeout(ok, 50));
      }
      results.push({ scenario, measured: JSON.parse(await evaluate(MEASURE)) });
    }
    void send("Browser.close");
    socket.close();
    return { host, results };
  } finally {
    const timer = setTimeout(() => browser.kill("SIGKILL"), 5_000);
    if (browser.exitCode === null) await new Promise((ok) => browser.once("exit", ok));
    clearTimeout(timer);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A late Chrome helper may still hold the profile; the OS cleans tmp.
    }
  }
}

export function renderFailures(results) {
  const failures = [];
  for (const { scenario, measured: m } of results) {
    const tag = `renderer ${scenario.theme}/${scenario.mode}/glass=${scenario.glass}${scenario.os ? `/os=${scenario.os}` : ""}`;
    const expect = (ok, message) => {
      if (!ok) failures.push(`${tag}: ${message}`);
    };
    expect(m.stylesheets > 0, "built CSS did not load");
    expect(
      m.nativeGlass === String(scenario.glass),
      `first frame set data-native-glass="${m.nativeGlass}"`,
    );
    if (scenario.os) {
      // OS accessibility wins in CSS too: solid even with native glass on.
      for (const layer of ["rail", "sidebar", "main"]) {
        expect(m[layer] === 1, `${layer} not opaque under ${scenario.os} (${m[layer]})`);
      }
    } else if (scenario.glass) {
      for (const layer of ["html", "body", "root", "shell"]) {
        expect(m[layer] === 0, `<${layer}> background alpha ${m[layer]} hides the window material`);
      }
      expect(m.rail < 1, `rail is opaque (effective alpha ${m.rail})`);
      expect(m.sidebar < 1, `sidebar is opaque (effective alpha ${m.sidebar})`);
      if (scenario.mode === "sidebar")
        expect(m.main === 1, `main not opaque in Sidebar (${m.main})`);
      if (scenario.mode === "full") expect(m.main < 1, `main opaque in Full (${m.main})`);
    } else {
      for (const layer of ["rail", "sidebar", "main"]) {
        expect(m[layer] === 1, `${layer} not opaque with glass off (${m[layer]})`);
      }
    }
  }
  return failures;
}

export async function verifyPackagedGlass(outDir, { chrome = findChrome() } = {}) {
  const failures = checkMainBundle(outDir);
  if (!chrome)
    return { failures: [...failures, "renderer: no Chrome found"], results: [], host: null };
  const { host, results } = await measureScenarios(join(outDir, "renderer"), chrome);
  return { failures: [...failures, ...renderFailures(results)], results, host };
}

const sameFile = (a, b) =>
  process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
if (process.argv[1] && sameFile(fileURLToPath(import.meta.url), process.argv[1])) {
  const outDir = resolve(process.argv[2] ?? "out");
  if (!existsSync(join(outDir, "main/index.js"))) {
    console.error(`No electron-vite build at ${outDir}`);
    process.exit(2);
  }
  const { failures, results, host } = await verifyPackagedGlass(outDir);
  console.log(`host media (before emulation): ${JSON.stringify(host)}`);
  for (const { scenario, measured } of results)
    console.log(JSON.stringify({ ...scenario, ...measured }));
  if (failures.length > 0) {
    console.error(`\nPackaged glass check FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("Packaged glass check passed.");
}
