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
  <nav class="app-rail"><button class="app-rail-item" type="button">A</button></nav>
  <aside class="app-context-sidebar bg-panel"><div class="app-context-sidebar-body bg-panel"></div></aside>
  <main class="surface-main rounded-b-lg border border-hairline-strong border-t-0">
    <div class="surface-raised"></div>
    <div class="popup-chrome"></div>
    <div class="pdf-page-chrome"></div>
    <div class="dialog-scrim"></div>
  </main>
</div></div></div>`;
const CANDIDATES = ["bg-panel", "rounded-b-lg", "border", "border-hairline-strong", "border-t-0"];
const PANELS = [".app-rail", ".app-context-sidebar", ".surface-main"];
const CHROME_PARTS = [".app-rail", ".app-context-sidebar"];
const OVERLAYS = [".surface-raised", ".popup-chrome", ".pdf-page-chrome"];
const THEMES = ["dark", "dark-plus", "light"] as const;
const OS = ["reduced-transparency", "more-contrast", "forced-colors"] as const;
type Os = (typeof OS)[number] | undefined;

type Probe = { alpha: number; effective: number; backdrop: string };
type Edge = { alpha: number; width: number };
type Measured = Record<string, Probe> & {
  edges: { railDivider: Edge; mainLeft: Edge; mainRight: Edge; mainBottom: Edge };
  focus: { style: string; width: number; alpha: number };
};

/** Runs in the page: computed backgrounds, panel-edge borders and the focus ring. */
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
      // Chrome aliases -webkit-backdrop-filter to this; glassTokens (e) checks
      // the build emits both declarations.
      backdrop: style.getPropertyValue("backdrop-filter"),
    };
  }
  const edge = (style: CSSStyleDeclaration, side: string) => ({
    alpha: alphaOf(style.getPropertyValue(`border-${side}-color`)),
    width: Number.parseFloat(style.getPropertyValue(`border-${side}-width`)),
  });
  const main = getComputedStyle(document.querySelector(".surface-main") as Element);
  out.edges = {
    railDivider: edge(
      getComputedStyle(document.querySelector(".app-rail") as Element, "::after"),
      "right",
    ),
    mainLeft: edge(main, "left"),
    mainRight: edge(main, "right"),
    mainBottom: edge(main, "bottom"),
  };
  const button = document.querySelector(".app-rail-item") as HTMLElement;
  button.focus({ focusVisible: true } as FocusOptions);
  const ring = getComputedStyle(button);
  out.focus = {
    style: ring.outlineStyle,
    width: Number.parseFloat(ring.outlineWidth),
    alpha: alphaOf(ring.outlineColor),
  };
  button.blur();
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
    os?: Os,
  ): Promise<Measured> {
    // Pin every accessibility feature (the host's own settings must not leak in).
    await send("Emulation.setEmulatedMedia", {
      features: [
        {
          name: "prefers-reduced-transparency",
          value: os === "reduced-transparency" ? "reduce" : "no-preference",
        },
        { name: "prefers-contrast", value: os === "more-contrast" ? "more" : "no-preference" },
        { name: "forced-colors", value: os === "forced-colors" ? "active" : "none" },
      ],
    });
    const root = `Object.assign(document.documentElement.dataset, ${JSON.stringify({
      theme,
      nativeGlass: String(glass),
      transparency,
    })});`;
    const response = await send("Runtime.evaluate", {
      expression: `${root} ${MEASURE}(${JSON.stringify([...PANELS, ...OVERLAYS, ".app-shell", "html"])})`,
      returnByValue: true,
    });
    return JSON.parse(response.result?.result?.value ?? "{}") as Measured;
  }

  /** The panel-edge dividers and the focus ring as they are without glass. */
  function expectTodaysEdges(m: Measured, at: string): void {
    for (const [name, edge] of Object.entries(m.edges)) {
      expect(edge.alpha, `${at} ${name} colour`).toBeGreaterThan(0);
      expect(edge.width, `${at} ${name} width`).toBeGreaterThan(0);
    }
  }
  function expectFocusRing(m: Measured, at: string): void {
    expect(m.focus.style, `${at} focus ring`).not.toBe("none");
    expect(m.focus.width, `${at} focus ring width`).toBeGreaterThan(0);
    expect(m.focus.alpha, `${at} focus ring colour`).toBeGreaterThan(0);
  }

  beforeAll(async () => {
    const cssPath = fileURLToPath(new URL("./app.css", import.meta.url));
    const compiler = await compile(readFileSync(cssPath, "utf8"), {
      base: dirname(cssPath),
      onDependency: () => undefined,
    });
    const css = optimize(compiler.build(CANDIDATES), { minify: true }).code;
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
    // Headless pages are never focused; focus-visible needs a focused page.
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
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

  it("Sidebar: one window tint behind rail + sidebar; main opaque without the sidebar|main line", async () => {
    for (const theme of THEMES) {
      const m = await measure(theme, true, "sidebar");
      // Regression: <html> used to paint the canvas over the whole window material.
      expect(m.html?.alpha, `${theme} html`).toBe(0);
      expect(m[".app-shell"]?.alpha, `${theme} window tint`).toBeCloseTo(0.78, 2);
      expect(m[".app-shell"]?.backdrop, `${theme} window blur`).toMatch(/blur\(/);
      for (const part of CHROME_PARTS) {
        expect(m[part]?.alpha, `${theme} ${part} own background`).toBe(0);
        expect(m[part]?.effective, `${theme} ${part}`).toBeCloseTo(0.78, 2);
        expect(m[part]?.backdrop, `${theme} ${part} blur`).toBe("none");
      }
      expect(m[".surface-main"]?.effective, `${theme} main`).toBe(1);
      expect(m[".surface-main"]?.backdrop, `${theme} main blur`).toBe("none");
      for (const part of OVERLAYS) {
        expect(m[part]?.effective, `${theme} ${part}`).toBe(1);
        expect(m[part]?.backdrop, `${theme} ${part}`).toBe("none");
      }
      expect(m.edges.railDivider.alpha, `${theme} rail|sidebar divider`).toBe(0);
      expect(m.edges.mainLeft.alpha, `${theme} sidebar|main line`).toBe(0);
      // Main keeps its other edges in Sidebar mode.
      expect(m.edges.mainRight.alpha, `${theme} main right edge`).toBeGreaterThan(0);
      expectFocusRing(m, `${theme} sidebar`);
    }
  });

  it("Full: rail, sidebar and main share one alpha on one blurred layer; no dividers", async () => {
    for (const theme of THEMES) {
      const m = await measure(theme, true, "full");
      expect(m[".app-shell"]?.backdrop, `${theme} window blur`).toMatch(/blur\(/);
      const effective = PANELS.map((part) => m[part]?.effective);
      expect(new Set(effective).size, `${theme} equal alpha ${effective}`).toBe(1);
      expect(effective[0], `${theme} shared alpha`).toBeCloseTo(0.78, 2);
      for (const part of PANELS) {
        expect(m[part]?.alpha, `${theme} ${part} own background`).toBe(0);
        expect(m[part]?.backdrop, `${theme} ${part} blur`).toBe("none");
      }
      for (const part of OVERLAYS) {
        expect(m[part]?.effective, `${theme} ${part}`).toBeLessThan(1);
        expect(m[part]?.backdrop, `${theme} ${part}`).toMatch(/blur\(/);
      }
      for (const [name, edge] of Object.entries(m.edges)) {
        expect(edge.alpha, `${theme} ${name} divider`).toBe(0);
      }
      expectFocusRing(m, `${theme} full`);
    }
  });

  it("Off (also what main resolves OS accessibility to): opaque, today's dividers, no CSS blur", async () => {
    for (const theme of THEMES) {
      for (const transparency of ["off", "full", "sidebar"] as const) {
        // data-native-glass="false" is what main sends for Off and for any OS block.
        const m = await measure(theme, false, transparency);
        for (const part of [...PANELS, ...OVERLAYS]) {
          expect(m[part]?.effective, `${theme} ${transparency} ${part}`).toBe(1);
          expect(m[part]?.backdrop, `${theme} ${transparency} ${part}`).toBe("none");
        }
        expect(m[".app-shell"]?.backdrop).toBe("none");
        expectTodaysEdges(m, `${theme} ${transparency}`);
        expectFocusRing(m, `${theme} ${transparency}`);
      }
    }
  });

  it("CSS second line of defence: reduce transparency / more contrast / forced colors keep today's solid look", async () => {
    for (const theme of THEMES) {
      for (const transparency of ["full", "sidebar"] as const) {
        for (const os of OS) {
          const m = await measure(theme, true, transparency, os);
          const at = `${theme} ${transparency} ${os}`;
          for (const part of [...PANELS, ...OVERLAYS]) {
            expect(m[part]?.effective, `${at} ${part}`).toBe(1);
            expect(m[part]?.backdrop, `${at} ${part}`).toBe("none");
          }
          expect(m[".app-shell"]?.backdrop, `${at} window blur`).toBe("none");
          expectTodaysEdges(m, at);
          expectFocusRing(m, at);
        }
      }
    }
  });
});
