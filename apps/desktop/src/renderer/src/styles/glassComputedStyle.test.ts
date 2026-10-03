import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * D2 transparency modes, measured with real computed styles: app.css is built
 * the way `electron-vite build` does (Tailwind compile + Lightning CSS
 * optimize) and loaded into headless Chrome over CDP. CI (ubuntu-latest) ships
 * Google Chrome; without a browser the suite fails on CI and skips locally.
 *
 * "Effective alpha" = the element composited over every ancestor up to <html>,
 * i.e. how much of the window material (vibrancy / Mica) can show through it.
 */
const CHROME = [process.env.CHROME_PATH, "google-chrome", "google-chrome-stable", "chromium"]
  .filter((bin): bin is string => Boolean(bin))
  .find((bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0);
if (!CHROME && process.env.CI) throw new Error("D2 computed-style test needs Chrome on CI");

const SCENE = `
<div id="root"><div class="app-shell"><div class="app-layout-row surface-app">
  <nav class="app-rail"></nav>
  <aside class="app-context-sidebar bg-panel"><div class="app-context-sidebar-body bg-panel"></div></aside>
  <main class="surface-main">
    <div class="surface-raised"></div>
    <div class="popup-chrome"></div>
    <div class="pdf-page-chrome"></div>
    <div class="dialog-scrim"></div>
  </main>
</div></div></div>`;
const CHROME_PARTS = [".app-rail", ".app-context-sidebar"];
const CONTENT = [".surface-main", ".surface-raised", ".popup-chrome", ".pdf-page-chrome"];
const BLURRED = [...CHROME_PARTS, ".surface-raised", ".popup-chrome", ".pdf-page-chrome"];
const THEMES = ["dark", "dark-plus", "light"] as const;

type Measured = Record<string, { alpha: number; effective: number; backdrop: string }>;

/** Runs in the page: set the root attributes, read every probe's computed style. */
const MEASURE = `(${(selectors: string[]) => {
  const alphaOf = (color: string): number => {
    const slash = color.match(/\/\s*([\d.]+%?)\s*\)$/);
    if (slash?.[1])
      return slash[1].endsWith("%") ? Number.parseFloat(slash[1]) / 100 : Number(slash[1]);
    const rgba = color.match(/^rgba\([^)]*,\s*([\d.]+)\)$/);
    if (rgba?.[1]) return Number(rgba[1]);
    return color === "transparent" ? 0 : 1;
  };
  const out: Record<string, unknown> = {};
  for (const selector of selectors) {
    const element = document.querySelector(selector) as Element;
    let through = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      through *= 1 - alphaOf(getComputedStyle(node).backgroundColor);
    }
    const style = getComputedStyle(element);
    out[selector] = {
      alpha: alphaOf(style.backgroundColor),
      effective: 1 - through,
      // Chrome aliases -webkit-backdrop-filter to this; test (e) in glassTokens
      // checks the build emits both declarations.
      backdrop: style.getPropertyValue("backdrop-filter"),
    };
  }
  return JSON.stringify(out);
}})`;

describe.skipIf(!CHROME)("D2 transparency modes in real computed styles (headless Chrome)", () => {
  const dir = mkdtempSync(join(tmpdir(), "modus-d2-glass-"));
  let browser: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  let nextId = 0;
  type Response = { result?: { result?: { value?: string } } };
  const pending = new Map<number, (value: Response) => void>();
  const send = (method: string, params: object = {}) =>
    new Promise<Response>((resolve) => {
      nextId += 1;
      pending.set(nextId, resolve);
      socket?.send(JSON.stringify({ id: nextId, method, params }));
    });

  async function measure(
    theme: string,
    glass: boolean,
    transparency: "full" | "sidebar" | "off",
    reducedTransparency = false,
  ): Promise<Measured> {
    await send("Emulation.setEmulatedMedia", {
      features: [
        {
          name: "prefers-reduced-transparency",
          value: reducedTransparency ? "reduce" : "no-preference",
        },
      ],
    });
    const root = `Object.assign(document.documentElement.dataset, ${JSON.stringify({
      theme,
      nativeGlass: String(glass),
      transparency,
    })});`;
    const response = await send("Runtime.evaluate", {
      expression: `${root} ${MEASURE}(${JSON.stringify([...CHROME_PARTS, ...CONTENT, "html"])})`,
      returnByValue: true,
    });
    return JSON.parse(response.result?.result?.value ?? "{}") as Measured;
  }

  beforeAll(async () => {
    const cssPath = fileURLToPath(new URL("./app.css", import.meta.url));
    const compiler = await compile(readFileSync(cssPath, "utf8"), {
      base: dirname(cssPath),
      onDependency: () => undefined,
    });
    const css = optimize(compiler.build(["bg-panel"]), { minify: true }).code;
    const page = join(dir, "index.html");
    writeFileSync(
      page,
      `<!doctype html><html><head><style>${css}</style></head><body>${SCENE}</body></html>`,
    );

    browser = spawn(
      CHROME as string,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${join(dir, "profile")}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const endpoint = await new Promise<string>((resolve, reject) => {
      let log = "";
      browser?.stderr?.on("data", (chunk: Buffer) => {
        log += chunk.toString();
        const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match?.[1]) resolve(match[1]);
      });
      browser?.once("exit", () => reject(new Error(`Chrome exited: ${log}`)));
    });
    const version = await (
      await fetch(endpoint.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "/json/list"))
    ).json();
    const target = (version as { type: string; webSocketDebuggerUrl: string }[]).find(
      (t) => t.type === "page",
    );
    socket = new WebSocket(target?.webSocketDebuggerUrl ?? "");
    await new Promise((resolve) => socket?.addEventListener("open", resolve));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    await send("Page.enable");
    await send("Page.navigate", { url: pathToFileURL(page).href });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 30_000);

  afterAll(async () => {
    if (browser && browser.exitCode === null) {
      const exited = new Promise((resolve) => browser?.once("exit", resolve));
      // Browser.close shuts every Chrome child down before the main process exits.
      void send("Browser.close");
      const timer = setTimeout(() => browser?.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
    }
    socket?.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A late Chrome helper may still hold the temp profile; the OS cleans tmp.
    }
  }, 15_000);

  it("Sidebar: rail + sidebar translucent with CSS blur; canvas and every other surface opaque", async () => {
    for (const theme of THEMES) {
      const m = await measure(theme, true, "sidebar");
      // Regression: <html> used to paint the canvas over the whole window material.
      expect(m.html?.alpha, `${theme} html`).toBe(0);
      for (const part of CHROME_PARTS) {
        expect(m[part]?.alpha, `${theme} ${part}`).toBeLessThan(1);
        expect(m[part]?.effective, `${theme} ${part}`).toBeLessThan(1);
        expect(m[part]?.backdrop, `${theme} ${part}`).toMatch(/blur\(/);
      }
      for (const part of CONTENT) {
        expect(m[part]?.alpha, `${theme} ${part}`).toBe(1);
        expect(m[part]?.effective, `${theme} ${part}`).toBe(1);
        expect(m[part]?.backdrop, `${theme} ${part}`).toBe("none");
      }
    }
  });

  it("Full: rail, sidebar, canvas and overlays translucent; chrome and overlays blurred", async () => {
    for (const theme of THEMES) {
      const m = await measure(theme, true, "full");
      for (const part of [...CHROME_PARTS, ...CONTENT]) {
        expect(m[part]?.effective, `${theme} ${part}`).toBeLessThan(1);
      }
      for (const part of BLURRED) {
        expect(m[part]?.backdrop, `${theme} ${part}`).toMatch(/blur\(/);
      }
      expect(m[".surface-main"]?.backdrop, `${theme} canvas`).toBe("none");
    }
  });

  it("Off (also what OS accessibility resolves to): everything opaque, no CSS blur", async () => {
    for (const theme of THEMES) {
      for (const transparency of ["off", "full", "sidebar"] as const) {
        // data-native-glass="false" is what main sends for Off and for any OS block.
        const m = await measure(theme, false, transparency);
        for (const part of [...CHROME_PARTS, ...CONTENT]) {
          expect(m[part]?.effective, `${theme} ${transparency} ${part}`).toBe(1);
          expect(m[part]?.backdrop, `${theme} ${transparency} ${part}`).toBe("none");
        }
      }
    }
  });

  it("CSS second line of defence: reduced transparency makes Full/Sidebar opaque even with glass on", async () => {
    for (const theme of THEMES) {
      for (const transparency of ["full", "sidebar"] as const) {
        const m = await measure(theme, true, transparency, true);
        for (const part of [...CHROME_PARTS, ...CONTENT]) {
          expect(m[part]?.effective, `${theme} ${transparency} ${part}`).toBe(1);
          expect(m[part]?.backdrop, `${theme} ${transparency} ${part}`).toBe("none");
        }
      }
    }
  });
});
